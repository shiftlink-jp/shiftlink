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
const LOCK_MINUTES = 30;

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
    const { data: pc } = await admin
      .from("store_pairing_codes")
      .select("id,store_id,expires_at,used_at")
      .eq("code_hash", codeHash).maybeSingle();

    // 総当たり対策（コードは店舗横断で一意なので、失敗は共通バケットで数える）
    const lockKey = "pairing.global";
    const { data: att } = await admin
      .from("pin_login_attempts").select("fail_count,locked_until")
      .is("store_id", null).eq("principal", lockKey).maybeSingle();
    if (att?.locked_until && new Date(att.locked_until) > new Date()) {
      return json({ error: "試行回数が上限に達しました。しばらくしてから再度お試しください" }, 429, origin);
    }

    const fail = async (msg: string, status: number) => {
      const next = (att?.fail_count ?? 0) + 1;
      const locked = next >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : null;
      await admin.from("pin_login_attempts").upsert(
        { store_id: null, principal: lockKey, fail_count: next, locked_until: locked, updated_at: new Date().toISOString() },
        { onConflict: "store_id,principal" },
      );
      return json({ error: msg }, status, origin);
    };

    if (!pc) return await fail("店舗コードが正しくありません", 401);
    if (pc.used_at) return await fail("この店舗コードは使用済みです。オーナーに再発行を依頼してください", 401);
    if (new Date(pc.expires_at) <= new Date()) {
      return await fail("この店舗コードは有効期限が切れています。オーナーに再発行を依頼してください", 401);
    }

    // 成功 → 失敗カウントをリセットし、トークンを発行
    await admin.from("pin_login_attempts").delete().is("store_id", null).eq("principal", lockKey);

    const token = newToken();
    const tokenHash = await sha256Hex(token);
    const { error: insErr } = await admin.from("store_devices").insert({
      store_id: pc.store_id,
      token_hash: tokenHash,
      label: label ? String(label).slice(0, 60) : null,
      last_seen_at: new Date().toISOString(),
    });
    if (insErr) return json({ error: "端末の登録に失敗しました" }, 500, origin);

    // コードを使用済みにする（1回使い切り）
    await admin.from("store_pairing_codes").update({ used_at: new Date().toISOString() }).eq("id", pc.id);

    // 生トークンはここでしか返さない
    return json({ ok: true, device_token: token }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});
