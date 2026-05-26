"""
writer.py – Anthropic API でコンテンツを自動生成する
  - 写メ日記, ニュース, 出勤コメント の3種類を生成
  - システムプロンプトにプロンプトキャッシュを適用（3回の呼び出しで2回キャッシュヒット）
"""
import logging
import os
from typing import Any

import anthropic

logger = logging.getLogger(__name__)

MODEL = "claude-opus-4-7"

SYSTEM_PROMPT = """あなたはメンズエステ予約サイト「エステ魂（estama.jp）」に掲載している店舗のSNS担当スタッフです。

【店舗コンセプト】
高品質なリラクゼーションと癒しを提供する都内メンズエステ。
清潔感・安心感・丁寧なおもてなしを大切にしています。
ターゲット: 20代〜50代のビジネスマン・社会人男性。

【コンテンツ方針】
- 品のある、親しみやすい文章で書く
- エステの魅力（リラクゼーション・疲労回復・癒し）を自然に訴求する
- 過度な性的表現・過激な表現は避ける
- 読者が来店したくなる、温かみのある言葉を選ぶ
- 絵文字は1〜3個程度に抑えて上品さを保つ

【写メ日記】
キャストが個人ブログ感覚で書く日記。日常・趣味・施術への想いを交えながら来店を促す。
300〜400文字程度、タイトルも付ける。

【ニュース】
店舗からのお知らせ。新メニュー・キャンペーン・季節のご挨拶など。
200〜300文字程度、簡潔で読みやすく。

【出勤コメント】
キャストが本日の出勤を知らせる短いメッセージ。
80〜120文字程度、明るく元気よく。
"""


def _call_api(client: anthropic.Anthropic, content_type: str, analysis: dict[str, Any]) -> str:
    ranking_summary = (
        f"おもてなし24h: {analysis['current']['omotenashi_24h']}位（{analysis['trends']['omotenashi_24h']['trend']}）、"
        f"お店24h: {analysis['current']['omise_24h']}位（{analysis['trends']['omise_24h']['trend']}）"
    )
    recommendations = "\n".join(f"- {r}" for r in analysis["recommendations"])

    prompts = {
        "写メ日記": f"""本日（{analysis['date']}）の写メ日記を1件書いてください。

現在のランキング状況:
{ranking_summary}

改善推奨事項:
{recommendations}

【出力形式】
タイトル: （タイトルをここに）
本文:
（本文をここに）
""",
        "ニュース": f"""本日（{analysis['date']}）の店舗ニュースを1件書いてください。

現在のランキング状況:
{ranking_summary}

改善推奨事項:
{recommendations}

ランキング状況を踏まえ、来店を後押しする旬なお知らせを作成してください。
""",
        "出勤コメント": f"""本日（{analysis['date']}）の出勤コメントを1件書いてください。

現在のランキング状況:
{ranking_summary}

元気よく、来店を誘うコメントにしてください（80〜120文字）。
""",
    }

    user_message = prompts[content_type]
    logger.info(f"[Writer] {content_type} 生成中...")

    response = client.messages.create(
        model=MODEL,
        max_tokens=1024,
        system=[
            {
                "type": "text",
                "text": SYSTEM_PROMPT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[{"role": "user", "content": user_message}],
    )

    text = response.content[0].text
    cache_info = response.usage
    logger.info(
        f"[Writer] {content_type} 完了 "
        f"(入力:{cache_info.input_tokens}, "
        f"キャッシュ作成:{getattr(cache_info, 'cache_creation_input_tokens', 0)}, "
        f"キャッシュ読取:{getattr(cache_info, 'cache_read_input_tokens', 0)}, "
        f"出力:{cache_info.output_tokens})"
    )
    return text


def generate(analysis: dict[str, Any]) -> dict[str, str]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise EnvironmentError("ANTHROPIC_API_KEY 環境変数が設定されていません")

    client = anthropic.Anthropic(api_key=api_key)

    contents = {}
    for content_type in ("写メ日記", "ニュース", "出勤コメント"):
        contents[content_type] = _call_api(client, content_type, analysis)

    logger.info("[Writer] 全コンテンツ生成完了")
    return contents
