import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@14.21.0?target=deno'

serve(async (req) => {
  const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, { apiVersion: '2024-06-20' })
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const supabase = createClient(supabaseUrl, supabaseServiceKey)
  const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

  const body = await req.text()
  const sig = req.headers.get('stripe-signature')!

  // 1. シグネチャ検証（失敗時は400）
  let event: Stripe.Event
  try {
    event = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  } catch (e) {
    console.error('Webhook signature failed:', e.message)
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const updateStore = async (subscriptionId: string, data: Record<string, unknown>) => {
    // subscription metadataからstore_idを取得
    const sub = await stripe.subscriptions.retrieve(subscriptionId)
    const storeId = sub.metadata.store_id
    if (!storeId) {
      console.warn('No store_id in subscription metadata:', subscriptionId)
      return
    }
    // べき等性チェック: subscription_status のみの更新で既に同じ値なら更新不要
    if (data.subscription_status && Object.keys(data).length === 1) {
      const { data: current } = await supabase
        .from('stores')
        .select('subscription_status')
        .eq('id', storeId)
        .single()
      if (current?.subscription_status === data.subscription_status) {
        console.log('Skipping duplicate event, status already:', data.subscription_status)
        return
      }
    }
    const { error } = await supabase.from('stores').update(data).eq('id', storeId)
    if (error) throw new Error(`DB update failed: ${error.message}`)
  }

  // invoiceからsubscription IDを取り出す（API版差異を吸収）
  // 旧: invoice.subscription / 新(2025+): invoice.parent.subscription_details.subscription / 行レベル
  const getInvoiceSubId = (invoice: any): string | null => {
    const norm = (v: any) => (v ? (typeof v === 'string' ? v : v.id) : null)
    return (
      norm(invoice.subscription) ||
      norm(invoice.parent?.subscription_details?.subscription) ||
      norm(
        invoice.lines?.data
          ?.map((l: any) => l.parent?.subscription_item_details?.subscription || l.subscription)
          .find(Boolean),
      )
    )
  }

  // 2. イベント処理（エラーでも200を返す）
  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as Stripe.Checkout.Session
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription as string)
          const data: Record<string, unknown> = {
            stripe_subscription_id: session.subscription,
            subscription_status: sub.status,
          }
          if (sub.status === 'trialing' && sub.trial_end) {
            data.trial_ends_at = new Date(sub.trial_end * 1000).toISOString()
          }
          await updateStore(session.subscription as string, data)
        }
        break
      }
      case 'invoice.paid': {
        const invoice = event.data.object as Stripe.Invoice
        const subId = getInvoiceSubId(invoice)
        if (subId) {
          await updateStore(subId, {
            subscription_status: 'active',
          })
        }
        break
      }
      case 'invoice.payment_failed': {
        const invoice = event.data.object as Stripe.Invoice
        const subId = getInvoiceSubId(invoice)
        if (subId) {
          await updateStore(subId, {
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
        const data: Record<string, unknown> = {
          subscription_status: sub.status,
        }
        if (sub.status === 'trialing' && sub.trial_end) {
          data.trial_ends_at = new Date(sub.trial_end * 1000).toISOString()
        }
        await updateStore(sub.id, data)
        break
      }
      case 'customer.subscription.trial_will_end': {
        // トライアル終了3日前（Stripeが自動送信）
        const sub = event.data.object as Stripe.Subscription
        const trialEndAt = sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null
        if (trialEndAt) {
          await updateStore(sub.id, { trial_ends_at: trialEndAt })
        }
        // store_idをmetadataから取得してリマインダーメールを送信
        const storeId = sub.metadata?.store_id
        if (storeId) {
          try {
            await fetch(`${supabaseUrl}/functions/v1/send-trial-reminder`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${supabaseServiceKey}`,
              },
              body: JSON.stringify({ store_id: storeId, trial_end_at: trialEndAt }),
            })
          } catch (mailErr) {
            // メール送信失敗はcriticalではない（ログのみ）
            console.error('trial reminder email failed:', mailErr)
          }
        }
        console.log('trial_will_end processed for subscription:', sub.id)
        break
      }
    }
  } catch (e) {
    console.error('Webhook processing error:', event.type, e.message)
    // 500を返してStripeに再送を依頼（DB一時障害などからの自動復旧を可能にする）
    // 同じイベントが再送されてもupdateStore内のべき等性チェックで二重処理を防止
    return new Response(JSON.stringify({ error: 'processing_failed', event_type: event.type }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
