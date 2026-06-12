import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import fs from "fs";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";

const client = createTRPCClient({
  links: [
    httpBatchLink({
      url: `${BASE_URL}/api/trpc`,
      transformer: superjson,
    }),
  ],
});

const today = "2026-06-12";

const [trades, summaries] = await Promise.all([
  client.trading.getRtTrades.query({ tradeDate: today }),
  client.trading.getRtDailySummaries.query({ tradeDate: today }),
]);

// サマリーを保存
const summary = summaries.find(s => s.tradeDate === today) || summaries[0];
console.log("SUMMARY:", JSON.stringify(summary, null, 2));
console.log("TOTAL TRADES:", trades.length);

// 全取引をファイルに保存
fs.writeFileSync("/tmp/rt_trades_20260612.json", JSON.stringify(trades, null, 2));
console.log("Saved to /tmp/rt_trades_20260612.json");

// 銘柄別集計
const bySymbol = {};
for (const t of trades) {
  if (!bySymbol[t.symbol]) {
    bySymbol[t.symbol] = { name: t.symbolName, pnl: 0, trades: 0, wins: 0, losses: 0 };
  }
  bySymbol[t.symbol].trades++;
  if (t.pnl !== null) {
    bySymbol[t.symbol].pnl += Number(t.pnl);
    if (Number(t.pnl) > 0) bySymbol[t.symbol].wins++;
    else bySymbol[t.symbol].losses++;
  }
}
console.log("BY_SYMBOL:", JSON.stringify(bySymbol, null, 2));

// 時間帯別損益（決済のみ）
const byHour = {};
for (const t of trades) {
  if (t.pnl !== null) {
    const hour = t.tradeTime ? t.tradeTime.slice(0, 2) : "??";
    if (!byHour[hour]) byHour[hour] = { pnl: 0, count: 0 };
    byHour[hour].pnl += Number(t.pnl);
    byHour[hour].count++;
  }
}
console.log("BY_HOUR:", JSON.stringify(byHour, null, 2));

// シグナル別集計（エントリー理由）
const bySignal = {};
for (const t of trades) {
  if (t.pnl !== null && t.reason) {
    const sig = t.reason.split(" ")[0];
    if (!bySignal[sig]) bySignal[sig] = { pnl: 0, count: 0, wins: 0 };
    bySignal[sig].pnl += Number(t.pnl);
    bySignal[sig].count++;
    if (Number(t.pnl) > 0) bySignal[sig].wins++;
  }
}
console.log("BY_SIGNAL:", JSON.stringify(bySignal, null, 2));
