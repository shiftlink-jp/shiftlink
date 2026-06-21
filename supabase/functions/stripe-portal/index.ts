import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

// Stripe Customer Portal セッション作成
// 解約・カード変更・請求書閲覧はすべてStripeのポータル画面で処理

const ALLOWED_ORIGINS = ['https://shiftlink-app.jp', 'https://www.shiftlink-app.jp', 'https://app.shiftlink.jp', 'http://localhost:3000', 'http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3100']
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
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)

    // JWT認証
    const authHeader = req.headers.get('Authorization')!
    const token = authHeader.replace('Bearer ', '')
    const { data: { user }, error: userErr } = await supabase.auth.getUser(token)
    if (userErr || !user) throw new Error('認証エラー')

    const { store_id } = await req.json()
    if (!store_id) throw new Error('store_id is required')

    // 店舗情報取得
    const { data: store, error: storeErr } = await supabase
      .from('stores')
      .select('stripe_customer_id, owner_user_id')
      .eq('id', store_id)
      .single()
    if (storeErr || !store) throw new Error('店舗が見つかりません')

    // オーナー権限チェック
    if (store.owner_user_id !== user.id) throw new Error('権限がありません')

    if (!store.stripe_customer_id) throw new Error('Stripeアカウントが未設定です。先にプランのアップグレードを行ってください。')

    const appUrl = Deno.env.get('APP_URL') || 'https://shiftlink-app.jp'

    // Customer Portal セッション作成
    const session = await stripe.billingPortal.sessions.create({
      customer: store.stripe_customer_id,
      return_url: `${appUrl}/?saas=1`,
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  } catch (e) {
    console.error('stripe-portal error:', e)
    const isUserFacingError = /[　-鿿]/.test(e.message)
    return new Response(JSON.stringify({
      error: isUserFacingError ? e.message : 'サーバーエラーが発生しました',
    }), {
      status: isUserFacingError ? 400 : 500,
      headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' },
    })
  }
})
