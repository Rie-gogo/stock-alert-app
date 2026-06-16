/**
 * run_sim_debug.ts
 * realSimulation.ts の generateRealDailyReport を直接実行してデバッグ
 */
import { generateRealDailyReport } from "./server/realSimulation";

async function main() {
  const dates = ["2026-06-11", "2026-06-12"];
  let totalProfit = 0;

  for (const dateStr of dates) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`  ${dateStr} シミュレーション開始`);
    console.log(`${"=".repeat(60)}`);

    try {
      const result = await generateRealDailyReport(dateStr);
      if (!result) {
        console.log(`  結果なし`);
        continue;
      }

      // デバッグ: 戻り値の構造を確認
      console.log(`\n  [DEBUG] 戻り値キー: ${Object.keys(result).join(", ")}`);

      const totalTrades = (result.totalWinCount ?? 0) + (result.totalLossCount ?? 0);
      const winRate = totalTrades > 0 ? (result.totalWinCount ?? 0) / totalTrades : 0;
      const profit = result.totalProfitAmount ?? 0;

      console.log(`\n  日別集計:`);
      console.log(`  取引件数: ${totalTrades}回  勝率: ${(winRate * 100).toFixed(1)}%`);
      const profitStr = profit >= 0 ? `+${profit.toLocaleString()}` : profit.toLocaleString();
      console.log(`  総損益: ${profitStr}円`);
      totalProfit += profit;

      if (result.stockReports) {
        console.log(`\n  銘柄別結果:`);
        for (const sr of result.stockReports) {
          const p = sr.profitAmount ?? 0;
          const pStr = p >= 0 ? `+${p.toLocaleString()}` : p.toLocaleString();
          const tc = (sr.tradesCount ?? 0);
          console.log(`    ${sr.name ?? sr.symbol}: ${pStr}円 (${sr.winCount ?? 0}勝${sr.lossCount ?? 0}敗, ${tc}取引)`);
        }
      }

      // デバッグ: 取引なし銘柄の詳細
      if (result.stockReports) {
        const noTrade = result.stockReports.filter((sr: any) => ((sr.winCount ?? 0) + (sr.lossCount ?? 0)) === 0);
        if (noTrade.length > 0) {
          console.log(`\n  ⚠️  取引なし銘柄: ${noTrade.map((s: any) => s.name ?? s.symbol).join(", ")}`);
        }
      }
    } catch (err) {
      console.error(`  エラー: ${err}`);
    }
  }

  const totalStr = totalProfit >= 0 ? `+${totalProfit.toLocaleString()}` : totalProfit.toLocaleString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  2日間合計損益: ${totalStr}円`);
  console.log(`${"=".repeat(60)}`);
}

main().catch(console.error);
