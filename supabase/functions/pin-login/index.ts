// pin-login: PINをサーバ側で照合し、店舗スコープの認証セッションを発行する。
// これにより「公開anon鍵だけで全データにアクセスできる」根本問題を解消する土台になる。
// （アプリは以降このセッションで動作し、RLSで自店データのみアクセス可能になる）
//
// ブルートフォース対策: pin_login_attempts(010)で失敗回数を数え、MAX_FAILSでロックする。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const MAX_FAILS = 5;            // この回数連続で失敗するとロック
const LOCK_MINUTES = 15;        // ロック時間（分）

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];

function cors(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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
    const { store_id, role, cast_id, pin } = await req.json();
    if (!store_id || (role !== "owner" && role !== "cast") || !pin) {
      return json({ error: "store_id, role(owner|cast), pin は必須です" }, 400, origin);
    }
    const pinStr = String(pin);
    if (pinStr.length < 1 || pinStr.length > 12) return json({ error: "PIN形式が不正です" }, 400, origin);

    // ロック用キー: owner / cast(id指定=旧経路) / cast(PINのみ=本人特定。名前未指定なので店舗単位)
    const principalKey = role === "owner"
      ? `owner.${store_id}`
      : (cast_id ? `cast.${cast_id}.${store_id}` : `castpin.${store_id}`);

    // 0) ロック状態を確認（ブルートフォース対策）
    const { data: att } = await admin
      .from("pin_login_attempts").select("fail_count,locked_until")
      .eq("store_id", store_id).eq("principal", principalKey).maybeSingle();
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      return json({ error: "試行回数が上限に達しました。しばらくしてから再度お試しください" }, 429, origin);
    }

    // 失敗時: 回数を加算し、必要ならロック
    const recordFail = async () => {
      const next = (att?.fail_count ?? 0) + 1;
      const locked = next >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await admin.from("pin_login_attempts").upsert(
        { store_id, principal: principalKey, fail_count: next, locked_until: locked, updated_at: new Date().toISOString() },
        { onConflict: "store_id,principal" },
      );
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
      const { data: castRows } = await admin
        .from("casts").select("id,pin").eq("store_id", store_id);
      const rows = castRows ?? [];
      // 高速化: 全キャストのPIN照合を並行実行（直列N往復→1往復相当）。bcryptはDB内で実行。
      const results = await Promise.all(rows.map(async (c) => {
        const { data, error } = await admin.rpc("verify_pin", {
          p_store_id: store_id, p_principal: `cast.${c.id}`, p_pin: pinStr,
        });
        if (!error && data === true) return Number(c.id);
        if (c?.pin != null && safeEqual(pinStr, String(c.pin))) return Number(c.id); // 未移行の平文フォールバック
        return null;
      }));
      const matchedId = results.find((x) => x != null) ?? null;
      if (matchedId == null) { await recordFail(); return json({ error: "PINが違います" }, 401, origin); }
      memberRole = "staff";
      memberCastId = matchedId;
    }

    // 認証成功 → 失敗カウントをリセット
    await admin.from("pin_login_attempts").delete().eq("store_id", store_id).eq("principal", principalKey);

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
    }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
