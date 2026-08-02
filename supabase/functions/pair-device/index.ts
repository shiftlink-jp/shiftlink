// pair-device: 店舗コードを受け取り、この端末専用のトークンを発行する。
//
// 目的（設計書 docs/security-device-pairing-design.md）:
//   ログイン窓口(pin-login / list-store-casts)を「登録済み端末だけ」に限定するための入口。
//   発行されたトークンから店舗が特定できるため、以降クライアントは store_id を送らなくてよくなる。
//   ＝第三者が任意の店舗のログイン窓口を叩く経路が消える。
//
// セキュリティ:
//   ・コードは平文を保存せず sha256 で照合（DB流出時にコードを再利用されない）
//   ・48時間で失効・1回使い切り（Square のデバイスコードと同方針）
//   ・トークンも sha256 のみ保存。生トークンはこの応答でしか返らない
//   ・総当たり対策: 失敗を pin_login_attempts に記録し、閾値超過でロック
//
// デプロイ: supabase functions deploy pair-device
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const MAX_FAILS = 10;      // 店舗コードの誤入力許容回数
const MAX_DEVICES_PER_STORE = 60;  // 招待リンク経由の登録に効かせる上限（manage-devices と同値）
const MAX_DEVICES_PER_CAST = 3;    // 本人専用の招待で1人が登録できる端末数（URL漏洩時の枠食い潰し対策）
const LOCK_MINUTES = 30;

// pin_login_attempts.store_id は NOT NULL（010）。店舗横断のカウンタ用に番兵UUIDを使う。
// （NULLを入れるとNOT NULL違反で記録に失敗し、レート制限が無言で無効化される）
const SENTINEL_STORE = "00000000-0000-0000-0000-000000000000";

// 緊急復旧用コード（任意）。オーナーが端末トークンを失うと管理画面にも入れず
// コードを発行できなくなる（詰み）ため、オフライン保管の固定コードを1本だけ許容する。
// Supabaseのシークレットに BOOTSTRAP_PAIRING_CODE / BOOTSTRAP_STORE_ID を設定して使う。
// 未設定なら無効（既定は無効＝余計な入口を作らない）。
const BOOTSTRAP_CODE = (Deno.env.get("BOOTSTRAP_PAIRING_CODE") ?? "").trim().toUpperCase();
const BOOTSTRAP_STORE_ID = (Deno.env.get("BOOTSTRAP_STORE_ID") ?? "").trim();

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];
const VERCEL_PREVIEW_RE = /^https:\/\/kyoukano-[a-z0-9-]+-sawaki-nagoyas-projects\.vercel\.app$/;

function cors(origin: string | null) {
  const ok = origin && (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin));
  return {
    "Access-Control-Allow-Origin": ok ? origin! : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}
function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status, headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 生トークン（32バイト＝推測不可能）
function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const { code, label } = await req.json();
    const codeStr = String(code ?? "").trim().toUpperCase();
    if (!codeStr || codeStr.length < 4 || codeStr.length > 16) {
      return json({ error: "店舗コードを入力してください" }, 400, origin);
    }

    const codeHash = await sha256Hex(codeStr);

    // 緊急復旧コードの判定はレート制限より「前」に行う。
    // 後ろに置くと、第三者が誤コードを10回撒くだけで全店の復旧口が30分塞がれてしまい、
    // 「本ログインもロック／復旧口もロック」で完全に詰む経路ができるため。
    const isBootstrap = !!(BOOTSTRAP_CODE && BOOTSTRAP_STORE_ID && codeStr === BOOTSTRAP_CODE);

    // 総当たり対策（コードは店舗横断で一意なので、失敗は共通バケットで数える）
    const lockKey = "pairing.global";
    const { data: att } = await admin
      .from("pin_login_attempts").select("fail_count,locked_until,updated_at")
      .eq("store_id", SENTINEL_STORE).eq("principal", lockKey).maybeSingle();
    // 緊急復旧コードはレート制限の対象外（上記の理由）
    if (!isBootstrap && att?.locked_until && new Date(att.locked_until) > new Date()) {
      return json({ error: "試行回数が上限に達しました。しばらくしてから再度お試しください" }, 429, origin);
    }

    // 失敗の記録はDB内で原子的に加算する（030: record_login_fail）。
    // 「読んで+1して書き戻す」だと、誤コードを同時に大量送信されたとき全リクエストが
    // 同じ値を読んで全部「1回目」になり、10回の上限に到達せずロックが無効化される。
    // 030未適用のDBでも落とさないよう、RPCが使えなければ従来方式へフォールバックする。
    const bumpFail = async () => {
      try {
        const { error } = await admin.rpc("record_login_fail", {
          p_store_id: SENTINEL_STORE, p_principal: lockKey, p_max: MAX_FAILS,
          p_lock_minutes: LOCK_MINUTES, p_window_minutes: LOCK_MINUTES,
        });
        if (!error) return;
        console.error(
          "pair-device: record_login_fail が使えないため旧方式にフォールバック",
          error.code, error.message,
        );
      } catch (e) {
        console.error(
          "pair-device: record_login_fail 呼び出しで例外のため旧方式にフォールバック",
          String((e as Error).message ?? e),
        );
      }
      // 直近の時間窓内の失敗だけ数える（生涯累積させると恒久ロックになるため）
      const age = att?.updated_at ? Date.now() - new Date(att.updated_at).getTime() : Infinity;
      const base = age < LOCK_MINUTES * 60000 ? (att?.fail_count ?? 0) : 0;
      const next = base + 1;
      const locked = next >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      const { error: upErr } = await admin.from("pin_login_attempts").upsert(
        // ロック時はカウントを0に戻す（解除後の1回で即再ロックされるのを防ぐ）
        { store_id: SENTINEL_STORE, principal: lockKey, fail_count: locked ? 0 : next, locked_until: locked, updated_at: new Date().toISOString() },
        { onConflict: "store_id,principal" },
      );
      // 記録に失敗したらレート制限が効かないため、無言で通さずログに残す
      if (upErr) console.error("pair-device: 試行記録に失敗", upErr.message);
    };
    const fail = async (msg: string, status: number) => {
      await bumpFail();
      return json({ error: msg }, status, origin);
    };

    // 緊急復旧コード（オフライン保管）。オーナーが端末を失った場合の唯一の入口。
    let targetStore: string | null = null;
    let pairingRowId: number | null = null;
    let isInvite = false;   // 招待リンク（複数人が使える）で来たか
    let boundCastId: number | null = null;  // その人専用の招待なら、登録する端末を本人に紐づける
    if (isBootstrap) {
      targetStore = BOOTSTRAP_STORE_ID;
    } else {
      // select("*") にしている理由: 029（cast_id列の追加）が未適用の環境でも動くようにするため。
      //   列名を並べる書き方だと、未適用のDBに対して「そんな列は無い」で400になり、
      //   端末登録が全滅する（過去に028で同じ罠を踏んだ）。
      const { data: pc } = await admin
        .from("store_pairing_codes")
        .select("*")
        .eq("code_hash", codeHash).maybeSingle();
      if (!pc) return await fail("店舗コードが正しくありません", 401);
      isInvite = !!pc.multi_use;
      // ★招待リンクの「失効・期限切れ」は fail() を通さない（レート制限カウンタを増やさない）。
      //   1本のリンクを全員に配る運用では、古いLINEメッセージを踏む人が必ず出る。
      //   それを総当たり扱いすると10回で全店のペアリング窓口が30分止まってしまう。
      //   コード自体は実在＝当店が発行したものなので、推測攻撃ではない。
      if (pc.revoked_at) {
        return json({ error: "この招待リンクは無効です（新しいリンクが発行されています）。オーナーに最新のリンクを確認してください" }, 401, origin);
      }
      // 招待リンクは複数人が使うため used_at は付かない（＝この判定に引っかからない）
      if (!isInvite && pc.used_at) return await fail("この店舗コードは使用済みです。オーナーに再発行を依頼してください", 401);
      if (new Date(pc.expires_at) <= new Date()) {
        if (isInvite) {
          return json({ error: "この招待リンクは有効期限が切れています。オーナーに再発行を依頼してください" }, 401, origin);
        }
        return await fail("この店舗コードは有効期限が切れています。オーナーに再発行を依頼してください", 401);
      }
      targetStore = pc.store_id;
      pairingRowId = pc.id;
      // 029未適用なら pc.cast_id は undefined ＝ null 扱い（従来どおり誰でも使えるコード）
      boundCastId = pc.cast_id != null ? Number(pc.cast_id) : null;

      // 招待リンクは何度でも使えるため、端末数の上限を必ず確認する（無制限に増えるのを防ぐ）。
      // ここは総当たり攻撃ではないので fail() は通さない（レート制限カウンタを汚さない）。
      if (isInvite) {
        const { count } = await admin
          .from("store_devices").select("id", { count: "exact", head: true })
          .eq("store_id", targetStore).is("revoked_at", null);
        if ((count ?? 0) >= MAX_DEVICES_PER_STORE) {
          return json({ error: "登録できる端末数の上限に達しました。オーナーに連絡してください" }, 409, origin);
        }
        // 本人専用の招待は「1人あたり」の上限も見る。
        // これが無いと、URLが漏れた第三者がループで登録を繰り返して店舗の上限(60台)を
        // 埋め尽くし、正規スタッフが誰も新規登録できなくなる（@テスト指摘のDoS）。
        // 1人がLINE内ブラウザとSafariで2台になるケースがあるため、余裕を見て3台。
        if (boundCastId != null) {
          const { count: mine } = await admin
            .from("store_devices").select("id", { count: "exact", head: true })
            .eq("store_id", targetStore).is("revoked_at", null).eq("bound_cast_id", boundCastId);
          if ((mine ?? 0) >= MAX_DEVICES_PER_CAST) {
            return json({ error: "この招待で登録できる端末数の上限に達しました。オーナーに連絡してください" }, 409, origin);
          }
        }
      }
    }

    // 成功 → 失敗カウントをリセットし、トークンを発行
    await admin.from("pin_login_attempts").delete()
      .eq("store_id", SENTINEL_STORE).eq("principal", lockKey);

    // セラピスト専用の招待なら、端末のラベルはその人の名前にする（オーナーの一覧で誰の端末か分かる）
    let boundName = "";
    if (boundCastId != null) {
      const { data: c } = await admin
        .from("casts").select("name").eq("id", boundCastId).eq("store_id", targetStore).maybeSingle();
      boundName = (c?.name && String(c.name).trim()) || "セラピスト";
    }

    const token = newToken();
    const tokenHash = await sha256Hex(token);
    // bound_cast_id は「値があるときだけ」入れる。
    //   029未適用のDBに対して bound_cast_id:null を明示的に送ると「そんな列は無い」で400になり、
    //   端末登録が全滅するため（列を送らなければ従来と完全に同じINSERTになる）。
    const { error: insErr } = await admin.from("store_devices").insert({
      store_id: targetStore,
      token_hash: tokenHash,
      // 本人専用の招待では、クライアントが送ってくる汎用ラベルより本人の名前を優先する
      label: boundName || (label ? String(label).slice(0, 60)
                                 : (pairingRowId ? null : "緊急復旧で登録")),
      last_seen_at: new Date().toISOString(),
      ...(boundCastId != null ? { bound_cast_id: boundCastId } : {}),
    });
    if (insErr) return json({ error: "端末の登録に失敗しました" }, 500, origin);

    // コードを使用済みにする（1回使い切り）。
    // 緊急復旧コードと招待リンクは繰り返し使えるため対象外。
    if (pairingRowId && !isInvite) {
      await admin.from("store_pairing_codes").update({ used_at: new Date().toISOString() }).eq("id", pairingRowId);
    }

    // 生トークンはここでしか返さない
    // store_id も返す: クライアントは以降の呼び出し(passkey等)で店舗を指定する必要があり、
    // これが無いと「store_id は必須です」で生体認証の登録に失敗する。
    // cast_id / cast_name: 本人専用の招待で登録したときだけ返る（画面に「〇〇さんの端末として登録しました」と出す用）
    return json({
      ok: true, device_token: token, store_id: targetStore,
      ...(boundCastId != null ? { cast_id: boundCastId, cast_name: boundName } : {}),
    }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
