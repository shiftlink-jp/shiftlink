"""
scraper.py – estama.jp 中部ランキングを毎日取得して data/snapshots/ に保存する

取得対象:
  - おもてなしランキング 上位10店
  - お店ランキング 上位10店
  - 各店のチェック数・写メ日記数・ニュース数・口コミ数
"""
import json
import logging
import re
import time
from pathlib import Path
from typing import Any

import requests
from bs4 import BeautifulSoup

logger = logging.getLogger(__name__)

BASE = "https://estama.jp"
AREA = "chubu"
KYOUKANO_ID = "44944"
SNAPSHOTS_DIR = Path(__file__).parent.parent / "data" / "snapshots"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Accept-Language": "ja,en-US;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
}


def _fetch(url: str, delay: float = 1.5) -> BeautifulSoup:
    time.sleep(delay)
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return BeautifulSoup(resp.text, "html.parser")


def _fetch_raw(url: str, delay: float = 1.5) -> str:
    time.sleep(delay)
    resp = requests.get(url, headers=HEADERS, timeout=15)
    resp.raise_for_status()
    resp.encoding = resp.apparent_encoding or "utf-8"
    return resp.text


# ─────────────────────────────────────────
# ランキングページのパース
# ─────────────────────────────────────────

def _shops_from_html(html: str) -> list[dict]:
    """
    HTML文字列からショップリンクを出現順に抽出し 1始まりの連番ランクを付ける。
    - 相対パス /shop/XXXXX/ および フルURL https://estama.jp/shop/XXXXX/ に対応
    - ID が 10000 未満はエリアフィルタ等の偽リンクなのでスキップ
    - 店名が空のリンク（画像リンク等）はスキップし、名前付きリンクを優先
    """
    soup = BeautifulSoup(html, "html.parser")

    # shop_id -> name の辞書（名前付きリンクで上書き）
    shop_names: dict[str, str] = {}
    shop_order: list[str] = []  # 出現順

    for a in soup.find_all("a", href=re.compile(r"/shop/\d+/")):
        m = re.search(r"/shop/(\d+)/", a["href"])
        if not m:
            continue
        shop_id = m.group(1)
        if int(shop_id) < 10000:  # エリアフィルタ等の偽IDをスキップ
            continue
        name = a.get_text(strip=True)
        if shop_id not in shop_names:
            shop_order.append(shop_id)
            shop_names[shop_id] = name
        elif name:  # 名前付きリンクで上書き
            shop_names[shop_id] = name

    shops = []
    for i, shop_id in enumerate(shop_order):
        shops.append({
            "rank": i + 1,
            "id": shop_id,
            "name": shop_names[shop_id],
            "url": f"{BASE}/shop/{shop_id}/",
        })
    return shops


def _cut_section(full_html: str, start_kw: str, end_kw) -> str:
    """
    full_html から start_kw を含み、かつ直後 4000 文字以内に /shop/XXXXX/ リンクが
    存在する最初の箇所を見つけ、end_kw の直前までの HTML を返す。
    ナビゲーション等に同じキーワードが出てもショップリンクがなければスキップする。
    """
    pos = 0
    while True:
        idx = full_html.find(start_kw, pos)
        if idx == -1:
            return ""
        # 直後にショップリンクがあるか確認
        if re.search(r"/shop/\d+/", full_html[idx: idx + 4000]):
            end_idx = len(full_html)
            if end_kw:
                # end_kw もショップリンクを持つ位置を終端とする
                e_pos = idx + len(start_kw)
                while True:
                    e_idx = full_html.find(end_kw, e_pos)
                    if e_idx == -1:
                        break
                    if re.search(r"/shop/\d+/", full_html[e_idx: e_idx + 4000]):
                        end_idx = e_idx
                        break
                    e_pos = e_idx + 1
            return full_html[idx:end_idx]
        pos = idx + 1


def get_rankings() -> dict[str, list]:
    """おもてなし・お店 の専用ランキングページをそれぞれ取得する"""
    logger.info("[Scraper] ランキングページ取得中...")

    # おもてなし・お店は専用サブページが存在する
    pages = {
        "omotenashi": f"{BASE}/{AREA}/ranking/service/",
        "omise":      f"{BASE}/{AREA}/ranking/shop/",
    }

    result: dict[str, list] = {}
    for key, url in pages.items():
        try:
            html = _fetch_raw(url)
            shops = _shops_from_html(html)[:10]
            result[key] = shops
            logger.info(f"[Scraper] {url}: {len(shops)}店 取得")
        except Exception as e:
            logger.warning(f"[Scraper] {url} 取得失敗: {e}")
            result[key] = []

    logger.info(
        f"[Scraper] おもてなし {len(result['omotenashi'])}店 / "
        f"お店 {len(result['omise'])}店 取得完了"
    )
    return result


# ─────────────────────────────────────────
# 個店メトリクスの取得
# ─────────────────────────────────────────

def _get_check_count(shop_id: str) -> int:
    try:
        soup = _fetch(f"{BASE}/shop/{shop_id}/", delay=1.0)
        m = re.search(r"([\d,]+)\s*人がこのお店をチェック", soup.get_text())
        return int(m.group(1).replace(",", "")) if m else 0
    except Exception as e:
        logger.warning(f"[Scraper] チェック数取得失敗 {shop_id}: {e}")
        return -1


def _get_list_count(url: str) -> int:
    """newslist / bloglist / reviewlist から総件数を取得する"""
    try:
        soup = _fetch(url, delay=1.0)
        text = soup.get_text()
        for pat in [r"全\s*([\d,]+)\s*件", r"([\d,]+)\s*件"]:
            m = re.search(pat, text)
            if m:
                return int(m.group(1).replace(",", ""))
        return 0
    except Exception as e:
        logger.warning(f"[Scraper] 件数取得失敗 {url}: {e}")
        return -1


def get_store_metrics(shop_id: str) -> dict[str, int]:
    """1店舗のチェック数・写メ日記数・ニュース数・口コミ数を取得する"""
    logger.info(f"[Scraper] メトリクス取得: shop/{shop_id}")
    return {
        "check_count":  _get_check_count(shop_id),
        "nikki_count":  _get_list_count(f"{BASE}/shop/{shop_id}/bloglist/"),
        "news_count":   _get_list_count(f"{BASE}/shop/{shop_id}/newslist/"),
        "review_count": _get_list_count(f"{BASE}/shop/{shop_id}/reviewlist/"),
    }


# ─────────────────────────────────────────
# メインエントリ
# ─────────────────────────────────────────

def run(date_str: str, kyoukano_rank: int) -> dict[str, Any]:
    """
    ランキング取得・メトリクス収集 → data/snapshots/YYYY-MM-DD.json に保存
    kyoukano_rank: 管理画面の「お店24h順位」を手動入力
    """
    SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)
    out_path = SNAPSHOTS_DIR / f"{date_str}.json"

    rankings = get_rankings()

    # 上位5店 + KYOUKANO のメトリクスを収集
    target_ids: set[str] = set()
    for stores in rankings.values():
        for s in stores[:5]:
            target_ids.add(s["id"])
    target_ids.add(KYOUKANO_ID)

    metrics: dict[str, dict] = {}
    for shop_id in sorted(target_ids):
        metrics[shop_id] = get_store_metrics(shop_id)

    # KYOUKANO のおもてなし順位（公開ページに載っていれば）
    kyoukano_omotenashi_rank: int | None = None
    for s in rankings.get("omotenashi", []):
        if s["id"] == KYOUKANO_ID:
            kyoukano_omotenashi_rank = s["rank"]
            break

    snapshot = {
        "date": date_str,
        "kyoukano": {
            "omise_24h_rank": kyoukano_rank,
            "omotenashi_24h_rank": kyoukano_omotenashi_rank,
            "metrics": metrics.get(KYOUKANO_ID, {}),
        },
        "rankings": rankings,
        "competitor_metrics": {k: v for k, v in metrics.items() if k != KYOUKANO_ID},
    }

    out_path.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2), encoding="utf-8")
    logger.info(f"[Scraper] スナップショット保存: {out_path}")
    return snapshot
