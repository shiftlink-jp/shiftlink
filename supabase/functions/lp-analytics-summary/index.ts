// lp-analytics-summary
// 別ページの簡易LPアナリティクスダッシュボードから呼ばれる集計専用 Edge Function。
//   ・パスワード認証なし（URLを知っている人だけが見られる想定。個人情報は含まない集計値のみ返す）
//   ・処理: service_role で lp_analytics_events を集計して返す
//   ・lp_analytics_events テーブルは anon に INSERT のみ許可（SELECT不可）のため、
//     集計値の閲覧は必ずこの関数を経由させる。
//
// デプロイ: 未ログインのオーナーが専用ページから開くため JWT 検証を外して公開する。
//   supabase functions deploy lp-analytics-summary --no-verify-jwt

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

interface LpEvent {
  event_type: string
  session_id: string
  cta_text: string | null
  dwell_ms: number | null
  section: string | null
  max_section: string | null
  created_at: string
}

function todayJstDateOnly(daysAgo: number): string {
  const now = new Date(Date.now() + 9 * 60 * 60 * 1000 - daysAgo * 86400000)
  return now.toISOString().slice(0, 10)
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {}

    const days = Math.min(Math.max(Number(body?.days || 7), 1), 90)
    const sinceDate = todayJstDateOnly(days - 1)
    const since = new Date(sinceDate + 'T00:00:00+09:00').toISOString()

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ★1000行の壁★ SupabaseのREST APIは1回の取得を既定で1000行に打ち切る。
    //   打ち切られても error にはならず、静かに少ない数字が出るだけ＝気づけない。
    //   （2026-08-08に実測: 1187行あるのに pageview 200→173, cta_click 17→10 と過少集計されていた）
    //   なので .range() で最後まで読み切る。1ページでも取り漏らすと全部の数字が狂うため、
    //   途中でエラーが出たら部分集計を返さずに 500 にする。
    const PAGE = 1000
    const MAX_PAGES = 200            // 20万行で頭打ち（無限ループの保険）
    const rows: LpEvent[] = []
    for (let page = 0; page < MAX_PAGES; page++) {
      const { data, error } = await supabase
        .from('lp_analytics_events')
        .select('event_type, session_id, cta_text, dwell_ms, section, max_section, created_at')
        .gte('created_at', since)
        .order('id', { ascending: true })   // 並び順を固定しないとページ間で重複・欠落が起きる
        .range(page * PAGE, page * PAGE + PAGE - 1)

      if (error) return json({ error: 'server' }, 500)
      const chunk = (data || []) as unknown as LpEvent[]
      rows.push(...chunk)
      if (chunk.length < PAGE) break        // 最終ページ
    }

    const pageviews = rows.filter((r) => r.event_type === 'pageview')
    const clicks = rows.filter((r) => r.event_type === 'cta_click')
    const dwells = rows.filter((r) => r.event_type === 'dwell' && typeof r.dwell_ms === 'number')
    const sectionViews = rows.filter((r) => r.event_type === 'section_view')
    const conversions = rows.filter((r) => r.event_type === 'conversion')

    const visitors = new Set(pageviews.map((r) => r.session_id)).size
    const avgDwellSeconds = dwells.length
      ? Math.round(dwells.reduce((sum, r) => sum + (r.dwell_ms || 0), 0) / dwells.length / 1000)
      : 0

    const ctaBreakdown: Record<string, number> = {}
    for (const c of clicks) {
      const key = c.cta_text || '(不明)'
      ctaBreakdown[key] = (ctaBreakdown[key] || 0) + 1
    }

    // セクション到達率(ファネル): 各セクションを見たユニークセッション数
    const sectionSessions: Record<string, Set<string>> = {}
    for (const r of sectionViews) {
      const key = r.section || '(不明)'
      if (!sectionSessions[key]) sectionSessions[key] = new Set()
      sectionSessions[key].add(r.session_id)
    }
    const funnel = Object.entries(sectionSessions)
      .map(([section, sessionSet]) => ({ section, sessions: sessionSet.size }))
      .sort((a, b) => a.section.localeCompare(b.section, 'ja'))

    // 離脱箇所: dwellイベントのmax_section別カウント
    const exitBreakdown: Record<string, number> = {}
    for (const d of dwells) {
      const key = d.max_section || '(不明)'
      exitBreakdown[key] = (exitBreakdown[key] || 0) + 1
    }

    const conversionCount = new Set(conversions.map((r) => r.session_id)).size
    const conversionRate = visitors ? Math.round((conversionCount / visitors) * 1000) / 10 : 0

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
      funnel,
      exitBreakdown,
      conversions: conversionCount,
      conversionRate,
    })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
