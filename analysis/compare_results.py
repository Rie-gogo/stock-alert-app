"""
改善前後のバックテスト結果を比較するスクリプト
改善前: by_reason.csv の手動記録値
改善後: 現在の jq_out/by_reason.csv
"""

# ===== 改善前（変更前のバックテスト結果）=====
before = {
    "total_profit": -60450,  # 改善前の総損益（前回バックテスト値）
    "avg_per_day": -1008,
    "win_rate": 0.494,
    "pos_days": 27,
    "neg_days": 33,
    "days_over_15k": 16,
    "traded_days": 60,
    "reasons": {
        "空売り買い戻し: ゴールデンクロス": {"profit": -491700, "win": 83, "loss": 250, "count": 333, "winRate": 0.249},
        "引け値強制決済": {"profit": -268850, "win": 18, "loss": 43, "count": 61, "winRate": 0.295},
        "損切り": {"profit": -113850, "win": 0, "loss": 4, "count": 4, "winRate": 0.0},
        "同値損切り": {"profit": -107700, "win": 0, "loss": 10, "count": 10, "winRate": 0.0},  # 近似値
        "空売り同値損切り": {"profit": -37900, "win": 0, "loss": 23, "count": 23, "winRate": 0.0},
        "空売り損切り": {"profit": -29000, "win": 0, "loss": 1, "count": 1, "winRate": 0.0},
        "トレイリング利確": {"profit": 142650, "win": 6, "loss": 0, "count": 6, "winRate": 1.0},
        "RSI買われすぎ+BB上限": {"profit": 260550, "win": 57, "loss": 17, "count": 74, "winRate": 0.770},
        "空売りトレイリング利確": {"profit": 589400, "win": 43, "loss": 0, "count": 43, "winRate": 1.0},
    }
}

# ===== 改善後（現在の jq_out/by_reason.csv から）=====
after = {
    "total_profit": -60650,
    "avg_per_day": -1011,
    "win_rate": 0.594,
    "pos_days": 27,
    "neg_days": 31,
    "days_over_15k": 16,
    "traded_days": 60,
    "reasons": {
        "引け値強制決済": {"profit": -845850, "win": 32, "loss": 102, "count": 134, "winRate": 0.239},
        "空売り損切り": {"profit": -585400, "win": 0, "loss": 21, "count": 21, "winRate": 0.0},
        "同値損切り": {"profit": -107700, "win": 0, "loss": 10, "count": 10, "winRate": 0.0},
        "損切り": {"profit": -86850, "win": 0, "loss": 3, "count": 3, "winRate": 0.0},
        "空売り同値損切り": {"profit": -36600, "win": 0, "loss": 29, "count": 29, "winRate": 0.0},
        "トレイリング利確": {"profit": 142650, "win": 6, "loss": 0, "count": 6, "winRate": 1.0},
        "RSI買われすぎ+BB上限": {"profit": 245900, "win": 54, "loss": 16, "count": 70, "winRate": 0.771},
        "空売り買い戻し: ゴールデンクロス": {"profit": 486550, "win": 121, "loss": 0, "count": 121, "winRate": 1.0},
        "空売りトレイリング利確": {"profit": 726650, "win": 53, "loss": 1, "count": 54, "winRate": 0.981},
    }
}

print("=" * 70)
print("J-Quants 60営業日バックテスト 改善前後比較")
print("=" * 70)

print("\n【全体サマリー】")
print(f"{'指標':<25} {'改善前':>12} {'改善後':>12} {'変化':>12}")
print("-" * 65)
print(f"{'総損益':<25} {before['total_profit']:>12,} {after['total_profit']:>12,} {after['total_profit']-before['total_profit']:>+12,}")
print(f"{'日平均損益':<25} {before['avg_per_day']:>12,} {after['avg_per_day']:>12,} {after['avg_per_day']-before['avg_per_day']:>+12,}")
print(f"{'勝率（取引ベース）':<22} {before['win_rate']*100:>11.1f}% {after['win_rate']*100:>11.1f}% {(after['win_rate']-before['win_rate'])*100:>+11.1f}%")
print(f"{'プラス日数':<25} {before['pos_days']:>12} {after['pos_days']:>12} {after['pos_days']-before['pos_days']:>+12}")
print(f"{'マイナス日数':<25} {before['neg_days']:>12} {after['neg_days']:>12} {after['neg_days']-before['neg_days']:>+12}")
print(f"{'15,000円超え日数':<23} {before['days_over_15k']:>12} {after['days_over_15k']:>12} {after['days_over_15k']-before['days_over_15k']:>+12}")

print("\n【決済理由別損益比較】（改善前→改善後）")
print(f"{'決済理由':<35} {'改善前損益':>12} {'改善後損益':>12} {'変化':>12} {'改善前勝率':>10} {'改善後勝率':>10}")
print("-" * 95)

all_reasons = set(list(before["reasons"].keys()) + list(after["reasons"].keys()))
for reason in sorted(all_reasons, key=lambda r: before["reasons"].get(r, {}).get("profit", 0)):
    b = before["reasons"].get(reason, {"profit": 0, "winRate": 0, "count": 0})
    a = after["reasons"].get(reason, {"profit": 0, "winRate": 0, "count": 0})
    delta = a["profit"] - b["profit"]
    marker = " ★" if abs(delta) > 100000 else ""
    print(f"{reason:<35} {b['profit']:>12,} {a['profit']:>12,} {delta:>+12,}  {b['winRate']*100:>8.1f}%  {a['winRate']*100:>8.1f}%{marker}")

print("\n【分析・考察】")
gc_before = before["reasons"]["空売り買い戻し: ゴールデンクロス"]
gc_after = after["reasons"]["空売り買い戻し: ゴールデンクロス"]
print(f"✅ GCカバー改善: {gc_before['profit']:,}円(勝率{gc_before['winRate']*100:.0f}%) → {gc_after['profit']:,}円(勝率{gc_after['winRate']*100:.0f}%)")
print(f"   取引回数: {gc_before['count']}回 → {gc_after['count']}回（{gc_after['count']-gc_before['count']:+d}回）")

eod_before = before["reasons"]["引け値強制決済"]
eod_after = after["reasons"]["引け値強制決済"]
print(f"⚠️  引け値強制決済: {eod_before['profit']:,}円(勝率{eod_before['winRate']*100:.0f}%) → {eod_after['profit']:,}円(勝率{eod_after['winRate']*100:.0f}%)")
print(f"   取引回数: {eod_before['count']}回 → {eod_after['count']}回（{eod_after['count']-eod_before['count']:+d}回）")

short_stop_before = before["reasons"]["空売り損切り"]
short_stop_after = after["reasons"]["空売り損切り"]
print(f"⚠️  空売り損切り: {short_stop_before['profit']:,}円({short_stop_before['count']}回) → {short_stop_after['profit']:,}円({short_stop_after['count']}回)")

print("\n【結論】")
print("GCカバーの勝率は25%→100%に改善されたが、")
print("GCで決済しなくなった分のポジションが引け値強制決済・空売り損切りに流れ、")
print("総損益はほぼ変わらず（-60,450円 → -60,650円）。")
print("→ 根本的な問題は「ショートエントリーの質」にある可能性が高い。")
print("  ゴールデンクロスが来るということは、エントリー時点で既にトレンドが")
print("  反転しかけていた（= 悪いタイミングでのショートエントリー）。")
print("  次の改善方向: ショートエントリー条件をさらに厳格化する")
print("  （例: ゴールデンクロス直後のショートを禁止、MA5/MA25の乖離率に閾値を設ける）")
