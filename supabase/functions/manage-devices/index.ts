// manage-devices: オーナー専用。端末ペアリングの運用一式を扱う。
//
//   action="issue_code"  … 店舗コードを発行
//                          ・cast_id 省略 … 従来どおり誰でも使える店舗コード（48時間・1回使い切り）
//                          ・cast_id 指定 … そのセラピスト専用の招待コード（7日間・同じ人なら何度でも）
//   action="revoke_invite" … 旧「全員共通の招待リンク」を失効させる（一本化の後始末用）
//   action="list"        … 登録済み端末の一覧
//   action="revoke"      … 端末を失効（紛失・退職時）
//   action="list_pins"   … セラピストのPIN一覧（管理画面のPINバッジ表示用 ＝ ①の代替経路）
//
// なぜこの関数が必要か（設計書 docs/security-device-pairing-design.md ①）:
//   従来 casts.pin に平文PINがあり、RLSは行単位のため「ログインしたセラピストが
//   同僚全員のPINを読める」状態だった。平文を auth_pins（service_role以外アクセス不可）へ
//   移し、オーナーだけがこの関数を通して取得できるようにする。
//
// 認証: 呼び出し元のJWTを検証し、store_members で当該店舗の role='owner' を確認（set-pin と同方式）。
//
// デプロイ: supabase functions deploy manage-devices
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const CODE_TTL_HOURS = 48;          // Square のデバイスコードと同じ48時間
const CAST_INVITE_TTL_DAYS = 7;     // セラピスト個別の招待リンクの有効期限
                                    // （48時間は「その場で手渡す」前提で短すぎ、14日は長すぎるため7日）
const MAX_DEVICES_PER_STORE = 60;   // 1店舗あたりの有効な登録端末数の上限

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

// 紛らわしい文字(0/O, 1/I/L)を除いた8桁コード。口頭・手入力での誤りを減らす。
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
function newPairingCode(): string {
  const b = crypto.getRandomValues(new Uint8Array(8));
  return Array.from(b).map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    // 1) 呼び出し元のセッションを検証
    const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "認証が必要です" }, 401, origin);
    const { data: { user }, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !user) return json({ error: "認証エラー" }, 401, origin);

    const { store_id, action, device_id, label, cast_id } = await req.json();
    if (!store_id) return json({ error: "store_id は必須です" }, 400, origin);

    // 2) 当該店舗のメンバーであることを確認
    const { data: mem } = await admin
      .from("store_members").select("role")
      .eq("user_id", user.id).eq("store_id", store_id).maybeSingle();
    if (!mem) return json({ error: "権限がありません" }, 403, origin);

    // self_pair: ログイン中の本人が「自分が今使っている端末」を登録する。
    //   生体認証(パスキー)でログインする人は pin-login を通らないため自動ペアリングされず、
    //   猶予終了日に一斉に締め出されてしまう。それを防ぐための経路。
    //   すでに有効なセッションを持っている＝本人確認済みなので、店舗コードは不要。
    //   オーナー/セラピストどちらでも可（この時点でstore_membersに所属が確認できている）。
    if (action === "self_pair") {
      // 無制限に増えないよう上限を設ける（保存できない端末が毎回登録を試みるケースの歯止め）。
      // 上限に達したらオーナーが管理画面で不要な端末を解除する運用。
      const { count } = await admin
        .from("store_devices").select("id", { count: "exact", head: true })
        .eq("store_id", store_id).is("revoked_at", null);
      if ((count ?? 0) >= MAX_DEVICES_PER_STORE) {
        return json({ error: "登録できる端末数の上限に達しました。管理画面で不要な端末を解除してください" }, 409, origin);
      }
      const raw = crypto.getRandomValues(new Uint8Array(32));
      const deviceToken = Array.from(raw).map((x) => x.toString(16).padStart(2, "0")).join("");
      const { data: dev, error } = await admin.from("store_devices").insert({
        store_id,
        token_hash: await sha256Hex(deviceToken),
        // 監査のため「本人登録」であることを名前に残す（オーナーが後から識別できるように）
        label: label ? String(label).slice(0, 60)
                     : (mem.role === "owner" ? "オーナー端末(本人登録)" : "セラピスト端末(本人登録)"),
        last_seen_at: new Date().toISOString(),
      }).select("id").maybeSingle();
      if (error || !dev) return json({ error: "端末の登録に失敗しました" }, 500, origin);
      return json({ ok: true, device_token: deviceToken }, 200, origin);
    }

    // 以降はオーナー専用
    if (mem.role !== "owner") return json({ error: "権限がありません" }, 403, origin);

    // 3) 処理
    if (action === "issue_code") {
      // cast_id 指定 = そのセラピスト専用の招待。省略 = 従来どおりの店舗コード。
      const castId = cast_id != null && cast_id !== "" ? Number(cast_id) : null;
      if (castId != null && !Number.isFinite(castId)) {
        return json({ error: "セラピストの指定が不正です" }, 400, origin);
      }

      if (castId == null) {
        // ── 従来の店舗コード（48時間・1回使い切り）。オーナー自身の端末登録・例外用 ──
        const code = newPairingCode();
        const expiresAt = new Date(Date.now() + CODE_TTL_HOURS * 3600_000).toISOString();
        const { error } = await admin.from("store_pairing_codes").insert({
          store_id, code_hash: await sha256Hex(code), expires_at: expiresAt,
        });
        if (error) return json({ error: "コードの発行に失敗しました" }, 500, origin);
        // 平文コードはこの応答でしか返らない（DBにはハッシュのみ）
        return json({ ok: true, code, expires_at: expiresAt, ttl_hours: CODE_TTL_HOURS }, 200, origin);
      }

      // ── セラピスト専用の招待（7日間） ──
      // 他店のセラピストIDを指定して招待を作られないよう、自店に在籍していることを必ず確認する。
      const { data: castRow } = await admin
        .from("casts").select("id,name").eq("id", castId).eq("store_id", store_id).maybeSingle();
      if (!castRow) return json({ error: "このセラピストは見つかりません" }, 404, origin);

      // multi_use=true にする理由（1回使い切りにしない）:
      //   LINEでリンクを送ると、まずLINE内ブラウザで開かれることが多い。そこで「使用済み」に
      //   なってしまうと、本人がSafari/Chromeで開き直したときに二度と使えず詰む。
      //   コードはその人専用（cast_id付き）で、登録した端末も本人＋オーナーしかログインできないため、
      //   何度使えても被害は広がらない。
      const now = new Date().toISOString();
      // 同じ人の古い招待は失効させる（＝再発行すると前のリンクは使えなくなる）
      const { error: revErr } = await admin.from("store_pairing_codes")
        .update({ revoked_at: now })
        .eq("store_id", store_id).eq("cast_id", castId)
        .eq("multi_use", true).is("revoked_at", null);
      if (revErr) {
        // 029未適用（cast_id 列が無い）ならここで落ちる。安全側＝発行しない。
        return json({ error: "招待の発行に失敗しました（データベースの更新029が未適用の可能性があります）" }, 500, origin);
      }

      const code = newPairingCode();
      const expiresAt = new Date(Date.now() + CAST_INVITE_TTL_DAYS * 24 * 3600_000).toISOString();
      const { error } = await admin.from("store_pairing_codes").insert({
        store_id, code_hash: await sha256Hex(code), expires_at: expiresAt,
        multi_use: true, cast_id: castId, label: `招待:${String(castRow.name ?? "").slice(0, 30)}`,
      });
      if (error) {
        return json({ error: "招待の発行に失敗しました（データベースの更新029が未適用の可能性があります）" }, 500, origin);
      }
      // 平文コードはこの応答でしか返らない（DBにはハッシュのみ＝後から再表示はできない）
      return json({
        ok: true, code, expires_at: expiresAt, ttl_days: CAST_INVITE_TTL_DAYS,
        cast_id: castId, cast_name: castRow.name ?? null,
      }, 200, origin);
    }

    // revoke_invite: 旧「全員共通の招待リンク」（cast_id が無い multi_use 行）をまとめて失効させる。
    //   セラピストごとの招待へ一本化したあとの後始末用。押すまでは既存リンクは有効なままなので、
    //   移行の途中でリンクを踏む人がいても困らない。
    if (action === "revoke_invite") {
      const q = admin.from("store_pairing_codes")
        .update({ revoked_at: new Date().toISOString() })
        .eq("store_id", store_id).eq("multi_use", true).is("revoked_at", null);
      // 029適用後は cast_id が付いた個別招待まで巻き添えで消さないよう、共通リンクだけに絞る。
      // 029未適用（列が無い）ときは絞り込みでエラーになるため、その場合は絞らず全件を失効させる
      // （＝そもそも共通リンクしか存在しない状態なので結果は同じ）。
      const { error } = await q.is("cast_id", null);
      if (error) {
        const { error: e2 } = await admin.from("store_pairing_codes")
          .update({ revoked_at: new Date().toISOString() })
          .eq("store_id", store_id).eq("multi_use", true).is("revoked_at", null);
        if (e2) return json({ error: "招待リンクの失効に失敗しました" }, 500, origin);
      }
      return json({ ok: true }, 200, origin);
    }

    // ※ 旧 action="issue_invite"（全員共通の14日リンク）は廃止した。
    //   セラピストごとの招待（issue_code + cast_id）に一本化したため。
    //   既に配ってある共通リンクは有効なまま残る（pair-device 側は従来どおり受け付ける）。
    //   止めたいときは action="revoke_invite" を使う。

    if (action === "list") {
      const { data } = await admin
        .from("store_devices").select("id,label,created_at,last_seen_at,revoked_at")
        .eq("store_id", store_id).order("created_at", { ascending: false });
      return json({ ok: true, devices: data ?? [] }, 200, origin);
    }

    if (action === "revoke") {
      if (!device_id) return json({ error: "device_id は必須です" }, 400, origin);
      const { error } = await admin.from("store_devices")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", device_id).eq("store_id", store_id);   // 他店の端末は失効させられない
      if (error) return json({ error: "失効に失敗しました" }, 500, origin);
      return json({ ok: true }, 200, origin);
    }

    if (action === "rename") {
      if (!device_id) return json({ error: "device_id は必須です" }, 400, origin);
      await admin.from("store_devices")
        .update({ label: label ? String(label).slice(0, 60) : null })
        .eq("id", device_id).eq("store_id", store_id);
      return json({ ok: true }, 200, origin);
    }

    if (action === "list_pins") {
      // ①: セラピストのPINはオーナーだけがここから取得できる
      // store_id が NULL のレガシー行も拾う（011でnullable。set-pin側の更新条件と揃える）。
      // 揃えないと、NULL行のセラピストだけバッジが恒久的に「未設定」になる。
      //
      // ★重要★ NULL行は「どの店舗のものか」が判別できないため、そのまま返すと
      //   他店のPINが応答に混ざる（画面に出なくてもHTTP応答には載る＝他店データ漏洩）。
      //   自店に在籍するキャストIDでフィルタして、確実に自店ぶんだけを返す。
      const [{ data }, { data: castRows }] = await Promise.all([
        admin.from("auth_pins").select("principal,pin_plain")
          .or(`store_id.eq.${store_id},store_id.is.null`)
          .like("principal", "cast.%"),
        admin.from("casts").select("id").eq("store_id", store_id),
      ]);
      const allowed = new Set((castRows ?? []).map((c) => String(c.id)));
      const pins: Record<string, string> = {};
      for (const r of data ?? []) {
        const id = String(r.principal).split(".")[1];
        if (id && r.pin_plain && allowed.has(id)) pins[id] = String(r.pin_plain);
      }
      return json({ ok: true, pins }, 200, origin);
    }

    return json({ error: "action が不正です" }, 400, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
