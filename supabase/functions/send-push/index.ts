// send-push: Web Push 通知を送信する Edge Function。
//
// ★監査#2 対策（公開anon鍵だけで誰でも偽Pushを送れる問題の根治）★
//   旧版は「Supabaseが発行した正規JWTか？」だけを見ていたが、公開anon鍵自体も正規JWTのため
//   素通りし、anon鍵を知る誰でも（=全員）任意の cast_id / store_id / 本文で偽通知を送れた。
//   本版では信頼済み(サーバ間)経路を除き、admin.auth.getUser で「本物のログインセッション」を
//   必須にする（anon鍵では user が取れず 401）。さらに store_members で呼び出し元の所属店舗を
//   求め、送信先 store_id が自店であることを検証する（他店への偽Push送信を遮断）。
//
//   ※前提: PIN認証カットオーバー後はクライアントが pin-login 発行のセッションを持つため、
//     sendPushNotification はその access_token を送る（無い場合のみ従来anonにフォールバック）。
//     本版のデプロイはカットオーバー Phase B（anon遮断と同段階）で行う。
//     詳細は docs/cutover-runbook-20260611.md / docs/secure-pins-runbook.md 参照。
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const VAPID_PUBLIC_KEY = "BIWgxZ65EfPhsXdHaY7_L_Pk7dd3PWTIaePCNwBUqL-gUppTf7LCvd5RqrOPbfsYfdOnc-OLrTOH1ff8h5r9n0E";
const VAPID_PRIVATE_KEY = Deno.env.get("VAPID_PRIVATE_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// サーバ間呼び出し（他Edge Function等）用の内部シークレット。クライアントには配らない。
const INTERNAL_SECRET = Deno.env.get("PUSH_INTERNAL_SECRET") ?? "";

// KYOUKANO本番はPhase1で全データにstore_idを付与済みだが、レガシー行(store_id=null)の
// 取りこぼし防止のため null / KYOUKANO_UUID の両方を「KYOUKANOの店」として扱う。
const KYOUKANO_STORE_ID = "4cb3383a-31e5-408a-9f75-60a25943ac4d";

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
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-internal-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

function json(body: unknown, status: number, origin: string | null) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

serve(async (req) => {
  const origin = req.headers.get("origin");

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders(origin) });
  }

  const internalSecret = req.headers.get("x-internal-secret");
  const token = (req.headers.get("authorization") ?? "").replace("Bearer ", "").trim();

  // 信頼済み経路: 内部シークレット or service_role（サーバ間呼び出し）。全店へ送信可。
  const isInternal = !!INTERNAL_SECRET && internalSecret === INTERNAL_SECRET;
  const isService = !!token && token === SUPABASE_SERVICE_KEY;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  // callerStoreIds: null=信頼済み(全店可)。配列=このユーザーが所属する店舗のみ送信可。
  let callerStoreIds: string[] | null = null;
  if (!isInternal && !isService) {
    // ★本物のログインセッションを必須にする（公開anon鍵では user が取れず 401）★
    const { data: { user }, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !user) {
      return json({ error: "Unauthorized" }, 401, origin);
    }
    // 呼び出し元の所属店舗を取得（他店への送信を防ぐ根拠）
    const { data: mems } = await admin
      .from("store_members").select("store_id").eq("user_id", user.id);
    callerStoreIds = (mems ?? []).map((m: { store_id: string }) => m.store_id).filter(Boolean);
    if (callerStoreIds.length === 0) {
      return json({ error: "Forbidden" }, 403, origin);
    }
  }

  try {
    const body = await req.json();
    const cast_id = body?.cast_id;
    const title = String(body?.title ?? "").slice(0, 100);
    const pushBody = String(body?.body ?? "").slice(0, 300);
    let store_id: string | null = body?.store_id ?? null;

    if (cast_id == null || !title) {
      return json({ error: "cast_id と title は必須です" }, 400, origin);
    }

    // ユーザーセッション呼び出しは「自店のみ」に制限（他店へ偽Pushを送れない）。
    if (callerStoreIds !== null) {
      const callerHasKyoukano = callerStoreIds.includes(KYOUKANO_STORE_ID);
      // 後方互換: クライアントが store_id:null を送ってきても、本人がKYOUKANO所属ならKYOUKANOに寄せる。
      if (!store_id && callerHasKyoukano) store_id = KYOUKANO_STORE_ID;
      if (!store_id || !callerStoreIds.includes(store_id)) {
        return json({ error: "他店舗への送信はできません" }, 403, origin);
      }
    }

    // 送信先購読を取得（service_role で読むのでRLSの影響を受けない）。
    let url = `${SUPABASE_URL}/rest/v1/push_subscriptions?select=id,subscription&cast_id=eq.${cast_id}`;
    if (!store_id || store_id === KYOUKANO_STORE_ID) {
      // KYOUKANO/未指定: 旧データ(store_id=null)も含めて取りこぼし防止。
      url += `&or=(store_id.is.null,store_id.eq.${KYOUKANO_STORE_ID})`;
    } else {
      url += `&store_id=eq.${store_id}`;
    }

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

    return json({ ok: true, sent, failed, cleaned: deadIds.length }, 200, origin);
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500, origin);
  }
});

// deno-lint-ignore no-explicit-any
async function sendPush(subscription: any, payload: { title: string; body: string }) {
  const { default: webpush } = await import("npm:web-push");
  webpush.setVapidDetails("mailto:shiftlink.jp@gmail.com", VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  await webpush.sendNotification(subscription, JSON.stringify(payload));
  return "sent";
}
