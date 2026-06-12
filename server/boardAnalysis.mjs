import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });

// 板情報が使われた取引の分析
const withBoard = trades.filter(t => t.boardSignal !== null && t.boardSignal !== undefined);
const withoutBoard = trades.filter(t => t.boardSignal === null || t.boardSignal === undefined);

console.log("=== 板情報使用状況 ===");
console.log(`板情報あり: ${withBoard.length}件`);
console.log(`板情報なし: ${withoutBoard.length}件`);

// 板情報別の損益
const boardSignalStats = {};
for (const t of trades) {
  const sig = t.boardSignal || "null";
  if (!boardSignalStats[sig]) boardSignalStats[sig] = { count: 0, pnl: 0, wins: 0, losses: 0 };
  boardSignalStats[sig].count++;
  if (t.pnl !== null) {
    boardSignalStats[sig].pnl += Number(t.pnl);
    if (Number(t.pnl) > 0) boardSignalStats[sig].wins++;
    else boardSignalStats[sig].losses++;
  }
}
console.log("\n=== 板シグナル別集計 ===");
for (const [sig, stat] of Object.entries(boardSignalStats)) {
  console.log(`${sig}: ${stat.count}件, 損益${stat.pnl > 0 ? '+' : ''}${stat.pnl.toLocaleString()}円, 勝${stat.wins}/負${stat.losses}`);
}

// エントリー取引のみ（pnl=null）の板情報
const entries = trades.filter(t => t.pnl === null);
console.log("\n=== エントリー取引の板情報 ===");
const entryBoardStats = {};
for (const t of entries) {
  const sig = t.boardSignal || "null";
  entryBoardStats[sig] = (entryBoardStats[sig] || 0) + 1;
}
for (const [sig, cnt] of Object.entries(entryBoardStats)) {
  console.log(`${sig}: ${cnt}件`);
}

// 太陽誘電の連続損切り詳細
const taiyoTrades = trades.filter(t => t.symbol === "6976").sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));
console.log("\n=== 太陽誘電(6976) 全取引 ===");
for (const t of taiyoTrades) {
  const pnlStr = t.pnl !== null ? `${Number(t.pnl) > 0 ? '+' : ''}${Number(t.pnl).toLocaleString()}円` : "未決済";
  console.log(`${t.tradeTime} ${t.action}(${t.side}) ${t.shares}株 @${Number(t.price).toLocaleString()} | ${pnlStr} | board:${t.boardSignal} | ${t.reason?.slice(0,40)}`);
}
