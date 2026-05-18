import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@13.6.0?target=deno'

serve(async (req) => {
  try {
    const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2023-10-16' })
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseServiceKey)
    const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

    const body = await req.text()
    const sig = req.headers.get('stripe-signature')!
    const event = stripe.webhooks.constructEvent(body, sig, webhookSecret)

    const updateStore = async (subscriptionId: string, data: Record<string, unknown>) => {
      // subscription metadataからstore_idを取得
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      const storeId = sub.metadata.store_id
      if (!storeId) return
      await supabase.from('stores').update(data).eq('id', storeId)
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.subscription) {
          await updateStore(session.subscription as string, {
            stripe_subscription_id: session.subscription,
            subscription_status: 'active',
          })
        }
        break
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice
        if (invoice.subscription) {
          await updateStore(invoice.subscription as string, {
            subscription_status: 'active',
          })
        }
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        if (invoice.subscription) {
          await updateStore(invoice.subscription as string, {
            subscription_status: 'past_due',
          })
        }
        break
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription
        await updateStore(sub.id, {
          subscription_status: 'canceled',
          stripe_subscription_id: null,
        })
        break
      }
      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription
        await updateStore(sub.id, {
          subscription_status: sub.status,
        })
        break
      }
    }

    return new Response(JSON.stringify({ received: true }), {
      headers: { 'Content-Type': 'application/json' },
    })
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }
})
