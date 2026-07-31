// list-store-casts: ログイン画面のキャスト選択用に、指定店舗の在籍キャストの
// 「id と name のみ」を返す。認証前に呼ばれる前提（RLS厳格化後はanonがcastsを
// 読めないため、この関数が唯一の取得経路になる）。
//
// 公開する情報は id+name のみ（pin等は返さない）。ログインピッカーに必要な最小限。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];

// 猶予期間（pin-login と同じ設計）。環境変数が未設定・書式不正なら「猶予ON」に倒す（fail-open）。
// fail-closedにすると設定漏れやタイポで全店がログイン画面に進めなくなるため。
const DEFAULT_GRACE_UNTIL = "2026-08-11T00:00:00+09:00";
function inGracePeriod(): boolean {
  const raw = (Deno.env.get("PAIRING_GRACE_UNTIL") ?? "").trim();
  const t = raw ? Date.parse(raw) : NaN;
  return (Number.isNaN(t) ? Date.parse(DEFAULT_GRACE_UNTIL) : t) > Date.now();
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

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

serve(async (req) => {
  const origin = req.headers.get("origin");
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(origin) });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405, headers: { "Content-Type": "application/json", ...cors(origin) },
    });
  }
  try {
    const body = await req.json();
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);

    // 端末トークンから店舗を特定する（クライアントの store_id は信用しない）。
    // これにより「store_idを知る第三者が在籍セラピスト名を取得できる」露出を塞ぐ。
    let store_id: string | null = null;
    const rawToken = body.device_token ? String(body.device_token) : "";
    if (rawToken) {
      const { data: dev } = await admin
        .from("store_devices").select("store_id,revoked_at")
        .eq("token_hash", await sha256Hex(rawToken)).maybeSingle();
      if (!dev || dev.revoked_at) {
        return new Response(JSON.stringify({ error: "この端末は登録されていません", need_pairing: true }), {
          status: 403, headers: { "Content-Type": "application/json", ...cors(origin) },
        });
      }
      store_id = dev.store_id;
    } else {
      if (!inGracePeriod()) {
        return new Response(JSON.stringify({ error: "この端末は登録されていません", need_pairing: true }), {
          status: 403, headers: { "Content-Type": "application/json", ...cors(origin) },
        });
      }
      store_id = body.store_id ? String(body.store_id) : null;
    }
    if (!store_id) {
      return new Response(JSON.stringify({ error: "store_id は必須です" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors(origin) },
      });
    }
    const { data, error } = await admin
      .from("casts").select("id,name")
      .eq("store_id", store_id).eq("active", true)
      .order("sort_order", { ascending: true });
    if (error) throw error;
    return new Response(JSON.stringify({ casts: data ?? [] }), {
      headers: { "Content-Type": "application/json", ...cors(origin) },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message ?? e) }), {
      status: 500, headers: { "Content-Type": "application/json", ...cors(origin) },
    });
  }
});
