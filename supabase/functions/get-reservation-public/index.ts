// get-reservation-public
// お客さん向け「予約詳細の公開閲覧ページ(r.html)」から呼ばれる読み取り専用 Edge Function。
//   ・入力: token（reservations.public_token / UUID）
//   ・処理: service_role で1件だけ取得 → 予約日を過ぎていたら無効(410) → snapshot を返す
//   ・返す内容は public_snapshot に事前保存した「見せてよい項目」のみ（DBの生行は返さない）
//
// デプロイ: 未ログインのお客さんが開くため JWT 検証を外して公開する。
//   supabase functions deploy get-reservation-public --no-verify-jwt
//   （トークン照合はこの関数内で行うため、鍵を知らない第三者は他人の予約を取得できない）

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

// UUID 形式（推測困難なトークン）以外は弾く
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 日本時間(JST)の今日 YYYY-MM-DD
function todayJST(): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    let token = ''
    if (req.method === 'GET') {
      token = new URL(req.url).searchParams.get('t') || ''
    } else {
      const body = await req.json().catch(() => ({}))
      token = body?.token || body?.t || ''
    }
    token = String(token).trim()

    if (!UUID_RE.test(token)) return json({ error: 'invalid' }, 400)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data, error } = await supabase
      .from('reservations')
      .select('public_snapshot')
      .eq('public_token', token)
      .maybeSingle()

    if (error) return json({ error: 'server' }, 500)
    if (!data || !data.public_snapshot) return json({ error: 'notfound' }, 404)

    const snap = data.public_snapshot as Record<string, unknown>

    // 予約日を過ぎていたら無効
    const date = String(snap.date || '')
    if (date && date < todayJST()) return json({ error: 'expired' }, 410)

    return json({ ok: true, snapshot: snap })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
