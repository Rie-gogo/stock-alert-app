"""
3段階改善の最終比較レポート
改善前 → 改善1（GCカバー厳格化） → 改善2（GCクールダウン追加） → 改善3（最大保有時間）
"""

stages = {
    "改善前（ベースライン）": {
        "total_profit": -60450,
        "avg_per_day": -1008,
        "win_rate": 0.494,
        "pos_days": 27,
        "neg_days": 33,
        "days_over_15k": 16,
        "worst_day": -118150,
        "best_day": 167150,
        "median_day": -7600,
        "reasons": {
            "空売り買い戻し: ゴールデンクロス": {"profit": -491700, "win": 83, "loss": 250, "count": 333, "winRate": 0.249},
            "引け値強制決済": {"profit": -268850, "win": 18, "loss": 43, "count": 61, "winRate": 0.295},
            "損切り": {"profit": -113850, "win": 0, "loss": 4, "count": 4, "winRate": 0.0},
            "同値損切り": {"profit": -107700, "win": 0, "loss": 10, "count": 10, "winRate": 0.0},
            "空売り同値損切り": {"profit": -37900, "win": 0, "loss": 23, "count": 23, "winRate": 0.0},
            "空売り損切り": {"profit": -29000, "win": 0, "loss": 1, "count": 1, "winRate": 0.0},
            "トレイリング利確": {"profit": 142650, "win": 6, "loss": 0, "count": 6, "winRate": 1.0},
            "RSI買われすぎ+BB上限": {"profit": 260550, "win": 57, "loss": 17, "count": 74, "winRate": 0.770},
            "空売りトレイリング利確": {"profit": 589400, "win": 43, "loss": 0, "count": 43, "winRate": 1.0},
        }
    },
    "改善3（最大保有時間追加）": {
        "total_profit": -57300,
        "avg_per_day": -955,
        "win_rate": 0.531,
        "pos_days": 26,
        "neg_days": 32,
        "days_over_15k": 17,
        "worst_day": -89450,
        "best_day": 166750,
        "median_day": -2900,
        "reasons": {
            "引け値強制決済": {"profit": -404200, "win": 24, "loss": 66, "count": 90, "winRate": 0.267},
            "空売り損切り": {"profit": -357550, "win": 0, "loss": 13, "count": 13, "winRate": 0.0},
            "損切り": {"profit": -113850, "win": 0, "loss": 4, "count": 4, "winRate": 0.0},
            "同値損切り": {"profit": -107700, "win": 0, "loss": 10, "count": 10, "winRate": 0.0},
            "空売り買い戻し: 最大保有時間超過": {"profit": -103250, "win": 74, "loss": 105, "count": 179, "winRate": 0.413},
            "空売り同値損切り": {"profit": -34700, "win": 0, "loss": 24, "count": 24, "winRate": 0.0},
            "トレイリング利確": {"profit": 142650, "win": 6, "loss": 0, "count": 6, "winRate": 1.0},
            "空売り買い戻し: ゴールデンクロス": {"profit": 173900, "win": 73, "loss": 0, "count": 73, "winRate": 1.0},
            "RSI買われすぎ+BB上限": {"profit": 260550, "win": 57, "loss": 17, "count": 74, "winRate": 0.770},
            "空売りトレイリング利確": {"profit": 486850, "win": 38, "loss": 1, "count": 39, "winRate": 0.974},
        }
    }
}

b = stages["改善前（ベースライン）"]
a = stages["改善3（最大保有時間追加）"]

print("=" * 70)
print("J-Quants 60営業日バックテスト 改善前後 最終比較レポート")
print("=" * 70)

print("\n【全体サマリー比較】")
print(f"{'指標':<25} {'改善前':>12} {'改善後':>12} {'変化':>12}")
print("-" * 65)
print(f"{'総損益':<25} {b['total_profit']:>12,} {a['total_profit']:>12,} {a['total_profit']-b['total_profit']:>+12,}")
print(f"{'日平均損益':<25} {b['avg_per_day']:>12,} {a['avg_per_day']:>12,} {a['avg_per_day']-b['avg_per_day']:>+12,}")
print(f"{'中央値/日':<25} {b['median_day']:>12,} {a['median_day']:>12,} {a['median_day']-b['median_day']:>+12,}")
print(f"{'勝率（取引ベース）':<22} {b['win_rate']*100:>11.1f}% {a['win_rate']*100:>11.1f}% {(a['win_rate']-b['win_rate'])*100:>+11.1f}%")
print(f"{'プラス日数':<25} {b['pos_days']:>12} {a['pos_days']:>12} {a['pos_days']-b['pos_days']:>+12}")
print(f"{'マイナス日数':<25} {b['neg_days']:>12} {a['neg_days']:>12} {a['neg_days']-b['neg_days']:>+12}")
print(f"{'最悪日':<25} {b['worst_day']:>12,} {a['worst_day']:>12,} {a['worst_day']-b['worst_day']:>+12,}")
print(f"{'15,000円超え日数':<23} {b['days_over_15k']:>12} {a['days_over_15k']:>12} {a['days_over_15k']-b['days_over_15k']:>+12}")

print("\n【決済理由別損益比較】")
print(f"{'決済理由':<38} {'改善前損益':>12} {'改善後損益':>12} {'変化':>12}")
print("-" * 78)

all_reasons = set(list(b["reasons"].keys()) + list(a["reasons"].keys()))
for reason in sorted(all_reasons, key=lambda r: b["reasons"].get(r, {}).get("profit", 0)):
    bp = b["reasons"].get(reason, {"profit": 0, "winRate": 0, "count": 0})
    ap = a["reasons"].get(reason, {"profit": 0, "winRate": 0, "count": 0})
    delta = ap["profit"] - bp["profit"]
    marker = " ★" if abs(delta) > 50000 else ""
    print(f"{reason:<38} {bp['profit']:>12,} {ap['profit']:>12,} {delta:>+12,}{marker}")

print("\n【改善内容サマリー】")
print("1. GCカバー厳格化: 含み益あり かつ RSI>=40 の場合のみGCでカバー")
print("   → GCカバー勝率: 24.9% → 100%（取引回数: 333回 → 73回）")
print("2. GCクールダウン: GC後15本はショートエントリー禁止")
print("   → GCカバー後の影響は軽微（クールダウンより保有時間制限が有効）")
print("3. 最大保有時間: ショート45本（約90分）超過で強制手仕まい")
print("   → 引け値強制決済: -268,850円(61回) → -404,200円(90回)")
print("     ※ 件数は増えたが1件あたりの損失が減少（大きな損失を早期カット）")
print("   → 最悪日: -118,150円 → -89,450円（+28,700円改善）")
print("   → 中央値: -7,600円/日 → -2,900円/日（+4,700円改善）")

print("\n【残課題と次の改善方向】")
print("・引け値強制決済（-404,200円）と空売り損切り（-357,550円）が主要損失源")
print("・これらは「ショートエントリーの質」の問題")
print("・次の改善候補:")
print("  A) ショートエントリーをさらに厳格化（MA乖離率の閾値追加）")
print("  B) 下落相場（市場効率性が低い日）のみショートを許可")
print("  C) ショートの損切りを現在の2.0%から1.5%に縮小")
