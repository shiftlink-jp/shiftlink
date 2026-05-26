import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13.6.0?target=deno'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
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
    const appUrl = Deno.env.get('APP_URL') || 'https://app.shiftlink.jp'

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${appUrl}/?saas=1&checkout=success`,
      cancel_url: `${appUrl}/?saas=1&checkout=cancel`,
      subscription_data: {
        metadata: { store_id },
      },
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
