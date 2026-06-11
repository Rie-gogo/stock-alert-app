import "dotenv/config";
import mysql from "mysql2/promise";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

// rt_daily_summaries
const [summaries] = await conn.execute(
  "SELECT * FROM rt_daily_summaries WHERE tradeDate = '2026-06-11'"
);
console.log("=== rt_daily_summaries ===");
console.log(JSON.stringify(summaries, null, 2));

// rt_trades
const [trades] = await conn.execute(
  "SELECT * FROM rt_trades WHERE tradeDate = '2026-06-11' ORDER BY tradeTime ASC"
);
console.log("\n=== rt_trades ===");
console.log("件数:", trades.length);
if (trades.length > 0) console.log(JSON.stringify(trades, null, 2));

// rt_candles 件数確認
const [candles] = await conn.execute(
  "SELECT COUNT(*) as cnt FROM rt_candles WHERE tradeDate = '2026-06-11'"
);
console.log("\n=== rt_candles 件数 ===");
console.log(JSON.stringify(candles, null, 2));

await conn.end();
