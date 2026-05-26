#!/usr/bin/env python3
"""
orchestrator.py – KYOUKANO NAGOYA estama.jp ランキング監視・改善支援

使い方:
  python orchestrator.py --rank 118              # 今日の実行（管理画面のお店24h順位を入力）
  python orchestrator.py --rank 118 --date 2026-05-23
  python orchestrator.py --rank 118 --no-scrape  # スクレイプをスキップ（高速確認用）
  python orchestrator.py --rank 118 --no-writer  # APIキーなしでも動作
"""
import argparse
import json
import logging
import sys
from datetime import date
from pathlib import Path

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger(__name__)

RANKING_JSON = Path(__file__).parent / "data" / "ranking.json"


def _save_rank_to_history(date_str: str, omise_rank: int) -> None:
    """管理画面から入力した順位を ranking.json に追記する"""
    data = json.loads(RANKING_JSON.read_text(encoding="utf-8"))
    records = data["records"]

    existing = next((r for r in records if r["date"] == date_str), None)
    if existing:
        existing["omise_24h"] = omise_rank
        logger.info(f"[Orchestrator] 既存レコードを更新: {date_str} omise_24h={omise_rank}")
    else:
        # 直前のレコードから週間値を引き継ぐ（暫定値）
        prev = records[-1] if records else {}
        new_record = {
            "date": date_str,
            "omotenashi_24h": prev.get("omotenashi_24h", 0),
            "omotenashi_week": prev.get("omotenashi_week", 0),
            "omise_24h": omise_rank,
            "omise_week": prev.get("omise_week", 0),
        }
        records.append(new_record)
        logger.info(f"[Orchestrator] 新レコード追加: {date_str}")

    RANKING_JSON.write_text(
        json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="KYOUKANO NAGOYA 日次ランキング監視")
    parser.add_argument("--rank", type=int, required=True,
                        help="管理画面の「お店 24h ランキング」順位（例: 118）")
    parser.add_argument("--date", default="today",
                        help="対象日 today または YYYY-MM-DD")
    parser.add_argument("--no-scrape", action="store_true",
                        help="競合スクレイプをスキップ")
    parser.add_argument("--no-writer", action="store_true",
                        help="AIコンテンツ生成をスキップ")
    args = parser.parse_args()

    target_date = date.today().isoformat() if args.date == "today" else args.date
    logger.info(f"=== KYOUKANO 日次レポート開始: {target_date} お店{args.rank}位 ===")

    # Step 0: 順位を履歴に記録
    _save_rank_to_history(target_date, args.rank)

    # Step 1: 競合スクレイプ
    if not args.no_scrape:
        from agents.scraper import run as scrape
        try:
            scrape(target_date, args.rank)
        except Exception as e:
            logger.error(f"[Orchestrator] スクレイプ失敗（スキップして続行）: {e}")
    else:
        logger.info("[Orchestrator] スクレイプスキップ")

    # Step 2: 分析
    from agents.analyst import analyze
    analysis = analyze(target_date)
    logger.info(
        f"[Orchestrator] 分析完了 — "
        f"お店24h: {analysis['current']['omise_24h']}位 "
        f"おもてなし24h: {analysis['current']['omotenashi_24h']}位"
    )

    # Step 3: AIコンテンツ生成（オプション）
    contents: dict = {}
    if not args.no_writer:
        import os
        if os.environ.get("ANTHROPIC_API_KEY"):
            from agents.writer import generate
            try:
                contents = generate(analysis)
            except Exception as e:
                logger.error(f"[Orchestrator] コンテンツ生成失敗: {e}")
        else:
            logger.info("[Orchestrator] ANTHROPIC_API_KEY未設定 → コンテンツ生成スキップ")

    # Step 4: レポート出力
    from agents.reporter import report
    report_path = report(analysis, contents)
    logger.info(f"=== 完了: {report_path} ===")

    print(f"\nレポート → {report_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
