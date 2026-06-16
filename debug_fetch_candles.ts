/**
 * debug_fetch_candles.ts
 * realSimulation.tsのfetchRealCandlesを直接使って
 * 取得されたローソク足の指標値を確認する
 */
import { simulateStockReal, generateRealDailyReport } from "./server/realSimulation";

// fetchRealCandlesはexportされていないので、
// generateRealDailyReportをデバッグモードで実行し、
// stockReportsのtradesCountを確認する

const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY ?? "";

async function main() {
  const dateStr = "2026-06-11";
  console.log(`\n=== generateRealDailyReport デバッグ (${dateStr}) ===`);
  
  const result = await generateRealDailyReport(dateStr, 70, 30, 2.0);
  
  console.log(`\n総損益: ${result.totalProfitAmount >= 0 ? "+" : ""}${result.totalProfitAmount.toLocaleString()}円`);
  console.log(`取引合計: ${result.totalWinCount + result.totalLossCount}回`);
  
  for (const sr of result.stockReports) {
    const trades = sr.tradesCount ?? 0;
    const profit = sr.profitAmount ?? 0;
    console.log(`\n${sr.name} (${sr.symbol}):`);
    console.log(`  取引: ${trades}回, 損益: ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円`);
    console.log(`  signals: ${sr.signals?.length ?? 0}件`);
    
    if (sr.signals && sr.signals.length > 0) {
      for (const sig of sr.signals) {
        console.log(`    ${sig.time} ${sig.type} ${sig.price}円 - ${sig.reason}`);
      }
    }
  }
}

main().catch(console.error);
