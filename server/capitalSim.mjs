import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });
const allSorted = trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));

// 証拠金990万円（現物300万×信用3.3倍）
// 1銘柄投資額 = 270万円（LOT_RATIO=0.9 × 300万円）
// 最大同時ポジション数 = floor(990万 / 270万) = 3銘柄
// ただし、高額株は1回の投資額が270万円を超えるため除外が必要

// 各銘柄の1回あたり投資額を計算（エントリー価格×株数）
const entryTrades = allSorted.filter(t => t.pnl === null);
const symbolInvestment = new Map();
for (const t of entryTrades) {
  const inv = Number(t.price) * Number(t.shares);
  if (!symbolInvestment.has(t.symbol)) {
    symbolInvestment.set(t.symbol, []);
  }
  symbolInvestment.get(t.symbol).push(inv);
}

console.log("=== 銘柄別 1回あたり投資額（平均） ===");
const symbolAvgInv = [];
for (const [sym, invs] of symbolInvestment.entries()) {
  const avg = invs.reduce((a,b)=>a+b,0)/invs.length;
  symbolAvgInv.push({ sym, avg, count: invs.length });
}
symbolAvgInv.sort((a,b) => b.avg - a.avg);
for (const { sym, avg, count } of symbolAvgInv) {
  const flag = avg > 9_900_000 ? " ⚠️超過" : avg > 5_000_000 ? " ⚠️高額" : "";
  console.log(`  ${sym}: ${Math.round(avg/10000)}万円 (${count}件)${flag}`);
}

// 証拠金990万円で取引可能な銘柄のみ（1回投資額が990万円以下）
const MARGIN_LIMIT = 9_900_000;
const eligibleSymbols = new Set(
  symbolAvgInv.filter(s => s.avg <= MARGIN_LIMIT).map(s => s.sym)
);
const excludedSymbols = new Set(
  symbolAvgInv.filter(s => s.avg > MARGIN_LIMIT).map(s => s.sym)
);
console.log(`\n証拠金990万円で取引可能: ${eligibleSymbols.size}銘柄`);
console.log(`除外（投資額超過）: ${[...excludedSymbols].join(', ')}`);

// 最大同時ポジション数制限シミュレーション
// 損切り率は0.5%（新設定）で再計算
const STOP_LOSS = 0.005; // 0.5%

function simulateWithMaxPositions(maxPos, label) {
  const openPos = new Map(); // symbol -> entry trade
  const skipped = new Set();
  let pnl = 0, wins = 0, losses = 0, trades_count = 0;
  let maxSimultaneous = 0;
  
  for (const t of allSorted) {
    // 証拠金超過銘柄は除外
    if (excludedSymbols.has(t.symbol)) continue;
    
    if (t.pnl === null) {
      // エントリー
      if (openPos.size < maxPos) {
        openPos.set(t.symbol, t);
        skipped.delete(t.symbol);
        maxSimultaneous = Math.max(maxSimultaneous, openPos.size);
      } else {
        skipped.add(t.symbol);
      }
    } else {
      // 決済
      if (openPos.has(t.symbol)) {
        const entry = openPos.get(t.symbol);
        const entryPrice = Number(entry.price);
        const shares = Number(entry.shares);
        const exitPnl = Number(t.pnl);
        
        // 損切り0.5%で再計算
        let adjustedPnl;
        if (exitPnl < 0) {
          // 損切り: 0.5%で再計算
          adjustedPnl = -(entryPrice * shares * STOP_LOSS);
        } else {
          adjustedPnl = exitPnl; // 利確はそのまま
        }
        
        pnl += adjustedPnl;
        trades_count++;
        if (adjustedPnl > 0) wins++;
        else losses++;
        openPos.delete(t.symbol);
      }
      skipped.delete(t.symbol);
    }
  }
  
  const winRate = trades_count > 0 ? (wins/trades_count*100).toFixed(1) : "0.0";
  const maxInv = maxPos * 2_700_000; // 最大同時投資額
  console.log(`\n--- ${label} (最大${maxPos}銘柄同時, 最大投資額${(maxInv/10000).toFixed(0)}万円) ---`);
  console.log(`  損益: ${pnl >= 0 ? '+' : ''}${Math.round(pnl).toLocaleString()}円`);
  console.log(`  取引数: ${trades_count}件 (勝${wins}/負${losses})`);
  console.log(`  勝率: ${winRate}%`);
  console.log(`  実際の最大同時保有: ${maxSimultaneous}銘柄`);
  console.log(`  証拠金990万円に対する最大使用率: ${(maxPos * 2_700_000 / 9_900_000 * 100).toFixed(0)}%`);
  return { pnl, trades_count, wins, losses, maxSimultaneous };
}

console.log("\n=== 証拠金990万円（現物300万×信用3.3倍）シミュレーション ===");
console.log("損切り率: 0.5%（新設定）");
console.log("1銘柄投資額: 270万円（LOT_RATIO=0.9×300万円）");

simulateWithMaxPositions(3, "3銘柄制限");
simulateWithMaxPositions(5, "5銘柄制限");
simulateWithMaxPositions(10, "10銘柄制限");

// 参考: 現在（制限なし、損切り0.5%）
let pnlUnlimited = 0, winsU = 0, lossesU = 0, tradesU = 0;
const entryMapU = new Map();
for (const t of allSorted) {
  if (excludedSymbols.has(t.symbol)) continue;
  if (t.pnl === null) {
    entryMapU.set(t.symbol, t);
  } else {
    const entry = entryMapU.get(t.symbol);
    if (entry) {
      const ep = Number(entry.price);
      const sh = Number(entry.shares);
      const exitPnl = Number(t.pnl);
      const adj = exitPnl < 0 ? -(ep * sh * STOP_LOSS) : exitPnl;
      pnlUnlimited += adj;
      tradesU++;
      if (adj > 0) winsU++;
      else lossesU++;
      entryMapU.delete(t.symbol);
    }
  }
}
console.log(`\n--- 参考: 制限なし（証拠金超過銘柄除外、損切り0.5%） ---`);
console.log(`  損益: ${pnlUnlimited >= 0 ? '+' : ''}${Math.round(pnlUnlimited).toLocaleString()}円`);
console.log(`  取引数: ${tradesU}件 (勝${winsU}/負${lossesU})`);
console.log(`  勝率: ${(winsU/tradesU*100).toFixed(1)}%`);

