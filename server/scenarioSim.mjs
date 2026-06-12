import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });
const allSorted = trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));
const closed = allSorted.filter(t => t.pnl !== null);

// ① 損切り%を変えた場合のシミュレーション
// 現在の損切り: 0.7%
// 損切りPnL = エントリー価格 × 株数 × (-損切り率)
// 各取引のエントリー価格を逆算する
// 損切り時: exitPrice = entryPrice × (1 - stopLoss) → entryPrice = exitPrice / (1 - stopLoss)
// 利確時: exitPrice = entryPrice × (1 + takeProfit) → entryPrice = exitPrice / (1 + takeProfit)

// まずエントリー取引と決済取引をペアにする
const entryMap = new Map(); // symbol -> entry trade
const pairs = [];

for (const t of allSorted) {
  if (t.pnl === null) {
    // エントリー
    entryMap.set(t.symbol, t);
  } else {
    // 決済
    const entry = entryMap.get(t.symbol);
    if (entry) {
      pairs.push({ entry, exit: t });
      entryMap.delete(t.symbol);
    }
  }
}

console.log(`ペア成立: ${pairs.length}件`);

// 各ペアの実際の損切り率を計算
const stopLossRates = [];
for (const p of pairs) {
  const entryPrice = Number(p.entry.price);
  const exitPrice = Number(p.exit.price);
  const pnl = Number(p.exit.pnl);
  const shares = Number(p.entry.shares);
  const side = p.entry.side;
  
  let actualReturn;
  if (side === "long") {
    actualReturn = (exitPrice - entryPrice) / entryPrice;
  } else {
    actualReturn = (entryPrice - exitPrice) / entryPrice;
  }
  
  if (pnl < 0) {
    stopLossRates.push({ ...p, actualReturn, isLoss: true });
  } else {
    stopLossRates.push({ ...p, actualReturn, isLoss: false });
  }
}

// 損切り取引の実際の損切り率分布
const losses = stopLossRates.filter(p => p.isLoss);
console.log("\n=== 損切り取引の実際の損切り率分布 ===");
const rateBuckets = { "0.0-0.3%": 0, "0.3-0.5%": 0, "0.5-0.7%": 0, "0.7-1.0%": 0, "1.0%超": 0 };
for (const p of losses) {
  const r = Math.abs(p.actualReturn) * 100;
  if (r < 0.3) rateBuckets["0.0-0.3%"]++;
  else if (r < 0.5) rateBuckets["0.3-0.5%"]++;
  else if (r < 0.7) rateBuckets["0.5-0.7%"]++;
  else if (r < 1.0) rateBuckets["0.7-1.0%"]++;
  else rateBuckets["1.0%超"]++;
}
for (const [k,v] of Object.entries(rateBuckets)) {
  console.log(`  ${k}: ${v}件`);
}

// 損切り率を変えた場合の損益シミュレーション
// 損切り率を変えると: 損切り時のPnLが変わる（利確には影響しない）
// ただし損切り率を狭めると、損切りが早くなる → 一部の取引が「損切り→反転利確」になる可能性
// ここでは保守的に「損切り率を変えても取引数は同じ」として計算

console.log("\n=== ① 損切り率変更シミュレーション（本日データ） ===");
const stopLossScenarios = [0.3, 0.5, 0.7, 1.0]; // 現在は0.7%

for (const newStop of stopLossScenarios) {
  let totalPnl = 0;
  let wins = 0;
  let losses_count = 0;
  
  for (const p of stopLossRates) {
    const entryPrice = Number(p.entry.price);
    const shares = Number(p.entry.shares);
    const side = p.entry.side;
    
    if (p.isLoss) {
      // 損切り取引: 新しい損切り率で再計算
      const newLoss = entryPrice * shares * (newStop / 100);
      totalPnl -= newLoss;
      losses_count++;
    } else {
      // 利確取引: そのまま
      totalPnl += Number(p.exit.pnl);
      wins++;
    }
  }
  
  const marker = newStop === 0.7 ? " ← 現在" : "";
  console.log(`損切り${newStop}%: 損益${totalPnl > 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円, 勝${wins}/負${losses_count}${marker}`);
}

// ② 案A,B,Dの本日想定損益
console.log("\n=== ② 案A,B,D の本日想定損益 ===");

// 現在の損益
const currentPnl = closed.reduce((s,t) => s + Number(t.pnl), 0);
console.log(`現在（ベースライン）: ${Math.round(currentPnl).toLocaleString()}円`);

// 案A: 最大同時保有3銘柄制限
// 3銘柄を超えた場合、4銘柄目以降のエントリーをスキップ
// → 対応する決済もスキップ
console.log("\n--- 案A: 最大同時保有3銘柄制限 ---");
const MAX_POS_A = 3;
const openPosA = new Map();
let pnlA = 0;
let tradesA = 0;
let winsA = 0;
let lossesA = 0;
const skippedSymbolsA = new Set();

for (const t of allSorted) {
  if (t.pnl === null) {
    // エントリー
    if (openPosA.size < MAX_POS_A) {
      openPosA.set(t.symbol, t);
      skippedSymbolsA.delete(t.symbol);
    } else {
      skippedSymbolsA.add(t.symbol);
    }
  } else {
    // 決済
    if (openPosA.has(t.symbol)) {
      pnlA += Number(t.pnl);
      tradesA++;
      if (Number(t.pnl) > 0) winsA++;
      else lossesA++;
      openPosA.delete(t.symbol);
    }
    // スキップされた銘柄の決済も無視
    skippedSymbolsA.delete(t.symbol);
  }
}
console.log(`損益: ${Math.round(pnlA).toLocaleString()}円`);
console.log(`取引数: ${tradesA}件 (元${closed.length}件)`);
console.log(`勝率: ${(winsA/tradesA*100).toFixed(1)}% (${winsA}/${tradesA})`);

// 案B: 1銘柄投資額を55万円に下げる（LOT_RATIO: 0.183）
// 損益は現在の 55万/270万 = 20.4% にスケール
console.log("\n--- 案B: 1銘柄投資額を55万円に縮小（LOT_RATIO=0.183） ---");
const scaleB = 550_000 / 2_700_000;
const pnlB = currentPnl * scaleB;
console.log(`損益: ${Math.round(pnlB).toLocaleString()}円`);
console.log(`取引数: ${closed.length}件 (変わらず)`);
console.log(`勝率: ${(closed.filter(t=>Number(t.pnl)>0).length/closed.length*100).toFixed(1)}% (変わらず)`);
console.log(`スケール率: ${(scaleB*100).toFixed(1)}%`);

// 案D: 高額株（5万円超）を対象外にする
console.log("\n--- 案D: 高額株（株価5万円超）を除外 ---");
const highPriceThreshold = 50_000;
const highPriceSymbols = ["285A", "8035", "6920"]; // キオクシア・東京エレクトロン・レーザーテック
const closedD = closed.filter(t => !highPriceSymbols.includes(t.symbol));
const pnlD = closedD.reduce((s,t) => s + Number(t.pnl), 0);
const winsD = closedD.filter(t => Number(t.pnl) > 0).length;
console.log(`損益: ${Math.round(pnlD).toLocaleString()}円`);
console.log(`取引数: ${closedD.length}件 (除外: ${closed.length - closedD.length}件)`);
console.log(`勝率: ${(winsD/closedD.length*100).toFixed(1)}% (${winsD}/${closedD.length})`);
console.log(`除外銘柄: キオクシアHD(285A), 東京エレクトロン(8035), レーザーテック(6920)`);

// 除外銘柄の損益内訳
for (const sym of highPriceSymbols) {
  const symTrades = closed.filter(t => t.symbol === sym);
  const symPnl = symTrades.reduce((s,t) => s + Number(t.pnl), 0);
  const symWins = symTrades.filter(t => Number(t.pnl) > 0).length;
  console.log(`  ${sym}: ${symTrades.length}件, ${Math.round(symPnl).toLocaleString()}円, 勝率${(symWins/symTrades.length*100).toFixed(0)}%`);
}

