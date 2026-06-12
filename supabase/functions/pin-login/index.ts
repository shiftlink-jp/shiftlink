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

    const principalKey = role === "owner" ? `owner.${store_id}` : `cast.${cast_id}.${store_id}`;

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
    } else {
      if (!cast_id) return json({ error: "cast_id が必要です" }, 400, origin);
      // cast の存在確認（pin列はもう照合に使わない。存在/所属の確認のみ）
      const { data: c } = await admin
        .from("casts").select("id,pin").eq("id", cast_id).eq("store_id", store_id).maybeSingle();
      const ok = c && await verifyPin(admin, store_id, `cast.${cast_id}`, pinStr, c?.pin ? String(c.pin) : "");
      if (!ok) { await recordFail(); return json({ error: "PINが違います" }, 401, origin); }
      memberRole = "staff";
      memberCastId = Number(cast_id);
    }

    // 認証成功 → 失敗カウントをリセット
    await admin.from("pin_login_attempts").delete().eq("store_id", store_id).eq("principal", principalKey);

    // 2) この主体に対応する内部Authユーザーを用意（決定的email）
    const email = `pin.${principalKey}@shiftlink.internal`;
    let userId: string | null = null;
    // 既存検索（admin listはページングのため email フィルタが無いので getUserByEmail 相当を試行）
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email, email_confirm: true, user_metadata: { store_id, role: memberRole, cast_id: memberCastId },
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (createErr) {
      // 既に存在 → 一覧から検索
      const { data: list } = await admin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const found = list?.users?.find((u) => (u.email || "").toLowerCase() === email.toLowerCase());
      userId = found?.id ?? null;
    }
    if (!userId) return json({ error: "認証ユーザーの準備に失敗しました" }, 500, origin);

    // 3) store_members を保証（自店スコープの根拠）
    const { data: mem } = await admin
      .from("store_members").select("id").eq("user_id", userId).eq("store_id", store_id).maybeSingle();
    if (!mem) {
      await admin.from("store_members").insert({
        store_id, user_id: userId, role: memberRole, cast_id: memberCastId,
      });
    }

    // 4) 使い捨てパスワードを設定 → サインインしてセッション取得（永続シークレット不要）
    const ephemeral = crypto.randomUUID() + crypto.randomUUID();
    await admin.auth.admin.updateUserById(userId, { password: ephemeral });
    const anon = createClient(SUPABASE_URL, ANON_KEY);
    const { data: signIn, error: signErr } = await anon.auth.signInWithPassword({ email, password: ephemeral });
    if (signErr || !signIn?.session) return json({ error: "セッション発行に失敗しました" }, 500, origin);

    return json({
      access_token: signIn.session.access_token,
      refresh_token: signIn.session.refresh_token,
      expires_at: signIn.session.expires_at,
      store_id, role: memberRole, cast_id: memberCastId, user_id: userId,
    }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
