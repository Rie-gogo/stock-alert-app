import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });

// ロングのみ・ショートのみでの損益シミュレーション
const closed = trades.filter(t => t.pnl !== null);
const longOnly = closed.filter(t => t.side === "long");
const shortOnly = closed.filter(t => t.side === "short");

const longPnl = longOnly.reduce((s,t) => s + Number(t.pnl), 0);
const shortPnl = shortOnly.reduce((s,t) => s + Number(t.pnl), 0);
const longWins = longOnly.filter(t => Number(t.pnl) > 0).length;
const shortWins = shortOnly.filter(t => Number(t.pnl) > 0).length;

console.log("=== ロングのみの結果 ===");
console.log(`取引数: ${longOnly.length}件`);
console.log(`損益: ${longPnl > 0 ? '+' : ''}${longPnl.toLocaleString()}円`);
console.log(`勝率: ${(longWins/longOnly.length*100).toFixed(1)}% (${longWins}/${longOnly.length})`);

console.log("\n=== ショートのみの結果 ===");
console.log(`取引数: ${shortOnly.length}件`);
console.log(`損益: ${shortPnl > 0 ? '+' : ''}${shortPnl.toLocaleString()}円`);
console.log(`勝率: ${(shortWins/shortOnly.length*100).toFixed(1)}% (${shortWins}/${shortOnly.length})`);

// キオクシア・東京エレクトロン除外シミュレーション
const highPriceSymbols = ["285A", "8035", "6920", "6857"];
const withoutHighPrice = closed.filter(t => !highPriceSymbols.includes(t.symbol));
const withoutHighPricePnl = withoutHighPrice.reduce((s,t) => s + Number(t.pnl), 0);
const withoutHighPriceWins = withoutHighPrice.filter(t => Number(t.pnl) > 0).length;
console.log(`\n=== 高額株(キオクシア・東京エレクトロン・レーザーテック・アドバンテスト)除外 ===`);
console.log(`取引数: ${withoutHighPrice.length}件`);
console.log(`損益: ${withoutHighPricePnl > 0 ? '+' : ''}${withoutHighPricePnl.toLocaleString()}円`);
console.log(`勝率: ${(withoutHighPriceWins/withoutHighPrice.length*100).toFixed(1)}%`);

// 損切り後クールダウン（同銘柄5分間エントリー禁止）シミュレーション
console.log("\n=== 損切り後クールダウン5分シミュレーション ===");
// エントリー取引
const allSorted = trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));
const lastLossTime = {};
let simulatedPnl = 0;
let simulatedWins = 0;
let simulatedLosses = 0;
let skipped = 0;

for (const t of allSorted) {
  if (t.pnl !== null) {
    // 決済
    if (Number(t.pnl) < 0) {
      lastLossTime[t.symbol] = t.tradeTime;
    }
    simulatedPnl += Number(t.pnl);
    if (Number(t.pnl) > 0) simulatedWins++;
    else simulatedLosses++;
  }
  // エントリーはスキップカウントのみ（実際の決済は変わらないため近似）
}

// 実際にはエントリーをスキップした場合の損益を計算
// 損切り後5分以内の再エントリーをスキップした場合
const skippedTrades = [];
const lastLossTimeMap = {};
for (const t of allSorted) {
  if (t.pnl !== null) {
    if (Number(t.pnl) < 0) {
      lastLossTimeMap[t.symbol] = t.tradeTime;
    }
  } else {
    // エントリー
    const lastLoss = lastLossTimeMap[t.symbol];
    if (lastLoss) {
      const lastH = parseInt(lastLoss.slice(0,2));
      const lastM = parseInt(lastLoss.slice(3,5));
      const curH = parseInt((t.tradeTime||"").slice(0,2));
      const curM = parseInt((t.tradeTime||"").slice(3,5));
      const diffMin = (curH * 60 + curM) - (lastH * 60 + lastM);
      if (diffMin <= 5) {
        skippedTrades.push(t);
      }
    }
  }
}
console.log(`スキップされるエントリー: ${skippedTrades.length}件`);
for (const t of skippedTrades.slice(0,10)) {
  console.log(`  ${t.tradeTime} ${t.symbolName} ${t.side}`);
}
