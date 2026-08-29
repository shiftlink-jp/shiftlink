// submit-survey
// お客さん向け「施術後アンケートページ(s.html)」から呼ばれる Edge Function。
//   ・GET  ?t=token  → 表示に必要な情報と状態(open / submitted)を返す
//   ・POST {t,ratings} → 星の評価を保存する
//
// 設計メモ:
//   ・お客さんは未ログインなので、この関数だけが service_role で surveys を読み書きする。
//     トークン(UUID)を知らない第三者は他人のアンケートに触れない。
//   ・クライアントから store_id は一切受け取らない（URL発行時に予約からコピー済みの値を使う）。
//     受け取ると他店舗に書き込める穴になるため。
//   ・ratings はクライアントの値をそのまま保存せず、既知の4キーだけをサーバー側で組み直す。
//   ・二重送信は `submitted_at IS NULL` の行だけを UPDATE することで防ぐ（更新件数0＝回答済み）。
//
// デプロイ: 未ログインのお客さんが開くため JWT 検証を外して公開する。
//   supabase functions deploy submit-survey --no-verify-jwt

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

// 評価項目（この4つ以外は保存しない）
const RATING_KEYS = ['service', 'skill', 'clean', 'total'] as const

// 有効期限: URL発行から30日
const VALID_DAYS = 30

function isExpired(createdAt: string | null): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  if (isNaN(t)) return false
  return Date.now() - t > VALID_DAYS * 24 * 60 * 60 * 1000
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // ── 入力の取り出し ──
    let token = ''
    let body: Record<string, unknown> = {}
    if (req.method === 'GET') {
      token = new URL(req.url).searchParams.get('t') || ''
    } else {
      body = await req.json().catch(() => ({})) as Record<string, unknown>
      token = String(body?.token || body?.t || '')
    }
    token = token.trim()
    if (!UUID_RE.test(token)) return json({ error: 'invalid' }, 400)

    // ── 対象のアンケートを1件だけ取得 ──
    const { data: row, error } = await supabase
      .from('surveys')
      .select('id,store_name,cast_name,course,visit_date,submitted_at,created_at')
      .eq('token', token)
      .maybeSingle()

    if (error) return json({ error: 'server' }, 500)
    if (!row) return json({ error: 'notfound' }, 404)

    // お客さんの画面に出してよい情報だけ返す（DBの生行は返さない）
    const info = {
      store: row.store_name || '',
      cast: row.cast_name || '',
    }

    // ── GET: 状態を返す ──
    if (req.method === 'GET') {
      if (row.submitted_at) return json({ ok: true, state: 'submitted', ...info })
      if (isExpired(row.created_at)) return json({ error: 'expired' }, 410)
      return json({ ok: true, state: 'open', ...info })
    }

    // ── POST: 回答を保存 ──
    if (row.submitted_at) return json({ error: 'already' }, 409)
    if (isExpired(row.created_at)) return json({ error: 'expired' }, 410)

    // クライアントの値をそのまま入れず、既知の4キーを1〜5の整数として組み直す
    const src = (body?.ratings ?? {}) as Record<string, unknown>
    const ratings: Record<string, number> = {}
    for (const k of RATING_KEYS) {
      const v = Math.trunc(Number(src[k]))
      if (!(v >= 1 && v <= 5)) return json({ error: 'invalid' }, 400)
      ratings[k] = v
    }

    // submitted_at が NULL の行だけを更新（同時に2回押されても1回しか通らない）
    const { data: upd, error: uErr } = await supabase
      .from('surveys')
      .update({ ratings, submitted_at: new Date().toISOString() })
      .eq('token', token)
      .is('submitted_at', null)
      .select('id')

    if (uErr) return json({ error: 'server' }, 500)
    if (!upd || upd.length === 0) return json({ error: 'already' }, 409)

    return json({ ok: true, state: 'submitted', ...info })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
