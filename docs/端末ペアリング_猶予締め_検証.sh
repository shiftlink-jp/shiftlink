#!/bin/bash
# 猶予期間の締め 検証スクリプト
#   使い方:  bash grace_check.sh
#   3本のEdge Functionに「合鍵(device_token)なし」で叩き、締まっているかを見る。
#
#   締まっている  → 3本とも 403 / need_pairing
#   まだ猶予ON    → pin-login以外は通る（＝締まっていない）
#
# ⚠️ pin-login のテストは「締めたあと」だけにすること。
#    締める前は403で止まらずPIN照合まで進み、失敗カウントが1増えるため。

set -u
URL="https://qgcgkrcrfzonmmygcdju.supabase.co/functions/v1"
STORE="4cb3383a-31e5-408a-9f75-60a25943ac4d"   # KYOUKANO
KEY=$(python3 -c "
import re;s=open('/Users/konnoren/shiftlink/index.html',encoding='utf-8').read()
print(re.search(r\"SUPABASE_KEY\s*=\s*['\\\"]([^'\\\"]+)\",s).group(1))")

hit () { # $1=関数名  $2=JSON  $3=説明
  printf '\n── %-18s %s\n' "$1" "$3"
  curl -s -o /tmp/_gb -w '   HTTP %{http_code}\n' -X POST "$URL/$1" \
    -H "Content-Type: application/json" -H "apikey: $KEY" \
    -H "Authorization: Bearer $KEY" \
    -H "Origin: https://kyoukano.vercel.app" -d "$2"
  printf '   '; head -c 220 /tmp/_gb; echo
}

MODE="${1:-post}"

hit list-store-casts "{\"store_id\":\"$STORE\"}" "合鍵なしでセラピスト名簿を要求"

hit passkey "{\"action\":\"auth-verify\",\"store_id\":\"$STORE\",\"cast_id\":0,\"response\":{},\"challenge_id\":\"00000000-0000-0000-0000-000000000000\"}" \
  "合鍵なしで生体認証を要求"

if [ "$MODE" = "post" ]; then
  hit pin-login "{\"role\":\"cast\",\"pin\":\"000000\",\"store_id\":\"$STORE\"}" \
    "合鍵なしでPINログインを要求（締めたあと専用）"
else
  printf '\n── %-18s %s\n' "pin-login" "スキップ（締める前は失敗カウントが増えるため）"
fi

echo
echo "判定: 締まっていれば 3本とも HTTP 403 かつ need_pairing:true"
