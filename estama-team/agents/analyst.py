"""
analyst.py – ranking.json（手動入力）+ スナップショット（スクレイパー）を統合分析する
"""
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DATA_PATH = Path(__file__).parent.parent / "data" / "ranking.json"
SNAPSHOTS_DIR = Path(__file__).parent.parent / "data" / "snapshots"
KYOUKANO_ID = "44944"


# ─────────────────────────────────────────
# 基本ランキングデータ分析（ranking.json）
# ─────────────────────────────────────────

def _load_records() -> list[dict]:
    data = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return data["records"]


def _avg(lst: list[dict], key: str) -> float:
    return sum(r[key] for r in lst) / len(lst) if lst else 0


def _trend(recent: list[dict], older: list[dict], key: str) -> dict:
    r_avg = _avg(recent, key)
    o_avg = _avg(older, key)
    diff = o_avg - r_avg  # 正 = 改善（数値が小さいほど上位）
    label = "改善中" if diff > 1 else "悪化中" if diff < -1 else "横ばい"
    return {"trend": label, "change": round(diff, 1)}


def analyze_kyoukano(date_str: str) -> dict[str, Any]:
    logger.info("[Analyst] KYOUKANO ランキングデータ分析中...")
    records = _load_records()
    if not records:
        raise ValueError("ranking.json にレコードがありません")

    target = next((r for r in records if r["date"] == date_str), records[-1])
    recent = records[-3:] if len(records) >= 3 else records
    older = records[:-3] if len(records) > 3 else records[:1]

    trends = {k: _trend(recent, older, k)
              for k in ("omotenashi_24h", "omotenashi_week", "omise_24h", "omise_week")}

    recommendations = _make_recommendations(trends, target)
    logger.info("[Analyst] KYOUKANO 分析完了")
    return {
        "date": target["date"],
        "current": {k: target[k] for k in
                    ("omotenashi_24h", "omotenashi_week", "omise_24h", "omise_week")},
        "trends": trends,
        "recommendations": recommendations,
    }


def _make_recommendations(trends: dict, current: dict) -> list[str]:
    recs = []
    if trends["omotenashi_24h"]["trend"] == "悪化中":
        recs.append("おもてなし24h順位が悪化中 → 写メ日記・出勤コメントの投稿を促す")
    elif trends["omotenashi_24h"]["trend"] == "改善中":
        recs.append("おもてなし24h順位は改善中 → 現在の投稿ペースを維持する")
    if current["omise_24h"] > 100:
        recs.append(f"お店24h順位 {current['omise_24h']}位 → estama経由予約の導線を強化する")
    elif current["omise_24h"] <= 30:
        recs.append(f"お店24h順位 {current['omise_24h']}位 → 上位をキープ、現状維持")
    if not recs:
        recs.append("全指標横ばい → 施策の効果計測を継続する")
    return recs


# ─────────────────────────────────────────
# 競合スナップショット分析
# ─────────────────────────────────────────

def _load_snapshots(limit: int = 30) -> list[dict]:
    if not SNAPSHOTS_DIR.exists():
        return []
    files = sorted(SNAPSHOTS_DIR.glob("*.json"))[-limit:]
    return [json.loads(f.read_text(encoding="utf-8")) for f in files]


def analyze_competitors(date_str: str) -> dict[str, Any]:
    logger.info("[Analyst] 競合スナップショット分析中...")
    snapshots = _load_snapshots()
    if not snapshots:
        logger.warning("[Analyst] スナップショットなし")
        return {"top_stores": [], "insights": [], "rank_history": []}

    today_snap = next((s for s in snapshots if s["date"] == date_str), snapshots[-1])

    # 上位店のメトリクス一覧
    top_stores = []
    for category in ("omotenashi", "omise"):
        for store in today_snap.get("rankings", {}).get(category, [])[:5]:
            sid = store["id"]
            metrics = today_snap.get("competitor_metrics", {}).get(sid, {})
            top_stores.append({
                "category": category,
                "rank": store["rank"],
                "name": store["name"],
                "id": sid,
                **metrics,
            })

    # KYOUKANO の順位推移（直近スナップショット）
    rank_history = []
    for snap in snapshots[-14:]:
        entry = {
            "date": snap["date"],
            "omise_rank": snap.get("kyoukano", {}).get("omise_24h_rank"),
            "omotenashi_rank": snap.get("kyoukano", {}).get("omotenashi_24h_rank"),
        }
        rank_history.append(entry)

    # 昨日との変化からインサイトを生成
    insights = _generate_insights(snapshots, today_snap)

    logger.info("[Analyst] 競合分析完了")
    return {
        "top_stores": top_stores,
        "rank_history": rank_history,
        "insights": insights,
        "kyoukano_metrics": today_snap.get("kyoukano", {}).get("metrics", {}),
    }


def _generate_insights(snapshots: list[dict], today: dict) -> list[str]:
    """順位変動が大きい店・KYOUKANOの変化からインサイトを生成する"""
    insights = []
    if len(snapshots) < 2:
        return ["データ蓄積中（2日分以上で変化分析が開始されます）"]

    yesterday = snapshots[-2]

    # 順位変動が大きい店を検出
    today_omo = {s["id"]: s["rank"]
                 for s in today.get("rankings", {}).get("omotenashi", [])}
    yest_omo = {s["id"]: s["rank"]
                for s in yesterday.get("rankings", {}).get("omotenashi", [])}

    risers = []
    for sid, rank in today_omo.items():
        prev = yest_omo.get(sid)
        if prev and prev - rank >= 2:
            name = next((s["name"] for s in today["rankings"]["omotenashi"]
                         if s["id"] == sid), sid)
            risers.append((name, prev, rank))

    if risers:
        for name, prev, cur in risers[:3]:
            insights.append(f"🔼 {name} が {prev}位→{cur}位 に急上昇")
    else:
        insights.append("昨日から大きな順位変動なし")

    # KYOUKANO の変化
    today_rank = today.get("kyoukano", {}).get("omise_24h_rank")
    yest_rank = yesterday.get("kyoukano", {}).get("omise_24h_rank")
    if today_rank and yest_rank:
        diff = yest_rank - today_rank  # 正=改善
        if diff >= 3:
            insights.append(f"✅ KYOUKANO お店順位: {yest_rank}位→{today_rank}位 ({diff}位改善)")
        elif diff <= -3:
            insights.append(f"⚠️ KYOUKANO お店順位: {yest_rank}位→{today_rank}位 ({abs(diff)}位悪化)")
        else:
            insights.append(f"KYOUKANO お店順位: {yest_rank}位→{today_rank}位（横ばい）")

    return insights


# ─────────────────────────────────────────
# 統合エントリ
# ─────────────────────────────────────────

def analyze(date_str: str) -> dict[str, Any]:
    """orchestrator から呼ばれるメイン関数"""
    kyoukano = analyze_kyoukano(date_str)
    competitors = analyze_competitors(date_str)
    return {**kyoukano, "competitors": competitors}
