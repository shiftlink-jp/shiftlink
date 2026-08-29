// submit-application
// 求人応募フォーム(a.html)から呼ばれる Edge Function。
//   ・GET  ?t=token  → 店名と「受付中かどうか」を返す
//   ・POST {t, ...}  → 応募内容と写真を保存する
//
// 設計メモ:
//   ・応募者は未ログイン。この関数だけが service_role で applications と Storage を書く。
//     applications には INSERT ポリシーが無いので、クライアントからの直接投稿は通らない。
//   ・URLは求人広告に貼る前提＝誰でも送れる。そのため
//       - 18歳未満は必ずここで弾く（画面のチェックだけでは回避できてしまう）
//       - IPをハッシュ化して直近1時間の連投を制限する（生のIPは保存しない）
//       - 写真は宣言されたContent-Typeを信用せず、中身の先頭バイトで画像かを判定する
//   ・写真の置き場所は <store_id>/<ランダムUUID>/<n>.jpg。
//     応募IDは採番前なので使わない（先に写真を置いてから1回のINSERTで行を作る）。
//
// デプロイ: 未ログインの応募者が開くため JWT 検証を外して公開する。
//   supabase functions deploy submit-application --no-verify-jwt

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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// 受け取る上限
const MAX_BODY = 6 * 1024 * 1024      // リクエスト全体 6MB
const MAX_PHOTO = 3 * 1024 * 1024     // 写真1枚 3MB（縮小後は通常500KB以下）
const MAX_PHOTOS = 2
const RATE_WINDOW_MIN = 60            // 直近60分に
const RATE_MAX = 5                    // 5件まで

const BUSTS = ['A','B','C','D','E','F','G','H','I','J']
const EXPERIENCES = ['未経験','経験あり']

// 文字列を整えて長さで切る
function str(v: unknown, max: number): string {
  return String(v ?? '').trim().slice(0, max)
}

// 中身の先頭バイトから画像形式を判定する（宣言されたMIMEは信用しない）
function sniffImage(bytes: Uint8Array): { ext: string; mime: string } | null {
  if (bytes.length < 12) return null
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return { ext: 'png', mime: 'image/png' }
  const ascii = (i: number, s: string) => s.split('').every((c, k) => bytes[i + k] === c.charCodeAt(0))
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { ext: 'webp', mime: 'image/webp' }
  return null
}

// data URL ("data:image/jpeg;base64,....") からバイト列を取り出す
function decodeDataUrl(s: string): Uint8Array | null {
  const m = /^data:[^;,]*;base64,(.+)$/s.exec(s)
  if (!m) return null
  try {
    const bin = atob(m[1])
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch (_e) {
    return null
  }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    // 本文を読む前に、宣言サイズで門前払いする
    const declared = Number(req.headers.get('content-length') || 0)
    if (declared > MAX_BODY) return json({ error: '写真のサイズが大きすぎます' }, 413)

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    let token = ''
    let body: Record<string, unknown> = {}
    if (req.method === 'GET') {
      token = new URL(req.url).searchParams.get('t') || ''
    } else {
      const raw = await req.text()
      if (raw.length > MAX_BODY) return json({ error: '写真のサイズが大きすぎます' }, 413)
      try { body = JSON.parse(raw) } catch (_e) { return json({ error: 'invalid' }, 400) }
      token = String(body?.token || body?.t || '')
    }
    token = token.trim()
    if (!UUID_RE.test(token)) return json({ error: 'invalid' }, 400)

    // トークンから店舗を特定する
    const { data: st, error: stErr } = await supabase
      .from('store_settings')
      .select('store_id, recruit_enabled, recruit_store_name')
      .eq('recruit_token', token)
      .maybeSingle()

    if (stErr) return json({ error: 'server' }, 500)
    if (!st) return json({ error: 'notfound' }, 404)

    const enabled = st.recruit_enabled !== false
    const storeId = st.store_id as string | null

    // 店名は公開ページに出す。URLコピー時に写したアプリ側の表示名を優先する
    let storeName = String(st.recruit_store_name || '').trim()
    if (!storeName && storeId) {
      const { data: s } = await supabase.from('stores').select('name').eq('id', storeId).maybeSingle()
      storeName = s?.name || ''
    }

    // ── GET: 受付中かどうかを返す ──
    if (req.method === 'GET') {
      return json({ ok: true, state: enabled ? 'open' : 'closed', store: storeName })
    }

    // ── POST: 応募を受け付ける ──
    if (!enabled) return json({ error: 'closed' }, 403)

    // 年齢（18歳未満は受け付けない。ここが最後の砦）
    const ageNum = Number(body?.age)
    if (!Number.isFinite(ageNum) || !Number.isInteger(ageNum)) return json({ error: '年齢を数字で入力してください' }, 400)
    if (ageNum < 18) return json({ error: '18歳未満の方はご応募いただけません' }, 400)
    if (ageNum > 99) return json({ error: '年齢を正しく入力してください' }, 400)

    const name = str(body?.name, 50)
    if (!name) return json({ error: 'お名前を入力してください' }, 400)

    const area = str(body?.area, 60)
    const bustRaw = str(body?.bust, 4)
    const bust = BUSTS.includes(bustRaw) ? bustRaw : ''
    const expRaw = str(body?.experience, 10)
    const experience = EXPERIENCES.includes(expRaw) ? expRaw : ''
    const experienceNote = str(body?.experience_note, 300)

    const numOrNull = (v: unknown, min: number, max: number): number | null => {
      const n = Math.trunc(Number(v))
      return Number.isFinite(n) && n >= min && n <= max ? n : null
    }
    const height = numOrNull(body?.height, 100, 220)
    const weight = numOrNull(body?.weight, 30, 150)

    // 連投制限（生のIPは保存せず、店舗ごとのハッシュにする）
    const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown'
    const ipHash = await sha256Hex(`${storeId || 'none'}:${ip}`)
    const since = new Date(Date.now() - RATE_WINDOW_MIN * 60 * 1000).toISOString()
    const { count: recent } = await supabase
      .from('applications')
      .select('id', { count: 'exact', head: true })
      .eq('ip_hash', ipHash)
      .gte('submitted_at', since)
    if ((recent ?? 0) >= RATE_MAX) {
      return json({ error: '短時間に多くの応募が送信されています。しばらく時間をおいてお試しください' }, 429)
    }

    // 写真（任意・最大2枚）。中身を見て画像でなければ弾く
    const rawPhotos = Array.isArray(body?.photos) ? (body.photos as unknown[]).slice(0, MAX_PHOTOS) : []
    const files: { bytes: Uint8Array; ext: string; mime: string }[] = []
    for (const p of rawPhotos) {
      if (typeof p !== 'string' || !p) continue
      const bytes = decodeDataUrl(p)
      if (!bytes) return json({ error: '写真を読み取れませんでした' }, 400)
      if (bytes.length > MAX_PHOTO) return json({ error: '写真のサイズが大きすぎます' }, 413)
      const kind = sniffImage(bytes)
      if (!kind) return json({ error: '画像ファイルを選んでください' }, 400)
      files.push({ bytes, ...kind })
    }

    // 先に写真を置いてから、パスが確定した状態で行を1回で作る
    const folder = crypto.randomUUID()
    const photoPaths: string[] = []
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      const path = `${storeId || 'none'}/${folder}/${i + 1}.${f.ext}`
      const { error: upErr } = await supabase.storage
        .from('applicant-photos')
        .upload(path, f.bytes, { contentType: f.mime, upsert: false })
      if (upErr) {
        // 途中まで置いた分は消してから諦める（保管庫にゴミを残さない）
        if (photoPaths.length) await supabase.storage.from('applicant-photos').remove(photoPaths)
        return json({ error: 'server' }, 500)
      }
      photoPaths.push(path)
    }

    const { error: insErr } = await supabase.from('applications').insert({
      store_id: storeId,
      name, age: ageNum, area, height, weight, bust,
      experience, experience_note: experienceNote,
      photo_paths: photoPaths.length ? photoPaths : null,
      ip_hash: ipHash,
    })

    if (insErr) {
      if (photoPaths.length) await supabase.storage.from('applicant-photos').remove(photoPaths)
      return json({ error: 'server' }, 500)
    }

    return json({ ok: true, state: 'submitted', store: storeName })
  } catch (_e) {
    return json({ error: 'server' }, 500)
  }
})
