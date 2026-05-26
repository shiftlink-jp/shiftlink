import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// トライアル終了前リマインダーメール送信
// stripe-webhookの trial_will_end イベントから呼び出される
// 環境変数 RESEND_API_KEY が設定されていればResend経由でメール送信

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('MAIL_FROM') || 'noreply@shiftlink.jp'

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  let body: { store_id: string; trial_end_at: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { store_id, trial_end_at } = body
  if (!store_id) {
    return new Response(JSON.stringify({ error: 'store_id is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 店舗情報を取得
  const { data: store, error: storeErr } = await supabase
    .from('stores')
    .select('name, owner_email, subscription_status')
    .eq('id', store_id)
    .single()

  if (storeErr || !store) {
    return new Response(JSON.stringify({ error: 'Store not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // 既にactiveなら送信不要
  if (store.subscription_status === 'active') {
    return new Response(JSON.stringify({ skipped: 'already_active' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const toEmail = store.owner_email
  if (!toEmail) {
    console.warn('No owner_email for store:', store_id)
    return new Response(JSON.stringify({ skipped: 'no_email' }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const trialEndDate = trial_end_at
    ? new Date(trial_end_at).toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric' })
    : '近日中'

  const subject = `【ShiftLink】無料トライアルが${trialEndDate}に終了します`
  const html = `
<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="color:#333">ShiftLink トライアル終了のお知らせ</h2>
  <p>${store.name} 様</p>
  <p>いつもShiftLinkをご利用いただきありがとうございます。</p>
  <p>14日間の無料トライアルが <strong>${trialEndDate}</strong> に終了します。</p>
  <p>引き続きご利用いただくには、有料プランへのアップグレードが必要です。</p>
  <div style="margin:24px 0">
    <a href="https://app.shiftlink.jp?saas=1"
       style="background:#e8974a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
      プランをアップグレードする
    </a>
  </div>
  <hr style="border:1px solid #eee;margin:24px 0">
  <p style="color:#888;font-size:.85em">
    ご不明な点は <a href="mailto:support@shiftlink.jp">support@shiftlink.jp</a> までお気軽にお問い合わせください。
  </p>
</div>
`

  // RESEND_API_KEY がない場合はログのみ（本番運用前の開発段階）
  if (!resendApiKey) {
    console.log('[send-trial-reminder] RESEND_API_KEY not set. Would send to:', toEmail)
    console.log('[send-trial-reminder] Subject:', subject)
    return new Response(JSON.stringify({ sent: false, reason: 'no_api_key', to: toEmail }), {
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // Resend APIでメール送信
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: [toEmail],
      subject,
      html,
    }),
  })

  if (!res.ok) {
    const errText = await res.text()
    console.error('[send-trial-reminder] Resend error:', errText)
    return new Response(JSON.stringify({ error: 'email_send_failed', detail: errText }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const data = await res.json()
  console.log('[send-trial-reminder] Email sent:', data.id, 'to:', toEmail)

  return new Response(JSON.stringify({ sent: true, email_id: data.id }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
