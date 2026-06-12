import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";

const BASE_URL = "https://stockalert-mwf5hf9f.manus.space";

const client = createTRPCClient({
  links: [
    httpBatchLink({
      url: `${BASE_URL}/api/trpc`,
      transformer: superjson,
    }),
  ],
});

// 今日のJST日付を確認
const now = new Date();
const jstOffset = 9 * 60 * 60 * 1000;
const jstDate = new Date(now.getTime() + jstOffset);
const todayJST = jstDate.toISOString().slice(0, 10);
console.log("JST today:", todayJST);

// 2026-06-12のデータを取得
const today = "2026-06-12";

try {
  const [trades, summaries] = await Promise.all([
    client.trading.getRtTrades.query({ tradeDate: today }),
    client.trading.getRtDailySummaries.query({ tradeDate: today }),
  ]);
  console.log("=== SUMMARIES (2026-06-12) ===");
  console.log(JSON.stringify(summaries, null, 2));
  console.log("=== TRADES COUNT ===");
  console.log(trades.length);
  console.log("=== TRADES (first 10) ===");
  console.log(JSON.stringify(trades.slice(0, 10), null, 2));
} catch (e) {
  console.error("Error:", e.message);
}
