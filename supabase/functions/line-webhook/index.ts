import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const CHANNEL_TOKEN = Deno.env.get('LINE_INQUIRY_CHANNEL_TOKEN')!

async function reply(replyToken: string, messages: object[]) {
  await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${CHANNEL_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ replyToken, messages }),
  })
}

function text(msg: string) {
  return { type: 'text', text: msg }
}

function getAutoReply(message: string): string | null {
  const m = message.trim()

  if (/料金|価格|いくら|費用|月額/.test(m)) {
    return `💰 ShiftLinkの料金は月額¥14,800（税込）の1プランのみです。\n\n✅ 全機能込み・セラピスト人数無制限\n✅ 14日間無料トライアル付き\n✅ クレジットカード不要\n\n👇 今すぐ無料で試せます\nhttps://app.shiftlink.jp/lp.html`
  }
  if (/トライアル|試し|無料|お試し/.test(m)) {
    return `🎁 14日間の無料トライアルをご利用いただけます！\n\nクレジットカード不要・いつでも解約可能です。\n\n👇 こちらから申し込みできます\nhttps://app.shiftlink.jp/?saas=1`
  }
  if (/機能|できる|使える|シフト|予約|委託金|売上/.test(m)) {
    return `📱 ShiftLinkの主な機能はこちらです：\n\n✅ 委託金の自動計算\n✅ シフト管理\n✅ 予約管理\n✅ 売上集計・分析\n✅ 顧客カルテ・NG管理\n✅ Push通知\n\n詳しくはLPをご覧ください👇\nhttps://app.shiftlink.jp/lp.html`
  }
  if (/契約|解約|やめ|停止/.test(m)) {
    return `📋 ご契約・解約についてのご質問ですね。\n\n・契約は月額制で、いつでも解約可能です\n・解約は管理画面から即時手続きできます\n・途中解約の場合、日割り返金はございません\n\nその他ご不明な点はこのトークにメッセージをお送りください。担当者が確認してご返信します。`
  }
  if (/使い方|操作|わからない|教えて|ヘルプ|help/.test(m)) {
    return `🙋 使い方についてのご質問ですね！\n\n14日間のトライアル期間中は、セットアップのサポートも行っています。\n\nこのトークに「サポート希望」とお送りいただくか、このまま質問を続けてください。担当者が対応します。`
  }
  if (/サポート|対応|担当|連絡|問い合わせ/.test(m)) {
    return `📩 お問い合わせありがとうございます！\n\nメッセージを受け付けました。担当者が確認次第、このトークへご返信します（通常24時間以内）。\n\nお急ぎの場合は以下からもお問い合わせいただけます👇\nhttps://app.shiftlink.jp/lp.html`
  }
  return null
}

serve(async (req) => {
  try {
    const rawBody = await req.text()
    const payload = JSON.parse(rawBody)

    for (const event of (payload.events || [])) {
      if (event.type === 'follow') {
        await reply(event.replyToken, [
          text(`👋 ShiftLinkの公式LINEへようこそ！\n\nメンズエステ店舗向けのシフト・予約・委託金管理アプリです。\n\n以下のキーワードで情報をお届けします：\n・「料金」→ 料金案内\n・「トライアル」→ 無料体験\n・「機能」→ 機能一覧\n・「サポート」→ 担当者へ連絡\n\nご質問はいつでもどうぞ！`)
        ])
        continue
      }

      if (event.type === 'message' && event.message?.type === 'text') {
        const userMessage = event.message.text
        const autoReply = getAutoReply(userMessage)
        if (autoReply) {
          await reply(event.replyToken, [text(autoReply)])
        } else {
          await reply(event.replyToken, [
            text(`メッセージありがとうございます！\n\n担当者が確認してご返信します（通常24時間以内）。\n\nよくある質問はこちらのキーワードでも確認できます👇\n・「料金」\n・「トライアル」\n・「機能」\n・「サポート」`)
          ])
        }
      }
    }

    return new Response('ok', { status: 200 })
  } catch (_e) {
    return new Response('ok', { status: 200 })
  }
})
