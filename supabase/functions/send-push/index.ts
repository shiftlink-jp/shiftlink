import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { jwtVerify } from "npm:jose@5";

const VAPID_PUBLIC_KEY = "BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const INTERNAL_SECRET = Deno.env.get("PUSH_INTERNAL_SECRET") ?? "";
// 重要: 本プロジェクトは新JWT署名キー(JWKS)へ移行済みで SUPABASE_JWT_SECRET は自動注入されない。
// レガシーanon鍵(HS256)を署名検証するには、ダッシュボードの「Legacy JWT Secret」を
// Edge Functions のシークレットに手動設定する。ただし SUPABASE_ で始まる名前は予約のため不可。
// → LEGACY_JWT_SECRET という名前で設定すること（未設定だと anon鍵を検証できず全て401）。
const JWT_SECRET = new TextEncoder().encode(
  Deno.env.get("LEGACY_JWT_SECRET") ?? Deno.env.get("SUPABASE_JWT_SECRET") ?? "",
);

// JWT 署名を Legacy JWT Secret で検証する（ペイロード読み取りのみでは偽造可能なため）
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

    // KYOUKANO本番はPhase1バックフィルでpush_subscriptions.store_idがUUID化済みだが、
    // クライアント(currentStoreId=null)からはstore_id:nullで送られてくる(ステップ2デプロイまでの間)。
    // RLSのcompat shimと同様、NULL/KYOUKANO_UUIDの両方を許可して通知欠落を防ぐ。
    const KYOUKANO_STORE_ID = "4cb3383a-31e5-408a-9f75-60a25943ac4d";
    let url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,subscription&cast_id=eq.${cast_id}`;
    if (store_id) url += `&store_id=eq.${store_id}`;
    else url += `&or=(store_id.is.null,store_id.eq.${KYOUKANO_STORE_ID})`;

    const res = await fetch(url, {
      headers: {
        "apikey": SUPABASE_SERVICE_KEY,
        "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
      },
    });
    const rawSubs = await res.json();
    const subs = Array.isArray(rawSubs) ? rawSubs : [];

    // 1件ずつ送信し、失敗しても他の購読への送信を止めない。
    // 失効(410 Gone / 404 Not Found)した購読はDBから掃除して、次回以降の連鎖失敗を防ぐ。
    // ※従来は for ループ内で1件でも例外が飛ぶと全体が中断し、生きている購読にも届かなかった。
    let sent = 0;
    let failed = 0;
    const deadIds: string[] = [];
    for (const sub of subs) {
      try {
        await sendPush(sub.subscription, { title, body: pushBody });
        sent++;
      } catch (err) {
        failed++;
        // deno-lint-ignore no-explicit-any
        const code = (err as any)?.statusCode;
        if (code === 404 || code === 410) deadIds.push(sub.id);
        // deno-lint-ignore no-explicit-any
        console.error(`[send-push] sub ${sub.id} failed: ${code ?? ""} ${(err as any)?.message ?? err}`);
      }
    }

    if (deadIds.length > 0) {
      const idList = deadIds.map((id) => `"${id}"`).join(",");
      await fetch(`${SUPABASE_URL}/rest/v1/push_subscriptions?id=in.(${idList})`, {
        method: "DELETE",
        headers: {
          "apikey": SUPABASE_SERVICE_KEY,
          "Authorization": `Bearer ${SUPABASE_SERVICE_KEY}`,
        },
      }).catch(() => {});
    }

    return new Response(JSON.stringify({ ok: true, sent, failed, cleaned: deadIds.length }), {
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
