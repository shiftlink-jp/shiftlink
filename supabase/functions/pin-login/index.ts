// pin-login: PINをサーバ側で照合し、店舗スコープの認証セッションを発行する。
// これにより「公開anon鍵だけで全データにアクセスできる」根本問題を解消する土台になる。
// （アプリは以降このセッションで動作し、RLSで自店データのみアクセス可能になる）
//
// ★セキュリティ注意（本番投入前に必須）:
//  - PINブルートフォース対策（試行回数制限/ロックアウト）が未実装。本番前に必ず追加すること。
//  - 現状はテスト環境(RLS隔離店舗)での機構検証用。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "http://localhost:3100",
  "http://localhost:3200",
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

    // 1) サーバ側でPIN照合
    let principalKey: string;
    let memberRole: string;
    let memberCastId: number | null = null;
    if (role === "owner") {
      const { data: ss } = await admin
        .from("store_settings").select("owner_pin").eq("store_id", store_id).maybeSingle();
      const ownerPin = ss?.owner_pin ? String(ss.owner_pin) : "";
      if (!ownerPin || !safeEqual(pinStr, ownerPin)) return json({ error: "PINが違います" }, 401, origin);
      principalKey = `owner.${store_id}`;
      memberRole = "owner";
    } else {
      if (!cast_id) return json({ error: "cast_id が必要です" }, 400, origin);
      const { data: c } = await admin
        .from("casts").select("id,pin").eq("id", cast_id).eq("store_id", store_id).maybeSingle();
      const castPin = c?.pin ? String(c.pin) : "";
      if (!c || !castPin || !safeEqual(pinStr, castPin)) return json({ error: "PINが違います" }, 401, origin);
      principalKey = `cast.${cast_id}.${store_id}`;
      memberRole = "staff";
      memberCastId = Number(cast_id);
    }

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
