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

const today = "2026-06-11";

try {
  const [trades, summaries] = await Promise.all([
    client.trading.getRtTrades.query({ tradeDate: today }),
    client.trading.getRtDailySummaries.query({ tradeDate: today }),
  ]);
  console.log("=== SUMMARIES ===");
  console.log(JSON.stringify(summaries, null, 2));
  console.log("=== TRADES COUNT ===");
  console.log(trades.length);
  console.log("=== TRADES ===");
  console.log(JSON.stringify(trades, null, 2));
} catch (e) {
  console.error("Error:", e.message);
  console.error(e.stack);
}
