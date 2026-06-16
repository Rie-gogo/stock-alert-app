/**
 * debug_old_conditions.ts
 * 旧コード（fb1f5ba）と同じ条件で6/11・6/12をシミュレーション
 * 主な変更: afternoonReentryEnabled=true（午後エントリー許可）
 */

import { generateRealDailyReport, LUNCH_EXIT_ALL_MINUTE, SHORT_STOP_LOSS_PERCENT } from "./server/realSimulation";

async function simulateDay(dateStr: string) {
  console.log(`\n=== ${dateStr} シミュレーション（旧コード条件：午後エントリー許可） ===`);
  
  const result = await generateRealDailyReport(
    dateStr,
    70,   // rsiUpper
    30,   // rsiLower
    2.0,  // stopLossPercent
    {
      shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
      lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
      afternoonReentryEnabled: true,  // ← 旧コードと同じ：午後エントリー許可
    }
  );
  
  console.log(`総損益: ${result.totalProfitAmount >= 0 ? "+" : ""}${result.totalProfitAmount.toLocaleString()}円`);
  console.log(`取引合計: ${result.totalWinCount + result.totalLossCount}回 (勝:${result.totalWinCount} 負:${result.totalLossCount})`);
  
  for (const sr of result.stockReports) {
    const trades = sr.tradesCount ?? 0;
    const profit = sr.profitAmount ?? 0;
    if (trades > 0 || profit !== 0) {
      console.log(`  ${sr.name}: ${trades}回取引, ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円`);
      if (sr.signals && sr.signals.length > 0) {
        for (const sig of sr.signals) {
          console.log(`    ${sig.time} ${sig.type} ${sig.price}円 - ${sig.reason}`);
        }
      }
    }
  }
  
  return result.totalProfitAmount;
}

async function main() {
  const day1 = await simulateDay("2026-06-11");
  const day2 = await simulateDay("2026-06-12");
  
  console.log(`\n=== 2日間合計 ===`);
  console.log(`6/11: ${day1 >= 0 ? "+" : ""}${day1.toLocaleString()}円`);
  console.log(`6/12: ${day2 >= 0 ? "+" : ""}${day2.toLocaleString()}円`);
  console.log(`合計: ${(day1 + day2) >= 0 ? "+" : ""}${(day1 + day2).toLocaleString()}円`);
}

main().catch(console.error);
