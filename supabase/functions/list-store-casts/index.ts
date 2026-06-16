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
  "http://localhost:3100",
  "http://localhost:3200",
  "http://localhost:3300",
];

const VERCEL_PREVIEW_RE = /^https:\/\/kyoukano[\w-]*\.vercel\.app$/;
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
    const { store_id } = await req.json();
    if (!store_id) {
      return new Response(JSON.stringify({ error: "store_id は必須です" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors(origin) },
      });
    }
    const admin = createClient(SUPABASE_URL, SERVICE_KEY);
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
