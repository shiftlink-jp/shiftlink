import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const VAPID_PUBLIC_KEY = "BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const INTERNAL_SECRET = Deno.env.get("PUSH_INTERNAL_SECRET") ?? "";

const ALLOWED_ORIGINS = [
  "https://kyoukano.vercel.app",
  "https://app.shiftlink.jp",
  "https://shiftlink-app.jp",
  "https://www.shiftlink-app.jp",
];

function corsHeaders(origin: string | null) {
  const allowed = origin && ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
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

  // 認証：内部シークレット（Edge Functionから呼ぶ場合）またはSupabase JWT
  const internalSecret = req.headers.get("x-internal-secret");
  const authHeader = req.headers.get("authorization") ?? "";
  const token = authHeader.replace("Bearer ", "").trim();

  const isInternal = INTERNAL_SECRET && internalSecret === INTERNAL_SECRET;
  const isValidToken = token === SUPABASE_ANON_KEY || token === SUPABASE_SERVICE_KEY;

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

    // push_subscriptions を取得（store_id フィルタ付き）
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
