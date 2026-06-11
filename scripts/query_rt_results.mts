import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { rtTrades, rtDailySummaries, rtCandles } from '../drizzle/schema';
import { eq } from 'drizzle-orm';

const TARGET_DATE = '2026-06-11';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);
const db = drizzle(conn);

const trades = await db.select().from(rtTrades).where(eq(rtTrades.tradeDate, TARGET_DATE));
const summary = await db.select().from(rtDailySummaries).where(eq(rtDailySummaries.tradeDate, TARGET_DATE));
const candles = await db.select().from(rtCandles).where(eq(rtCandles.tradeDate, TARGET_DATE));

console.log('=== RT_TRADES ===');
console.log(JSON.stringify(trades, null, 2));
console.log('=== RT_DAILY_SUMMARIES ===');
console.log(JSON.stringify(summary, null, 2));
console.log('=== CANDLE COUNT ===');
console.log(candles.length);

await conn.end();
