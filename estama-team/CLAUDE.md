# estama-team — estama.jp ランキング改善マルチエージェントチーム

estama.jp（エステ魂）のランキング向上を支援する自動化チームです。
毎日実行することで、ランキントレンドの分析とコンテンツ草稿を自動生成します。

## 構成

```
estama-team/
├── orchestrator.py        # 司令塔（エントリーポイント）
├── agents/
│   ├── analyst.py         # ランキングデータ分析エージェント
│   ├── writer.py          # コンテンツ生成エージェント（Anthropic API）
│   └── reporter.py        # レポート出力エージェント
├── data/
│   └── ranking.json       # ランキング実績データ（手動更新）
├── reports/               # 生成レポート出力先（自動作成）
└── requirements.txt
```

## セットアップ

```bash
cd estama-team
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
```

## 実行

```bash
python orchestrator.py --date today
# または特定日を指定
python orchestrator.py --date 2026-05-22
```

実行後、`reports/YYYY-MM-DD_report.md` にレポートが生成されます。

## エージェントの役割

| エージェント | 役割 |
|---|---|
| **analyst** | `data/ranking.json` を読み込み、トレンド・推奨事項を算出 |
| **writer** | Anthropic API（claude-opus-4-7）で 写メ日記・ニュース・出勤コメント を生成 |
| **reporter** | 分析結果とコンテンツを Markdown レポートにまとめる |

## ランキングデータの更新

`data/ranking.json` に新しい日付のレコードを追加してください:

```json
{"date": "2026-05-23", "omotenashi_24h": 22, "omotenashi_week": 24, "omise_24h": 116, "omise_week": 31}
```

- `omotenashi_24h` / `omotenashi_week`: おもてなし部門の24h順位・週間順位
- `omise_24h` / `omise_week`: お店部門の24h順位・週間順位
- **数値が小さいほど上位（良い）**

## コスト最適化

writer.py はシステムプロンプトに **プロンプトキャッシュ** を適用しています。
3種類のコンテンツ生成で、2回目以降はキャッシュからシステムプロンプトを読み込むため
トークンコストを削減できます。
