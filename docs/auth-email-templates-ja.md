# Supabase 認証メール 日本語テンプレート（白×オレンジ）

Supabaseの標準メール（英語）を日本語＋ブランドデザインに差し替えるためのHTML。

## 貼り付け場所
Supabaseダッシュボード（プロジェクト **fewuonnrgqnxtopkjudt**）
→ 左メニュー **Authentication** → **Emails**（または Email Templates）
→ 各テンプレート（タブ）を選び、**Subject（件名）** と **Message body（本文・Source/HTML欄）** をそれぞれ下記に差し替えて保存。

- 差出人名/アドレス（Auth Supabase / noreply@…supabase.io）はこの画面では変えられない。自社ドメイン化は独自SMTP（Resend等）が必要＝別タスク（レベル2）。
- 本文欄は「HTML（Source）」で貼ること。プレーンテキスト欄しか無い場合はそのままHTMLを貼ってOK。
- Supabaseの変数（`{{ .ConfirmationURL }}` 等）はそのまま残すこと。消すとリンクが動かなくなる。

---

## 1. Confirm signup（登録確認）

**件名:**
```
【ShiftLink】メールアドレスの確認をお願いします
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">ご登録ありがとうございます</p>
      <p style="margin:0 0 24px;color:#555;">下のボタンを押して、メールアドレスの確認を完了してください。</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#e8821e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">メールアドレスを確認する</a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;">ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="margin:0 0 8px;color:#e8821e;font-size:12px;word-break:break-all;">{{ .ConfirmationURL }}</p>
      <p style="margin:24px 0 0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```

---

## 2. Reset Password（パスワード再設定）

**件名:**
```
【ShiftLink】パスワード再設定のご案内
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">パスワードの再設定</p>
      <p style="margin:0 0 24px;color:#555;">下のボタンから新しいパスワードを設定してください。</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#e8821e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">パスワードを再設定する</a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;">ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="margin:0 0 8px;color:#e8821e;font-size:12px;word-break:break-all;">{{ .ConfirmationURL }}</p>
      <p style="margin:24px 0 0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。パスワードは変更されません。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```

---

## 3. Magic Link（マジックリンクでログイン）

**件名:**
```
【ShiftLink】ログイン用リンクをお送りします
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">ログイン用リンク</p>
      <p style="margin:0 0 24px;color:#555;">下のボタンを押すとログインできます。</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#e8821e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">ログインする</a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;">ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="margin:0 0 8px;color:#e8821e;font-size:12px;word-break:break-all;">{{ .ConfirmationURL }}</p>
      <p style="margin:24px 0 0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```

---

## 4. Change Email Address（メールアドレス変更の確認）

**件名:**
```
【ShiftLink】メールアドレス変更の確認をお願いします
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">メールアドレス変更の確認</p>
      <p style="margin:0 0 24px;color:#555;"><b>{{ .Email }}</b> から <b>{{ .NewEmail }}</b> への変更を受け付けました。下のボタンで確定してください。</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#e8821e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">変更を確定する</a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;">ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="margin:0 0 8px;color:#e8821e;font-size:12px;word-break:break-all;">{{ .ConfirmationURL }}</p>
      <p style="margin:24px 0 0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```

---

## 5. Invite user（招待）

**件名:**
```
【ShiftLink】アカウント招待のお知らせ
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">ShiftLinkへの招待</p>
      <p style="margin:0 0 24px;color:#555;">ShiftLinkに招待されました。下のボタンからアカウントを作成してください。</p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="{{ .ConfirmationURL }}" style="display:inline-block;background:#e8821e;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:14px 32px;border-radius:10px;">アカウントを作成する</a>
      </div>
      <p style="margin:0 0 8px;color:#999;font-size:12px;">ボタンが押せない場合は、以下のURLをブラウザに貼り付けてください。</p>
      <p style="margin:0 0 8px;color:#e8821e;font-size:12px;word-break:break-all;">{{ .ConfirmationURL }}</p>
      <p style="margin:24px 0 0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```

---

## 6. Reauthentication（再認証・確認コード）

このメールだけはURLではなく**確認コード**（OTP）を送る。変数は `{{ .Token }}`。

**件名:**
```
【ShiftLink】確認コードのお知らせ
```

**本文(HTML):**
```html
<div style="margin:0;padding:24px;background:#f7f7f5;font-family:-apple-system,BlinkMacSystemFont,'Hiragino Sans','Segoe UI',sans-serif;">
  <div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06);">
    <div style="background:#ffffff;padding:28px 32px 8px;text-align:center;">
      <span style="font-size:22px;font-weight:800;letter-spacing:.04em;color:#111;">SHIFT<span style="color:#e8821e;">LINK</span></span>
    </div>
    <div style="height:4px;background:#e8821e;margin:8px 32px 0;border-radius:4px;"></div>
    <div style="padding:28px 32px 8px;color:#333;line-height:1.8;font-size:15px;text-align:center;">
      <p style="margin:0 0 16px;font-weight:700;font-size:17px;">確認コード</p>
      <p style="margin:0 0 16px;color:#555;">以下のコードを入力して認証を完了してください。</p>
      <p style="margin:0 0 16px;font-size:32px;font-weight:800;letter-spacing:.2em;color:#e8821e;">{{ .Token }}</p>
      <p style="margin:0;color:#aaa;font-size:12px;">このメールに心当たりがない場合は、破棄してください。</p>
    </div>
    <div style="padding:20px 32px 28px;text-align:center;color:#bbb;font-size:11px;">SHIFTLINK（シフトリンク）／ メンズエステ店舗管理</div>
  </div>
</div>
```
