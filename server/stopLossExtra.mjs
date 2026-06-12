import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";
const client = createTRPCClient({
  links: [httpBatchLink({ url: `${BASE_URL}/api/trpc`, transformer: superjson })],
});

const today = "2026-06-12";
const trades = await client.trading.getRtTrades.query({ tradeDate: today });
const allSorted = trades.sort((a,b) => (a.tradeTime||"").localeCompare(b.tradeTime||""));

// エントリーと決済をペアにする
const entryMap = new Map();
const pairs = [];
for (const t of allSorted) {
  if (t.pnl === null) {
    entryMap.set(t.symbol, t);
  } else {
    const entry = entryMap.get(t.symbol);
    if (entry) {
      pairs.push({ entry, exit: t });
      entryMap.delete(t.symbol);
    }
  }
}

// 損切り率変更シミュレーション（0.3〜2.0%全範囲）
console.log("=== 損切り率変更シミュレーション（本日データ） ===");
const stopLossScenarios = [0.3, 0.5, 0.7, 1.0, 1.5, 2.0];
for (const newStop of stopLossScenarios) {
  let totalPnl = 0;
  let wins = 0, losses = 0;
  for (const p of pairs) {
    const entryPrice = Number(p.entry.price);
    const shares = Number(p.entry.shares);
    const pnl = Number(p.exit.pnl);
    if (pnl < 0) {
      totalPnl -= entryPrice * shares * (newStop / 100);
      losses++;
    } else {
      totalPnl += pnl;
      wins++;
    }
  }
  const marker = newStop === 0.7 ? " ← 現在" : "";
  console.log(`損切り${newStop.toFixed(1)}%: ${totalPnl >= 0 ? '+' : ''}${Math.round(totalPnl).toLocaleString()}円  勝${wins}/負${losses}${marker}`);
}
