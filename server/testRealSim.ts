/**
 * 本日の実データシミュレーションテスト
 * 実行: npx tsx server/testRealSim.ts
 */
import { generateRealDailyReport } from "./realSimulation";

async function main() {
  const today = new Date();
  const dateStr = today.toISOString().slice(0, 10);

  console.log("=== 実データシミュレーション テスト ===");
  console.log(`日付: ${dateStr}`);
  console.log(`現在時刻: ${new Date().toISOString()} (UTC)`);
  console.log("");

  const result = await generateRealDailyReport(dateStr, 70, 30, 1.5);

  console.log("\n=== 結果 ===");
  console.log(`実データ使用: ${result.isRealData} (${result.realDataCount}/10銘柄)`);
  console.log(`総合損益: ${result.totalProfitAmount.toLocaleString()}円`);
  console.log(`全体勝率: ${(result.overallWinRate * 100).toFixed(1)}%`);
  console.log(`総取引数: ${result.totalWinCount + result.totalLossCount}回 (勝:${result.totalWinCount} 負:${result.totalLossCount})`);
  console.log("");
  console.log("=== 銘柄別結果 ===");
  for (const r of result.stockReports) {
    const isReal = (r as { isRealData?: boolean }).isRealData;
    const dataTag = isReal ? "[実データ]" : "[架空]";
    const sign = r.profitAmount >= 0 ? "+" : "";
    console.log(`${dataTag} ${r.name}(${r.symbol}): ${sign}${r.profitAmount.toLocaleString()}円 | 勝率${(r.winRate * 100).toFixed(0)}% | ${r.tradesCount}回取引`);
  }
}

main().catch(console.error);
