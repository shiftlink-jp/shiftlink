import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

const ALLOWED_ORIGINS = ['https://shiftlink-app.jp', 'https://www.shiftlink-app.jp', 'https://app.shiftlink.jp', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500']
function getCorsHeaders(req: Request) {
  const origin = req.headers.get('Origin') || ''
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(req) })
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })
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
    const priceId = Deno.env.get('STRIPE_PRICE_ID')! // Stripeダッシュボードで作成した価格ID
    const appUrl = Deno.env.get('APP_URL') || 'https://shiftlink-app.jp'

    const subscriptionData: Record<string, unknown> = {
      metadata: { store_id },
    }

    // まだトライアル中で期限内なら残日数をトライアルとして設定
    if (store.subscription_status === 'trialing' && store.trial_ends_at) {
      const remaining = Math.ceil((new Date(store.trial_ends_at).getTime() - Date.now()) / 86400000)
      if (remaining > 0) {
        subscriptionData.trial_period_days = remaining
      }
    }

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
