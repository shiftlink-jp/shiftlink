import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

// 環境変数に貼り付けミスで見えない文字（U+2028 など）が混ざると、HTTPヘッダーを
// 組み立てられず「Stripeに接続できません」という原因の分かりにくいエラーになる。
// 2026-08-06に本番で発生し、新規登録のトライアル契約が全て失敗していた。
// Stripeの鍵・IDは [A-Za-z0-9_] しか含まないので、それ以外を落としてから使う。
const envClean = (name: string) => (Deno.env.get(name) || '').replace(/[^A-Za-z0-9_]/g, '')


const ALLOWED_ORIGINS = ['https://shiftlink-app.jp', 'https://www.shiftlink-app.jp', 'https://app.shiftlink.jp', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500']
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  try {
    const stripe = new Stripe(envClean('STRIPE_SECRET_KEY'), {
      apiVersion: '2024-06-20',
      // Deno(Edge)では既定のNode製HTTPクライアントが動かない。環境が更新されると
      // 'Deno.core.runMicrotasks() is not supported' が出てStripeに接続すらできなくなる。
      // 2026-08-06に本番で発生し、新規登録のトライアル契約が全て失敗していた。
      httpClient: Stripe.createFetchHttpClient(),
    })
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // JWTからユーザー取得
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !user) throw new Error('認証エラー')

    const { store_id } = await req.json()
    if (!store_id) throw new Error('store_id is required')

    // store情報取得
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .single()
    if (storeErr || !store) throw new Error('店舗が見つかりません')

    // オーナーか確認
    if (store.owner_user_id !== user.id) throw new Error('権限がありません')

    // Stripe Customer作成 or 既存取得
    let customerId = store.stripe_customer_id
    if (!customerId) {
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { store_id, store_name: store.name },
      })
      customerId = customer.id
      await supabase.from('stores').update({ stripe_customer_id: customerId }).eq('id', store_id)
    }

    // Checkout Session作成
    const priceId = envClean('STRIPE_PRICE_ID') // Stripeダッシュボードで作成した価格ID
    const appUrl = Deno.env.get('APP_URL') || 'https://shiftlink-app.jp'

    const subscriptionData: Record<string, unknown> = {
      metadata: { store_id },
    }

    // トライアルは「初回契約の店舗」のみに付与する。
    // 過去に一度でもサブスクを作成した店舗（解約後の再契約を含む）はトライアルなしで即課金。
    if (store.subscription_status === 'trialing' && store.trial_ends_at) {
      const remaining = Math.ceil((new Date(store.trial_ends_at).getTime() - Date.now()) / 86400000)
      if (remaining > 0) {
        // Stripe上の契約歴を確認（active/canceled等すべて対象）。1件でもあれば再契約とみなしトライアルなし。
        const pastSubs = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 1 })
        if (pastSubs.data.length === 0) {
          subscriptionData.trial_period_days = remaining
        }
      }
    }

    // ── 支払い方法：銀行振込（2026-08-05に切替） ─────────────────────────────
    // カード(Checkout Session)から、Stripeの請求書＋銀行振込に変更した。
    //   理由: 手数料 3.6% → 1.5%。
    //   仕組み: 顧客ごとにStripeが仮想口座を発行し、入金を請求書へ自動で消し込む。
    //           当方の実口座は開示しない。
    //   注意: 銀行振込は「自動引き落とし」ではない。毎月、店舗が自分で振り込む必要がある。
    //         期限を過ぎると Stripe が subscription を past_due にし、アプリ側の
    //         subscription_status チェックで利用停止になる（index.html の判定は変更不要）。
    //   ★カードへ戻す場合は、下の checkout.sessions.create ブロックを復活させるだけでよい。
    //     （Stripeダッシュボード側で「銀行振込」を有効化していることが前提）
    const DAYS_UNTIL_DUE = 7   // 請求書発行から振込期限までの日数

    // 二重契約の防止。ボタン連打や「申し込んだか不安でもう一度」で
    // サブスクが2本立つと二重請求になる。生きている契約があればそれを使い回す。
    const live = await stripe.subscriptions.list({ customer: customerId, status: 'all', limit: 10 })
    const existing = live.data.find((s) =>
      ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'].includes(s.status)
    )
    if (existing) {
      // 2026-08-06以前に作られた契約、および create-trial-subscription が
      // 銀行振込対応になる前に登録した店舗は、カード引き落とし方式のままになっている。
      // そのまま使い回すと請求書が発行されず、店舗に振込先が出ないまま止まる。
      // ここで振込方式へ乗り換えさせる（契約自体は作り直さないので二重請求にならない）。
      if (existing.collection_method !== 'send_invoice') {
        const patch: Record<string, unknown> = {
          collection_method: 'send_invoice',
          days_until_due: DAYS_UNTIL_DUE,
          payment_settings: {
            payment_method_types: ['customer_balance'],
            payment_method_options: {
              customer_balance: {
                funding_type: 'bank_transfer',
                bank_transfer: { type: 'jp_bank_transfer' },
              },
            },
          },
        }
        // trial_settings はトライアル中のみ意味を持つ。終了後に送るとStripeが拒否する。
        if (existing.status === 'trialing') {
          patch.trial_settings = { end_behavior: { missing_payment_method: 'create_invoice' } }
        }
        await stripe.subscriptions.update(existing.id, patch as never)
      }

      let hosted: string | null = null
      if (existing.latest_invoice) {
        const invId = typeof existing.latest_invoice === 'string'
          ? existing.latest_invoice
          : (existing.latest_invoice as { id: string }).id
        let latest = await stripe.invoices.retrieve(invId)
        if (latest.status === 'draft') latest = await stripe.invoices.finalizeInvoice(latest.id)
        if (latest.status === 'open') hosted = latest.hosted_invoice_url ?? null
      }
      return new Response(
        JSON.stringify({ url: hosted || `${appUrl}/?saas=1&checkout=success`, method: 'bank_transfer', reused: true }),
        { headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      )
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      collection_method: 'send_invoice',
      days_until_due: DAYS_UNTIL_DUE,
      payment_settings: {
        payment_method_types: ['customer_balance'],
        payment_method_options: {
          customer_balance: {
            funding_type: 'bank_transfer',
            bank_transfer: { type: 'jp_bank_transfer' },
          },
        },
      },
      ...subscriptionData,
      expand: ['latest_invoice'],
    } as never)

    await supabase.from('stores')
      .update({ stripe_subscription_id: (subscription as { id: string }).id })
      .eq('id', store_id)

    // 請求書ページ（振込先の口座・金額・期限が載っている）へ誘導する。
    // トライアル中に申し込んだ場合は請求書がまだ無い（トライアル終了時に発行される）ため、
    // その場合はアプリに戻して「お申し込みを受け付けました」と見せる。
    // 下書き(draft)のままだと振込先が発行されず、店舗に「どこへ振り込むか」が出ない。
    // 自動確定を待たず、その場で確定して振込先入りの請求書ページを返す。
    let inv = (subscription as { latest_invoice?: { id: string; status: string; hosted_invoice_url?: string | null } }).latest_invoice ?? null
    if (inv && inv.status === 'draft') {
      inv = await stripe.invoices.finalizeInvoice(inv.id) as unknown as typeof inv
    }
    const url = (inv && inv.status === 'open' && inv.hosted_invoice_url)
      ? inv.hosted_invoice_url
      : `${appUrl}/?saas=1&checkout=success`   // トライアル中＝請求書はまだ無い

    return new Response(JSON.stringify({ url, method: 'bank_transfer' }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })

    /* カード決済（2026-08-05まで使用。戻すときはここを復活させる）
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/?saas=1&checkout=success`,
      cancel_url: `${appUrl}/?saas=1&checkout=cancel`,
      subscription_data: subscriptionData,
      payment_method_collection: 'always',
    })
    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
    */
  } catch (e) {
    console.error('stripe-checkout error:', e)
    // 日本語メッセージ（意図的にthrowしたユーザー向けエラー）はそのまま返す
    const isUserFacingError = /[　-鿿]/.test(e.message)
    return new Response(JSON.stringify({
      error: isUserFacingError ? e.message : 'サーバーエラーが発生しました',
    }), {
      // ユーザー入力起因(認証/権限/不正入力)は400、サーバー側障害(Stripe/DB)は500
      status: isUserFacingError ? 400 : 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
