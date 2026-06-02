import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { jwtVerify } from "npm:jose@5";

const VAPID_PUBLIC_KEY = "BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET = Deno.env.get("PUSH_INTERNAL_SECRET") ?? "";
// SUPABASE_JWT_SECRET は Supabase Edge Functions に自動注入される組み込みシークレット
const JWT_SECRET = new TextEncoder().encode(Deno.env.get("SUPABASE_JWT_SECRET") ?? "");

// JWT 署名を SUPABASE_JWT_SECRET で検証する（ペイロード読み取りのみでは偽造可能なため）
async function isValidSupabaseJWT(token: string): Promise<boolean> {
  if (!JWT_SECRET.length) return false;
  try {
    await jwtVerify(token, JWT_SECRET, { issuer: "supabase" });
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
];

// Vercel プレビュー URL は kyoukano プロジェクト配下のみ許可
const VERCEL_PREVIEW_RE = /^https:\/\/kyoukano[\w-]*\.vercel\.app$/;

function corsHeaders(origin: string | null) {
  const isAllowed = origin && (ALLOWED_ORIGINS.includes(origin) || VERCEL_PREVIEW_RE.test(origin));
  const allowed = isAllowed ? origin! : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Headers": "authorization, content-type, x-internal-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  const internalSecret = req.headers.get("x-internal-secret");
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();

  const isInternal = INTERNAL_SECRET && internalSecret === INTERNAL_SECRET;
  const isValidToken = await isValidSupabaseJWT(token) || token === SUPABASE_SERVICE_KEY;

  if (!isInternal && !isValidToken) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }

  try {
    const body = await req.json();
    const cast_id = body?.cast_id;
    const title = String(body?.title ?? "").slice(0, 100);
    const pushBody = String(body?.body ?? "").slice(0, 300);
    const store_id: string | null = body?.store_id ?? null;

    if (cast_id == null || !title) {
      return new Response(JSON.stringify({ error: "cast_id と title は必須です" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let url = `${SUPABASE_URL}/rest/v1/push_subscriptions?cast_id=eq.${cast_id}`;
    if (store_id) url += `&store_id=eq.${store_id}`;
    else url += `&store_id=is.null`;

    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    const subs = await res.json();

    const results = [];
    for (const sub of subs) {
      const result = await sendPush(sub.subscription, { title, body: pushBody });
      results.push(result);
    }

    return new Response(JSON.stringify({ ok: true, sent: results.length }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
});

// deno-lint-ignore no-explicit-any
async function sendPush(subscription: any, payload: { title: string; body: string }) {
  const { default: webpush } = await import("npm:web-push");
  webpush.setVapidDetails("mailto:shiftlink.jp@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  await webpush.sendNotification(subscription, JSON.stringify(payload));
  return "sent";
}
