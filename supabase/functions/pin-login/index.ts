// pin-login: PINをサーバ側で照合し、店舗スコープの認証セッションを発行する。
// これにより「公開anon鍵だけで全データにアクセスできる」根本問題を解消する土台になる。
// （アプリは以降このセッションで動作し、RLSで自店データのみアクセス可能になる）
//
// ブルートフォース対策: pin_login_attempts(010)で失敗回数を数え、MAX_FAILSでロックする。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_FAILS = 5;            // 端末ごとに、この回数連続で失敗するとロック
const LOCK_MINUTES = 15;        // ロック時間（分）
// 店舗全体の最終防衛線。端末が乗っ取られた場合のみ到達する高い閾値（通常運用では届かない）。
// ※026以前の「店舗共有ロック(5回)」は、1人の打ち間違いで全員が締め出される原因だったため廃止。
const STORE_MAX_FAILS = 50;
const STORE_LOCK_MINUTES = 60;
// 未登録端末（＝猶予期間中のみ到達しうる）専用のバックストップ。
// 登録済み端末のカウンタと分けるのが要点:
//   ・分けないと、移行中は誰でも到達できる50回/60分が総当たりの上限になり、
//     4桁PIN×在籍12名では1日以内に突破されうる（在籍者の誰か1人でも当たれば成功のため）
//   ・かつ、その50回を攻撃者に食われると登録済みの正規端末まで巻き添えでロックされる
const ANON_MAX_FAILS = 10;

// 自動ペアリング猶予期間。この日時までは端末トークンが無くてもPINログインを許可し、
// 成功時に自動で端末トークンを発行する（既存端末が一斉に締め出される事故を防ぐため）。
// 期間中もPIN照合の成功が条件なので、無関係な第三者は登録できない。
//
// ★fail-open設計★ 環境変数が未設定・書式不正でも「猶予ON」に倒す。
//   ここをfail-closed（未設定なら即トークン必須）にすると、Secret設定を1つ忘れた瞬間や
//   タイポ（全角・スラッシュ区切り等でInvalid Date）で全店が即ログイン不能になるため。
//   移行完了後は下の DEFAULT_GRACE_UNTIL を過去日に書き換えて締める（＝コードで明示的に締める）。
const DEFAULT_GRACE_UNTIL = "2026-08-11T00:00:00+09:00";
function graceDeadline(): number {
  const raw = (Deno.env.get("PAIRING_GRACE_UNTIL") ?? "").trim();
  const t = raw ? Date.parse(raw) : NaN;
  return Number.isNaN(t) ? Date.parse(DEFAULT_GRACE_UNTIL) : t;
}
function inGracePeriod(): boolean {
  return graceDeadline() > Date.now();
}
// 猶予期間中（＝まだ端末が特定できない）のロック閾値。移行中に「1人の打ち間違いで全員ロック」を
// 起こさないよう大きめにする。この期間はまだ②の恩恵が無いため、緩めて移行を優先する。
const GRACE_MAX_FAILS = 20;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

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
  const allowed = ok ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, content-type, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors(origin) },
  });
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function newDeviceToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}

// タイミング攻撃を避けた定数時間比較
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// listUsers は perPage 上限があるため、全ページを走査して email 一致のユーザーIDを返す。
// （#5: 旧実装は先頭200件しか見ず、内部Authユーザーが200を超えると既存ユーザーを取り逃し、
//   ログイン不能=500になっていた。store_members で引けない異常系のフォールバック用。）
// deno-lint-ignore no-explicit-any
async function findAuthUserIdByEmail(admin: any, email: string): Promise<string | null> {
  const target = email.toLowerCase();
  const perPage = 200;
  for (let page = 1; page <= 100; page++) { // 最大2万ユーザーまでの安全弁
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) break;
    const users = data?.users ?? [];
    // deno-lint-ignore no-explicit-any
    const found = users.find((u: any) => (u.email || "").toLowerCase() === target);
    if (found) return found.id;
    if (users.length < perPage) break; // 最終ページに到達
  }
  return null;
}

// PIN照合: auth_pins（bcrypt）を Postgres 関数 verify_pin で照合する。
// ハッシュ計算は全てDB内に閉じ、Deno側でハッシュを再現しない（言語間不整合・弱いハッシュを排除）。
// 未移行（011前でテーブル/関数が無い、または該当レコードが無い）場合のみ平文列にフォールバック。
// これにより「pin-login新版デプロイ → 011 → 012」の順で無停止移行できる。
// deno-lint-ignore no-explicit-any
async function verifyPin(
  admin: any,
  store_id: string,
  principal: string,
  pin: string,
  legacyPlain: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("verify_pin", {
    p_store_id: store_id, p_principal: principal, p_pin: pin,
  });
  if (!error) {
    if (data === true) return true;
    // 関数あり＆false: 該当 principal のレコードが存在すれば「PIN不一致」確定（平文へ落とさない）
    const { data: ap } = await admin
      .from("auth_pins").select("principal")
      .eq("store_id", store_id).eq("principal", principal).maybeSingle();
    if (ap) return false;
  }
  // 011前（関数/テーブル無し→errorで到達）または未移行レコード → 平文フォールバック
  return !!legacyPlain && safeEqual(pin, legacyPlain);
}

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405, origin);

  const admin = createClient(SUPABASE_URL, SERVICE_KEY);

  try {
    const body = await req.json();
    const { role, cast_id, pin, device_token } = body;
    if ((role !== "owner" && role !== "cast") || !pin) {
      return json({ error: "role(owner|cast), pin は必須です" }, 400, origin);
    }
    const pinStr = String(pin);
    if (pinStr.length < 1 || pinStr.length > 12) return json({ error: "PIN形式が不正です" }, 400, origin);

    // ── ①端末の特定 ──────────────────────────────────────────
    // 店舗は「端末トークン」から導出する。クライアントが送る store_id は信用しない。
    // これにより第三者が任意の店舗のログイン窓口を叩く経路が消える（設計書③）。
    let store_id: string | null = null;
    let deviceId: number | null = null;
    const rawToken = device_token ? String(device_token) : "";
    if (rawToken) {
      const { data: dev } = await admin
        .from("store_devices").select("id,store_id,revoked_at")
        .eq("token_hash", await sha256Hex(rawToken)).maybeSingle();
      if (!dev || dev.revoked_at) {
        // 失効済み・不明なトークン → クライアントに再ペアリングを促す
        return json({ error: "この端末は登録が解除されています。店舗コードで再登録してください", need_pairing: true }, 403, origin);
      }
      store_id = dev.store_id;
      deviceId = dev.id;
    } else {
      // 猶予期間中のみ、トークン無しを許可（既存端末の一斉締め出しを防ぐ移行措置）
      if (!inGracePeriod()) {
        return json({ error: "この端末は登録されていません。店舗コードで登録してください", need_pairing: true }, 403, origin);
      }
      if (!body.store_id) return json({ error: "store_id は必須です" }, 400, origin);
      store_id = String(body.store_id);
    }

    // ── ②ロックの単位 ───────────────────────────────────────
    // 端末ごとにカウントするため、1人の打ち間違いが他のスタッフを巻き込まない。
    // 端末トークンはサーバー発行なので攻撃者が偽造・使い捨てできない。
    const basePrincipal = role === "owner"
      ? "owner"
      : (cast_id ? `cast.${cast_id}` : "castpin");
    const principalKey = deviceId != null
      ? `${basePrincipal}.dev${deviceId}`
      : `${basePrincipal}.${store_id}`;   // 猶予期間中（端末未登録）は従来キー
    // 店舗全体の最終防衛線。登録済み端末と未登録端末でバケットを分ける。
    // （混ぜると、未登録からの攻撃で正規端末まで巻き添えロックされる）
    const storeKey = deviceId != null ? "store.backstop" : "store.backstop.anon";
    const storeLimit = deviceId != null ? STORE_MAX_FAILS : ANON_MAX_FAILS;

    // 0) ロック状態を確認（端末ごと＋店舗全体の二段構え）
    const [{ data: att }, { data: satt }] = await Promise.all([
      admin.from("pin_login_attempts").select("fail_count,locked_until,updated_at")
        .eq("store_id", store_id).eq("principal", principalKey).maybeSingle(),
      admin.from("pin_login_attempts").select("fail_count,locked_until,updated_at")
        .eq("store_id", store_id).eq("principal", storeKey).maybeSingle(),
    ]);

    // 失敗回数は「直近の時間窓内のもの」だけ数える（スライディングウィンドウ）。
    // ※この処理が無いと失敗が生涯累積し、いずれ通常運用でも恒久ロックに入る。
    //   特に店舗カウンタは成功時に消さないため、窓が無いと必ず詰む。
    const freshCount = (row: { fail_count?: number; updated_at?: string } | null, windowMin: number) => {
      if (!row?.updated_at) return 0;
      const age = Date.now() - new Date(row.updated_at).getTime();
      return age < windowMin * 60000 ? (row.fail_count ?? 0) : 0;
    };
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      return json({ error: "この端末は試行回数の上限に達しました。しばらくしてから再度お試しください" }, 429, origin);
    }
    if (satt?.locked_until && new Date(satt.locked_until) > new Date()) {
      return json({ error: "試行回数が上限に達しました。しばらくしてから再度お試しください" }, 429, origin);
    }

    // 失敗時: 端末カウントと店舗カウントの両方を加算し、必要ならロック
    const recordFail = async () => {
      // 端末が特定できている場合のみ厳しく（5回）。猶予期間中の未特定端末は緩める（20回）
      const limit = deviceId != null ? MAX_FAILS : GRACE_MAX_FAILS;
      const next = freshCount(att, LOCK_MINUTES) + 1;
      const locked = next >= limit ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      const sNext = freshCount(satt, STORE_LOCK_MINUTES) + 1;
      const sLocked = sNext >= storeLimit ? new Date(Date.now() + STORE_LOCK_MINUTES * 60000).toISOString() : null;
      const now = new Date().toISOString();
      // 記録に失敗するとレート制限が無言で無効化されるため、必ずログに残す
      // （将来スキーマがずれた場合に気づけるようにする）
      const [r1, r2] = await Promise.all([
        admin.from("pin_login_attempts").upsert(
          // ロックを掛ける時はカウントを0に戻す。戻さないと、ロック解除後の最初の1回の失敗で
          // 即座に閾値を超えて再ロックされ、永久に解けなくなる（ノコギリ波）。
          { store_id, principal: principalKey, fail_count: locked ? 0 : next, locked_until: locked, device_id: deviceId, updated_at: now },
          { onConflict: "store_id,principal" },
        ),
        admin.from("pin_login_attempts").upsert(
          { store_id, principal: storeKey, fail_count: sLocked ? 0 : sNext, locked_until: sLocked, updated_at: now },
          { onConflict: "store_id,principal" },
        ),
      ]);
      if (r1?.error) console.error("pin-login: 端末の試行記録に失敗", r1.error.message);
      if (r2?.error) console.error("pin-login: 店舗の試行記録に失敗", r2.error.message);
    };

    // 1) サーバ側でPIN照合（auth_pins のハッシュを最優先、未移行なら平文フォールバック）
    let memberRole: string;
    let memberCastId: number | null = null;
    if (role === "owner") {
      const { data: ss } = await admin
        .from("store_settings").select("owner_pin").eq("store_id", store_id).maybeSingle();
      const ok = await verifyPin(admin, store_id, "owner", pinStr, ss?.owner_pin ? String(ss.owner_pin) : "");
      if (!ok) { await recordFail(); return json({ error: "PINが違います" }, 401, origin); }
      memberRole = "owner";
    } else if (cast_id) {
      // 旧経路（名前選択あり＝cast_id指定）。後方互換のため温存。
      const { data: c } = await admin
        .from("casts").select("id,pin").eq("id", cast_id).eq("store_id", store_id).maybeSingle();
      const ok = c && await verifyPin(admin, store_id, `cast.${cast_id}`, pinStr, c?.pin ? String(c.pin) : "");
      if (!ok) { await recordFail(); return json({ error: "PINが違います" }, 401, origin); }
      memberRole = "staff";
      memberCastId = Number(cast_id);
    } else {
      // 新経路（PINのみ＝名前選択なし）。店舗内の全キャストとPINを照合し、一致した本人を特定する。
      // PINは店舗内で重複しない前提（set-pin側で重複登録を禁止）。
      // 高速パス: DB内で一括照合（1往復）。resolve_cast_pin 未デプロイ時のみ従来ループにフォールバック。
      let matchedId: number | null = null;
      const { data: rid, error: rErr } = await admin.rpc("resolve_cast_pin", {
        p_store_id: store_id, p_pin: pinStr,
      });
      if (!rErr) {
        matchedId = rid != null ? Number(rid) : null;
      } else {
        const { data: castRows } = await admin
          .from("casts").select("id,pin,active").eq("store_id", store_id);
        const rows = (castRows ?? []).filter((c) => c.active !== false);
        matchedId = await new Promise<number | null>((resolve) => {
          let remaining = rows.length, done = false;
          if (!remaining) { resolve(null); return; }
          for (const c of rows) {
            (async () => {
              let ok = false;
              try {
                const { data, error } = await admin.rpc("verify_pin", {
                  p_store_id: store_id, p_principal: `cast.${c.id}`, p_pin: pinStr,
                });
                ok = (!error && data === true) || (c?.pin != null && safeEqual(pinStr, String(c.pin)));
              } catch (_) { /* skip */ }
              if (done) return;
              if (ok) { done = true; resolve(Number(c.id)); }
              else if (--remaining === 0) resolve(null);
            })();
          }
        });
      }
      if (matchedId == null) { await recordFail(); return json({ error: "PINが違います" }, 401, origin); }
      memberRole = "staff";
      memberCastId = matchedId;
    }

    // 認証成功 → この端末の失敗カウントをリセット。
    // ※店舗バックストップ(storeKey)は消さない。成功のたびに消すと、日常的にログインがある店舗では
    //   カウントが積み上がらず「最終防衛線」として機能しなくなるため（時間経過でロックが解ける）。
    await admin.from("pin_login_attempts").delete().eq("store_id", store_id).eq("principal", principalKey);

    // 自動ペアリング: 猶予期間中にトークン無しでPIN認証に成功した端末を、その場で登録する。
    // スタッフは何も操作しなくても普段どおりログインするだけで移行が完了する。
    let issuedToken: string | null = null;
    if (deviceId == null) {
      const candidate = newDeviceToken();
      const { data: newDev, error: devErr } = await admin.from("store_devices").insert({
        store_id,
        token_hash: await sha256Hex(candidate),
        label: memberRole === "owner" ? "オーナー端末(自動登録)" : `セラピスト端末(自動登録)`,
        last_seen_at: new Date().toISOString(),
      }).select("id").maybeSingle();
      // 登録に失敗したらトークンは返さない。返すと「DBに存在しないトークン」を端末が保存し、
      // 次回から need_pairing になって猶予終了後は店舗コード無しで復帰できなくなるため。
      // （猶予中なら次回ログイン時に再度自動登録が試みられる）
      if (!devErr && newDev?.id) {
        issuedToken = candidate;
        deviceId = newDev.id;
      }
    } else {
      // 既存端末 → 最終利用日時を更新（管理画面で「使われていない端末」を判別するため）
      await admin.from("store_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", deviceId);
    }

    // 2) この主体に対応する内部Authユーザーを「決定的email」で用意する。
    //    emailは実体（owner / cast.<本人ID>）から導出する。ロック用 principalKey とは別物。
    //    （PIN-only経路では principalKey=castpin.<store> だが、認証ユーザーは本人ごとに分ける必要があるため）
    const authPrincipal = memberRole === "owner" ? `owner.${store_id}` : `cast.${memberCastId}.${store_id}`;
    const email = `pin.${authPrincipal}@shiftlink.internal`;
    let userId: string | null = null;
    // 高速化: まず store_members から候補を取得し、本人の決定的emailと一致すれば採用（listUsers走査を回避）
    {
      let q = admin.from("store_members").select("user_id")
        .eq("store_id", store_id).eq("role", memberRole).limit(1);
      q = memberCastId == null ? q.is("cast_id", null) : q.eq("cast_id", memberCastId);
      const { data: smRows } = await q;
      const candId = smRows && smRows[0]?.user_id;
      if (candId) {
        const { data: u } = await admin.auth.admin.getUserById(candId);
        if (u?.user?.email === email) userId = candId as string;
      }
    }
    // 候補が無い/不一致（初回 or 過去の不整合）→ emailで確定
    if (!userId) {
      const { data: created } = await admin.auth.admin.createUser({
        email, email_confirm: true, user_metadata: { store_id, role: memberRole, cast_id: memberCastId },
      });
      userId = created?.user?.id ?? await findAuthUserIdByEmail(admin, email);
    }
    if (!userId) return json({ error: "認証ユーザーの準備に失敗しました" }, 500, origin);

    // 3) store_members を保証（自店スコープの根拠）。
    //    同じ(role,cast_id)に別ユーザーの古い行があれば正しいユーザーへ付け替える（過去の不整合の自己修復）。
    {
      let q = admin.from("store_members").select("id,user_id")
        .eq("store_id", store_id).eq("role", memberRole).limit(1);
      q = memberCastId == null ? q.is("cast_id", null) : q.eq("cast_id", memberCastId);
      const { data: smRows } = await q;
      const existing = (smRows && smRows[0]) || null;
      if (!existing) {
        await admin.from("store_members").insert({ store_id, user_id: userId, role: memberRole, cast_id: memberCastId });
      } else if (existing.user_id !== userId) {
        await admin.from("store_members").update({ user_id: userId }).eq("id", existing.id);
      }
    }

    // 4) 使い捨てパスワードを設定 → サインインしてセッション取得（永続シークレット不要）。
    //    #6: 同一principal(オーナーが複数端末で同時ログイン等)だとパスワード設定が
    //    互いに上書きし合い、片方の signIn が失敗するレースがある。設定→即サインインを
    //    数回リトライして吸収する（各試行で自分のパスワードを直前に再設定するため収束する）。
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    // deno-lint-ignore no-explicit-any
    let session: any = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const ephemeral = crypto.randomUUID() + crypto.randomUUID();
      await admin.auth.admin.updateUserById(userId, { password: ephemeral });
      const { data: signIn } = await anon.auth.signInWithPassword({ email, password: ephemeral });
      if (signIn?.session) { session = signIn.session; break; }
      // 競合で上書きされた可能性 → ジッターを入れて再試行
      await new Promise((r) => setTimeout(r, 40 + Math.floor(Math.random() * 120)));
    }
    if (!session) return json({ error: "セッション発行に失敗しました" }, 500, origin);

    return json({
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: session.expires_at,
      store_id, role: memberRole, cast_id: memberCastId, user_id: userId,
      // 自動ペアリングで発行した場合のみ返る。クライアントは受け取ったら保存する。
      ...(issuedToken ? { device_token: issuedToken } : {}),
    }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
