import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const LINE_TOKEN = Deno.env.get('LINE_CHANNEL_TOKEN')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!

async function sendLine(to: string, message: string) {
  await fetch('https://api.line.me/v2/bot/message/push', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${LINE_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      to,
      messages: [{ type: 'text', text: message }]
    })
  })
}

async function sendWebPush(subscription: any, title: string, body: string, url?: string) {
  try {
    const { endpoint, keys } = subscription
    const { p256dh, auth } = keys

    // VAPID JWT生成
    const audience = new URL(endpoint).origin
    const now = Math.floor(Date.now() / 1000)
    const header = btoa(JSON.stringify({ typ: 'JWT', alg: 'ES256' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
    const payload = btoa(JSON.stringify({ aud: audience, exp: now + 86400, sub: 'mailto:admin@kyoukano.com' })).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')

    // 秘密鍵インポート
    const privateKeyBytes = base64ToUint8Array(VAPID_PRIVATE_KEY)
    const cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      privateKeyBytes,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )

    const signingInput = `${header}.${payload}`
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      new TextEncoder().encode(signingInput)
    )
    const jwt = `${signingInput}.${uint8ArrayToBase64Url(new Uint8Array(signature))}`

    // ペイロード暗号化
    const pushPayload = JSON.stringify({ title, body, url: url || '/' })
    const encryptedPayload = await encryptPayload(pushPayload, p256dh, auth)

    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt},k=${VAPID_PUBLIC_KEY}`,
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'aes128gcm',
        'TTL': '86400'
      },
      body: encryptedPayload
    })
  } catch (e) {
    console.error('Web Push error:', e)
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const b = base64.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(b)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function uint8ArrayToBase64Url(arr: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i])
  return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

async function encryptPayload(payload: string, p256dhBase64: string, authBase64: string): Promise<Uint8Array> {
  const p256dh = base64ToUint8Array(p256dhBase64)
  const auth = base64ToUint8Array(authBase64)
  const payloadBytes = new TextEncoder().encode(payload)

  const serverKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits'])
  const clientPublicKey = await crypto.subtle.importKey('raw', p256dh, { name: 'ECDH', namedCurve: 'P-256' }, false, [])
  const sharedBits = await crypto.subtle.deriveBits({ name: 'ECDH', public: clientPublicKey }, serverKeyPair.privateKey as CryptoKey, 256)

  const serverPublicKeyRaw = await crypto.subtle.exportKey('raw', serverKeyPair.publicKey as CryptoKey)
  const salt = crypto.getRandomValues(new Uint8Array(16))

  const prk = await hkdf(new Uint8Array(sharedBits), auth, new TextEncoder().encode('Content-Encoding: auth\0'), 32)
  const cek = await hkdf(prk, salt, buildInfo('aesgcm', new Uint8Array(serverPublicKeyRaw), p256dh), 16)
  const nonce = await hkdf(prk, salt, buildInfo('nonce', new Uint8Array(serverPublicKeyRaw), p256dh), 12)

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt'])
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, payloadBytes)

  const serverPublicKeyBytes = new Uint8Array(serverPublicKeyRaw)
  const result = new Uint8Array(salt.length + 4 + 1 + serverPublicKeyBytes.length + encrypted.byteLength)
  let offset = 0
  result.set(salt, offset); offset += 16
  result.set([0, 0, 16, 0], offset); offset += 4
  result.set([serverPublicKeyBytes.length], offset); offset += 1
  result.set(serverPublicKeyBytes, offset); offset += serverPublicKeyBytes.length
  result.set(new Uint8Array(encrypted), offset)
  return result
}

function buildInfo(type: string, serverKey: Uint8Array, clientKey: Uint8Array): Uint8Array {
  const label = new TextEncoder().encode(`Content-Encoding: ${type}\0P-256\0`)
  const result = new Uint8Array(label.length + 2 + serverKey.length + 2 + clientKey.length)
  let offset = 0
  result.set(label, offset); offset += label.length
  result.set([0, serverKey.length], offset); offset += 2
  result.set(serverKey, offset); offset += serverKey.length
  result.set([0, clientKey.length], offset); offset += 2
  result.set(clientKey, offset)
  return result
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', salt, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const prk = new Uint8Array(await crypto.subtle.sign('HMAC', key, ikm))
  const prkKey = await crypto.subtle.importKey('raw', prk, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const infoWithCounter = new Uint8Array(info.length + 1)
  infoWithCounter.set(info); infoWithCounter[info.length] = 1
  const okm = new Uint8Array(await crypto.subtle.sign('HMAC', prkKey, infoWithCounter))
  return okm.slice(0, length)
}

async function notifyUser(sb: any, castId: string, title: string, body: string, url?: string) {
  // LINE通知
  const { data: cast } = await sb.from('casts').select('line_user_id').eq('id', castId).single()
  if (cast?.line_user_id) {
    await sendLine(cast.line_user_id, `${title}\n\n${body}`)
  }
  // Web Push通知
  const { data: subs } = await sb.from('push_subscriptions').select('subscription').eq('cast_id', castId)
  if (subs) {
    for (const row of subs) {
      await sendWebPush(row.subscription, title, body, url)
    }
  }
}

serve(async (req) => {
  const body = await req.json()
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY)

  // LINEからのWebhookイベント
  if (body.events) {
    for (const event of body.events) {
      const lineUserId = event.source?.userId
      if (!lineUserId) continue
      if (event.type === 'follow') {
        await sendLine(lineUserId, `友達追加ありがとうございます！\nあなたのIDを登録しました。\nキャスト名を送ってください。`)
      }
      if (event.type === 'message' && event.message?.type === 'text') {
        const text = event.message.text.trim()
        const { data: cast } = await sb.from('casts').select('id, name').eq('name', text).single()
        if (cast) {
          await sb.from('casts').update({ line_user_id: lineUserId }).eq('id', cast.id)
          await sendLine(lineUserId, `${cast.name}さんとして登録しました！\nシフト承認・予約の通知が届くようになります。`)
        } else {
          await sendLine(lineUserId, `「${text}」というキャスト名が見つかりませんでした。\n正確な名前をもう一度送ってください。`)
        }
      }
    }
    return new Response('ok', { status: 200 })
  }

  // Database Webhook通知
  const { type, data } = body
  if (type === 'shift_approved') {
    const { cast_id, date, start_time, end_time } = data
    await notifyUser(sb, cast_id, '✅ シフトが承認されました', `日付：${date}\n時間：${start_time}〜${end_time}`)
  }
  if (type === 'reservation_created') {
    const { cast_id, customer_name, course, checkin_time, shimei } = data
    await notifyUser(sb, cast_id, '🔔 予約が入りました', `お客様：${customer_name}\nコース：${course}\n入室：${checkin_time}\n指名：${shimei}`)
  }

  return new Response('ok', { status: 200 })
})