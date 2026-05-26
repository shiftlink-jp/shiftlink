import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const VAPID_PUBLIC_KEY = "BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type" } });
  }

  try {
    const { cast_id, title, body } = await req.json();

    // push_subscriptionsからsubscriptionを取得
    const res = await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?cast_id=eq.${cast_id}`, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      }
    });
    const subs = await res.json();

    const results = [];
    for (const sub of subs) {
      const subscription = sub.subscription;
      const result = await sendPush(subscription, { title, body });
      results.push(result);
    }

    return new Response(JSON.stringify({ ok: true, sent: results.length }), {
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
});

async function sendPush(subscription: any, payload: { title: string; body: string }) {
  const { default: webpush } = await import("npm:web-push");
  webpush.setVapidDetails("mailto:admin@example.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  await webpush.sendNotification(subscription, JSON.stringify(payload));
  return "sent";
}
