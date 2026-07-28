// lp-analytics-summary
// 別ページの簡易LPアナリティクスダッシュボードから呼ばれる集計専用 Edge Function。
//   ・入力: POSTボディの password（クエリパラメータには載せない。ログ・履歴に残るため）
//   ・処理: パスワード照合 → service_role で lp_analytics_events を集計して返す
//   ・lp_analytics_events テーブルは anon に INSERT のみ許可（SELECT不可）のため、
//     集計値の閲覧は必ずこの関数（パスワード必須）を経由させる。
//
// デプロイ: 未ログインのオーナーが専用ページから開くため JWT 検証を外して公開する。
//   supabase functions deploy lp-analytics-summary --no-verify-jwt
//   環境変数 LP_ANALYTICS_PASSWORD を別途設定すること。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })

function todayJstDateOnly(daysAgo: number): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000 - daysAgo * 86400000)
  return now.toISOString().slice(0, 10)
}

// タイミング攻撃を避けるための定数時間比較
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}
    const password = String(body?.password || '')
    const expected = Deno.env.get('LP_ANALYTICS_PASSWORD') || ''

    if (!expected || !safeEqual(password, expected)) return json({ error: 'unauthorized' }, 401)

    const days = Math.min(Math.max(Number(body?.days || 7), 1), 90)
    const sinceDate = todayJstDateOnly(days - 1)
    const since = new Date(sinceDate + 'T00:00:00+09:00').toISOString()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data, error } = await supabase
      .from('lp_analytics_events')
      .select('event_type, session_id, cta_text, dwell_ms, created_at')
      .gte('created_at', since)

    if (error) return json({ error: 'server' }, 500)

    const rows = data || []
    const pageviews = rows.filter((r) => r.event_type === 'pageview')
    const clicks = rows.filter((r) => r.event_type === 'cta_click')
    const dwells = rows.filter((r) => r.event_type === 'dwell' && typeof r.dwell_ms === 'number')

    const visitors = new Set(pageviews.map((r) => r.session_id)).size
    const avgDwellSeconds = dwells.length
      ? Math.round(dwells.reduce((sum, r) => sum + (r.dwell_ms || 0), 0) / dwells.length / 1000)
      : 0

    const ctaBreakdown: Record<string, number> = {}
    for (const c of clicks) {
      const key = c.cta_text || '(不明)'
      ctaBreakdown[key] = (ctaBreakdown[key] || 0) + 1
    }

    const dailyMap: Record<string, { pageviews: number; clicks: number }> = {}
    for (let i = days - 1; i >= 0; i--) {
      dailyMap[todayJstDateOnly(i)] = { pageviews: 0, clicks: 0 }
    }
    for (const r of pageviews) {
      const d = new Date(new Date(r.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (dailyMap[d]) dailyMap[d].pageviews++
    }
    for (const r of clicks) {
      const d = new Date(new Date(r.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (dailyMap[d]) dailyMap[d].clicks++
    }

    return json({
      ok: true,
      days,
      pageviews: pageviews.length,
      visitors,
      ctaClicks: clicks.length,
      clickRate: pageviews.length ? Math.round((clicks.length / pageviews.length) * 1000) / 10 : 0,
      avgDwellSeconds,
      ctaBreakdown,
      daily: Object.entries(dailyMap).map(([date, v]) => ({ date, ...v })),
    })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
