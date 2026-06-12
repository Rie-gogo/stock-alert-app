import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });

// エントリーと決済をペアにして同時ポジション数を計算
const allSorted = trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));

// 各エントリーの投資額を計算
const entries = allSorted.filter(t => t.pnl === null);
const exits = allSorted.filter(t => t.pnl !== null);

console.log("=== 1回のエントリー投資額 ===");
// 銘柄別の投資額
const investBySymbol = {};
for (const t of entries) {
  const invest = Number(t.price) * Number(t.shares);
  if (!investBySymbol[t.symbol]) investBySymbol[t.symbol] = { name: t.symbolName, invest, shares: t.shares };
  console.log(`${t.symbolName}(${t.symbol}): ${t.shares}株 × ${Number(t.price).toLocaleString()}円 = ${invest.toLocaleString()}円`);
}

// 最大・最小・平均投資額
const investAmounts = entries.map(t => Number(t.price) * Number(t.shares));
const maxInvest = Math.max(...investAmounts);
const minInvest = Math.min(...investAmounts);
const avgInvest = investAmounts.reduce((s,v)=>s+v,0) / investAmounts.length;
console.log(`\n最大投資額: ${maxInvest.toLocaleString()}円`);
console.log(`最小投資額: ${minInvest.toLocaleString()}円`);
console.log(`平均投資額: ${Math.round(avgInvest).toLocaleString()}円`);

// 同時ポジション数の推移（時刻ごと）
console.log("\n=== 同時ポジション数の推移 ===");
const openPositions = new Map(); // symbol -> {price, shares, time}
let maxSimultaneous = 0;
let maxSimultaneousTime = "";
let maxSimultaneousInvest = 0;

for (const t of allSorted) {
  if (t.pnl === null) {
    // エントリー
    openPositions.set(t.symbol, { price: Number(t.price), shares: Number(t.shares), time: t.tradeTime });
  } else {
    // 決済
    openPositions.delete(t.symbol);
  }
  const totalInvest = Array.from(openPositions.values()).reduce((s,p) => s + p.price * p.shares, 0);
  if (openPositions.size > maxSimultaneous) {
    maxSimultaneous = openPositions.size;
    maxSimultaneousTime = t.tradeTime;
    maxSimultaneousInvest = totalInvest;
  }
}

console.log(`最大同時ポジション数: ${maxSimultaneous}銘柄`);
console.log(`その時刻: ${maxSimultaneousTime}`);
console.log(`その時の合計投資額: ${maxSimultaneousInvest.toLocaleString()}円`);
console.log(`元金300万円に対する倍率: ${(maxSimultaneousInvest/3_000_000).toFixed(1)}倍`);

// 信用取引の現実チェック
console.log("\n=== 信用取引の現実性チェック ===");
console.log(`元金（証拠金）: 3,000,000円`);
console.log(`信用取引レバレッジ上限: 3.3倍`);
console.log(`最大借入可能額: ${(3_000_000 * 3.3).toLocaleString()}円`);
console.log(`最大同時投資額: ${maxSimultaneousInvest.toLocaleString()}円`);
console.log(`→ 証拠金3,000,000円で可能か: ${maxSimultaneousInvest <= 3_000_000 * 3.3 ? "✓ 可能" : "✗ 不可能（証拠金不足）"}`);

// 1日の総売買代金
const totalTurnover = entries.reduce((s,t) => s + Number(t.price) * Number(t.shares), 0);
console.log(`\n1日の総売買代金（片道）: ${totalTurnover.toLocaleString()}円`);
console.log(`往復（エントリー+決済）: ${(totalTurnover*2).toLocaleString()}円`);
