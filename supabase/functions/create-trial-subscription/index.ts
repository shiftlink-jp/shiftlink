import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

const ALLOWED_ORIGINS = ['https://app.shiftlink.jp', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500']
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

    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !user) throw new Error('認証エラー')

    const { store_id } = await req.json()
    if (!store_id) throw new Error('store_id is required')

    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('*')
      .eq('id', store_id)
      .single()
    if (storeErr || !store) throw new Error('店舗が見つかりません')
    if (store.owner_user_id !== user.id) throw new Error('権限がありません')

    // 既にStripeサブスクがある場合はスキップ
    if (store.stripe_subscription_id) {
      return new Response(JSON.stringify({ status: 'already_exists' }), {
        headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
      })
    }

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

    const priceId = Deno.env.get('STRIPE_PRICE_ID')!

    // 14日間トライアル付きサブスクリプション作成（カード不要）
    // idempotencyKey で同一store_idの重複リクエスト（ダブルクリック等）を防止
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: priceId }],
      trial_period_days: 14,
      payment_settings: {
        save_default_payment_method: 'on_subscription',
      },
      trial_settings: {
        end_behavior: { missing_payment_method: 'pause' },
      },
      metadata: { store_id },
    }, {
      // idempotencyKey: ダブルクリック等の即時重複を防ぐ。
      // 日付を含めることで日をまたいだ再トライアル（解約後の再申込み）は別キーになる。
      // ※既存サブスクの確認はL40-45で先行実施済み。
      idempotencyKey: `create-trial-${store_id}-${new Date().toISOString().slice(0,10)}`,
    })

    const trialEnd = subscription.trial_end
      ? new Date(subscription.trial_end * 1000).toISOString()
      : new Date(Date.now() + 14 * 86400000).toISOString()

    await supabase.from('stores').update({
      stripe_subscription_id: subscription.id,
      subscription_status: 'trialing',
      trial_ends_at: trialEnd,
    }).eq('id', store_id)

    return new Response(JSON.stringify({ status: 'created', trial_ends_at: trialEnd }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('create-trial-subscription error:', e)
    // 日本語メッセージ（意図的にthrowしたユーザー向けエラー）はそのまま返す
    const isUserFacingError = /[　-鿿]/.test(e.message)
    return new Response(JSON.stringify({
      error: isUserFacingError ? e.message : 'サーバーエラーが発生しました',
    }), {
      // ユーザー入力起因は400、サーバー側障害(Stripe/DB)は500
      status: isUserFacingError ? 400 : 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
