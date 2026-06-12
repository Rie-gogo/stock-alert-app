import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });

// 決済取引のみ
const closed = trades.filter(t => t.pnl !== null).sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));

// ① 損切り後の再エントリー分析（同銘柄・同方向）
console.log("=== ① 損切り後の再エントリー ===");
const bySymbol = {};
for (const t of trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""))) {
  if (!bySymbol[t.symbol]) bySymbol[t.symbol] = [];
  bySymbol[t.symbol].push(t);
}

let reentryCount = 0;
let reentryLoss = 0;
for (const [sym, symTrades] of Object.entries(bySymbol)) {
  let lastWasLoss = false;
  let lastSide = null;
  for (const t of symTrades) {
    if (t.pnl !== null) {
      if (Number(t.pnl) < 0) { lastWasLoss = true; lastSide = t.side; }
      else { lastWasLoss = false; }
    } else {
      // エントリー
      if (lastWasLoss && t.side === lastSide) {
        reentryCount++;
        console.log(`  ${t.symbol}(${t.symbolName}) ${t.tradeTime} ${t.side}再エントリー`);
      }
      lastWasLoss = false;
    }
  }
}
console.log(`再エントリー件数: ${reentryCount}件`);

// ② 方向別の損益
console.log("\n=== ② ロング/ショート別損益 ===");
const longTrades = closed.filter(t => t.side === "long");
const shortTrades = closed.filter(t => t.side === "short");
const longPnl = longTrades.reduce((s,t) => s + Number(t.pnl), 0);
const shortPnl = shortTrades.reduce((s,t) => s + Number(t.pnl), 0);
const longWins = longTrades.filter(t => Number(t.pnl) > 0).length;
const shortWins = shortTrades.filter(t => Number(t.pnl) > 0).length;
console.log(`ロング: ${longTrades.length}件, 損益${longPnl > 0 ? '+' : ''}${longPnl.toLocaleString()}円, 勝率${(longWins/longTrades.length*100).toFixed(1)}%`);
console.log(`ショート: ${shortTrades.length}件, 損益${shortPnl > 0 ? '+' : ''}${shortPnl.toLocaleString()}円, 勝率${(shortWins/shortTrades.length*100).toFixed(1)}%`);

// ③ 損切り連続発生パターン
console.log("\n=== ③ 損切り連続発生（同時刻・複数銘柄） ===");
const lossByTime = {};
for (const t of closed) {
  if (Number(t.pnl) < 0) {
    const time = t.tradeTime;
    if (!lossByTime[time]) lossByTime[time] = [];
    lossByTime[time].push(t);
  }
}
for (const [time, ts] of Object.entries(lossByTime).sort()) {
  if (ts.length >= 2) {
    const total = ts.reduce((s,t) => s + Number(t.pnl), 0);
    console.log(`  ${time}: ${ts.length}件同時損切り, 合計${total.toLocaleString()}円`);
    ts.forEach(t => console.log(`    └ ${t.symbolName} ${t.side} ${Number(t.pnl).toLocaleString()}円`));
  }
}

// ④ 大きな損失トップ10
console.log("\n=== ④ 大きな損失トップ10 ===");
const bigLosses = closed.filter(t => Number(t.pnl) < 0).sort((a,b) => Number(a.pnl) - Number(b.pnl)).slice(0,10);
for (const t of bigLosses) {
  console.log(`  ${t.tradeTime} ${t.symbolName}(${t.symbol}) ${t.side} ${t.shares}株 @${Number(t.price).toLocaleString()} → ${Number(t.pnl).toLocaleString()}円`);
}

// ⑤ 今日の相場（日経平均連動性）
console.log("\n=== ⑤ 時間帯別勝率 ===");
const byHour = {};
for (const t of closed) {
  const h = (t.tradeTime||"??").slice(0,2);
  if (!byHour[h]) byHour[h] = { wins: 0, losses: 0, pnl: 0 };
  if (Number(t.pnl) > 0) byHour[h].wins++;
  else byHour[h].losses++;
  byHour[h].pnl += Number(t.pnl);
}
for (const [h, stat] of Object.entries(byHour).sort()) {
  const total = stat.wins + stat.losses;
  const wr = (stat.wins / total * 100).toFixed(1);
  console.log(`  ${h}時台: 勝率${wr}% (${stat.wins}/${total}), 損益${stat.pnl > 0 ? '+' : ''}${stat.pnl.toLocaleString()}円`);
}
