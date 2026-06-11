/**
 * debug_detect.mts
 * detectSignalsが今日の相場でどんなシグナルを返しているか詳細に調べる
 */

import "dotenv/config";
import mysql from "mysql2/promise";
import { detectSignals, type CandleWithSignal } from "../server/routers/stockData";

const TRADE_DATE = "2026-06-11";
const TEST_SYMBOL = "7203"; // トヨタで代表検証

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);
  const [rows] = await conn.execute(
    `SELECT symbol, candleTime, open, high, low, close, volume
     FROM rt_candles
     WHERE tradeDate = ? AND symbol = ?
     ORDER BY candleTime ASC`,
    [TRADE_DATE, TEST_SYMBOL]
  ) as [any[], any];
  await conn.end();

  console.log(`\n${TEST_SYMBOL} 本数: ${rows.length}`);

  const buffer: CandleWithSignal[] = [];
  let signalCount = 0;
  let buyCount = 0;
  let sellCount = 0;

  for (const c of rows) {
    buffer.push({
      time: `${TRADE_DATE}T${c.candleTime}:00`,
      dayKey: TRADE_DATE,
      timestamp: new Date(`${TRADE_DATE}T${c.candleTime}:00+09:00`).getTime(),
      open: Number(c.open), high: Number(c.high),
      low: Number(c.low), close: Number(c.close),
      volume: Number(c.volume ?? 0),
      ma5: null, ma25: null, rsi: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
    });

    if (buffer.length < 30) continue;

    const withSignals = detectSignals(buffer);
    const latest = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latest;

    if (latest.signal) {
      signalCount++;
      if (latest.signal.type === "buy") buyCount++;
      if (latest.signal.type === "sell") sellCount++;
      console.log(`  ${c.candleTime} [${latest.signal.type.toUpperCase()}] ${latest.signal.reason}`);
      console.log(`    close=${Number(c.close)} MA5=${latest.ma5?.toFixed(1)} MA25=${latest.ma25?.toFixed(1)} RSI=${latest.rsi?.toFixed(1)}`);
    }
  }

  console.log(`\n合計シグナル: ${signalCount}件 (BUY:${buyCount} / SELL:${sellCount})`);

  if (signalCount === 0) {
    // シグナルが0件の場合、最後の足の指標値を確認
    const withSignals = detectSignals(buffer);
    const last5 = withSignals.slice(-5);
    console.log("\n最後の5本の指標値:");
    for (const c of last5) {
      console.log(`  ${c.time.slice(11,16)} close=${c.close} MA5=${c.ma5?.toFixed(1)} MA25=${c.ma25?.toFixed(1)} RSI=${c.rsi?.toFixed(1)} BB上=${c.bbUpper?.toFixed(1)} BB下=${c.bbLower?.toFixed(1)} signal=${JSON.stringify(c.signal)}`);
    }
  }
}

main().catch(console.error);
