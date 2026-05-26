"""
reporter.py – 分析結果 + 生成コンテンツ → today_report.md に書き出す
"""
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

OUTPUT_DIR = Path(__file__).parent.parent / "reports"


def report(analysis: dict[str, Any], contents: dict[str, str]) -> Path:
    OUTPUT_DIR.mkdir(exist_ok=True)
    output_path = OUTPUT_DIR / f"{analysis['date']}_report.md"

    cur = analysis["current"]
    trends = analysis["trends"]
    comp = analysis.get("competitors", {})

    def arrow(t: str) -> str:
        return {"改善中": "↑", "悪化中": "↓", "横ばい": "→"}.get(t, "")

    lines = [
        f"# KYOUKANO NAGOYA 日次レポート — {analysis['date']}",
        "",
        "## KYOUKANO 現在のランキング",
        "",
        "| 指標 | 順位 | トレンド |",
        "|------|------|----------|",
        f"| おもてなし 24h | {cur['omotenashi_24h']}位 | {arrow(trends['omotenashi_24h']['trend'])} {trends['omotenashi_24h']['trend']} |",
        f"| おもてなし 週間 | {cur['omotenashi_week']}位 | {arrow(trends['omotenashi_week']['trend'])} {trends['omotenashi_week']['trend']} |",
        f"| お店 24h | {cur['omise_24h']}位 | {arrow(trends['omise_24h']['trend'])} {trends['omise_24h']['trend']} |",
        f"| お店 週間 | {cur['omise_week']}位 | {arrow(trends['omise_week']['trend'])} {trends['omise_week']['trend']} |",
        "",
    ]

    # KYOUKANO 自店メトリクス
    km = comp.get("kyoukano_metrics", {})
    if km:
        lines += [
            "## KYOUKANO サイトメトリクス",
            "",
            f"- チェック数: {km.get('check_count', 'N/A')}人",
            f"- 写メ日記: {km.get('nikki_count', 'N/A')}件",
            f"- ニュース: {km.get('news_count', 'N/A')}件",
            f"- 口コミ: {km.get('review_count', 'N/A')}件",
            "",
        ]

    # 順位推移
    history = comp.get("rank_history", [])
    if len(history) >= 2:
        lines += ["## お店順位 推移（直近）", ""]
        lines += ["| 日付 | お店24h順位 | おもてなし24h順位 |",
                  "|------|------------|----------------|"]
        for h in history[-7:]:
            om = h.get("omotenashi_rank") or "圏外"
            lines.append(f"| {h['date']} | {h.get('omise_rank') or '-'}位 | {om} |")
        lines.append("")

    # 競合インサイト
    insights = comp.get("insights", [])
    if insights:
        lines += ["## 競合インサイト", ""]
        for ins in insights:
            lines.append(f"- {ins}")
        lines.append("")

    # 上位店メトリクス
    top = comp.get("top_stores", [])
    if top:
        lines += ["## 競合上位店メトリクス（本日）", ""]
        lines += ["| カテゴリ | 順位 | 店舗名 | チェック数 | 写メ日記 | ニュース | 口コミ |",
                  "|---------|------|--------|----------|---------|---------|-------|"]
        for s in top:
            cat = "おもてなし" if s["category"] == "omotenashi" else "お店"
            lines.append(
                f"| {cat} | {s['rank']}位 | {s['name']} "
                f"| {s.get('check_count', '-')} "
                f"| {s.get('nikki_count', '-')} "
                f"| {s.get('news_count', '-')} "
                f"| {s.get('review_count', '-')} |"
            )
        lines.append("")

    # 改善推奨事項
    lines += ["## 改善推奨事項", ""]
    for rec in analysis["recommendations"]:
        lines.append(f"- {rec}")
    lines.append("")

    # AI生成コンテンツ
    if contents:
        lines += ["---", "", "## 今日の投稿コンテンツ", ""]
        for content_type, text in contents.items():
            lines += [f"### {content_type}", "", text.strip(), ""]

    output_path.write_text("\n".join(lines), encoding="utf-8")
    logger.info(f"[Reporter] レポート保存: {output_path}")
    return output_path
