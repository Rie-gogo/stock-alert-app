/**
 * debug_signals.mts
 * DBに保存された本日の1分足データを使って、
 * realtimeSimEngineと同じロジックでシグナル判定を再現し、
 * なぜ取引が発生しなかったかを調査する
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { rtCandles } from '../drizzle/schema';
import { eq, asc } from 'drizzle-orm';
import { detectSignals, type CandleWithSignal } from '../server/routers/stockData';

const TARGET_DATE = '2026-06-11';
const MIN_CANDLES_FOR_SIGNAL = 30;
const STOP_LOSS_PERCENT = 0.7;
const TAKE_PROFIT_PERCENT = 1.5;
const NO_ENTRY_AFTER = '15:15';

const conn = await mysql.createConnection(process.env.DATABASE_URL!);
const db = drizzle(conn);

// 全銘柄の1分足を取得
const candles = await db.select().from(rtCandles)
  .where(eq(rtCandles.tradeDate, TARGET_DATE))
  .orderBy(asc(rtCandles.symbol), asc(rtCandles.candleTime));

console.log(`取得した1分足: ${candles.length}本`);

// 銘柄ごとにグループ化
const bySymbol = new Map<string, typeof candles>();
for (const c of candles) {
  if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, []);
  bySymbol.get(c.symbol)!.push(c);
}

console.log(`銘柄数: ${bySymbol.size}`);
for (const [sym, cs] of bySymbol) {
  console.log(`  ${sym}: ${cs.length}本 (${cs[0]?.candleTime}〜${cs[cs.length-1]?.candleTime})`);
}

console.log('\n=== シグナル判定再現 ===\n');

let totalSignals = 0;
let totalEntries = 0;

for (const [symbol, symCandles] of bySymbol) {
  const buffer: CandleWithSignal[] = [];
  let openPos: { side: string; entryPrice: number; entryTime: string; reason: string } | null = null;
  const trades: Array<{time: string; action: string; price: number; reason: string; pnl?: number}> = [];
  let signalCount = 0;

  for (const c of symCandles) {
    const candleTime = c.candleTime;
    const open = parseFloat(c.open);
    const high = parseFloat(c.high);
    const low = parseFloat(c.low);
    const close = parseFloat(c.close);

    const candleForSignal: CandleWithSignal = {
      time: `${TARGET_DATE}T${candleTime}:00`,
      dayKey: TARGET_DATE,
      timestamp: new Date(`${TARGET_DATE}T${candleTime}:00+09:00`).getTime(),
      open, high, low, close,
      volume: c.volume ?? 0,
      ma5: null, ma25: null, rsi: null,
      bbUpper: null, bbMiddle: null, bbLower: null,
    };
    buffer.push(candleForSignal);

    // ウォームアップ期間
    if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

    // 既存ポジションの損切り・利確チェック
    if (openPos) {
      if (openPos.side === 'long') {
        const stopLine = openPos.entryPrice * (1 - STOP_LOSS_PERCENT / 100);
        const tpLine = openPos.entryPrice * (1 + TAKE_PROFIT_PERCENT / 100);
        if (low <= stopLine) {
          const pnl = Math.round((stopLine - openPos.entryPrice) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
          trades.push({ time: candleTime, action: 'stop_loss', price: stopLine, reason: `損切り`, pnl });
          openPos = null;
          continue;
        }
        if (high >= tpLine) {
          const pnl = Math.round((tpLine - openPos.entryPrice) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
          trades.push({ time: candleTime, action: 'take_profit', price: tpLine, reason: `利確`, pnl });
          openPos = null;
          continue;
        }
      } else {
        const stopLine = openPos.entryPrice * (1 + STOP_LOSS_PERCENT / 100);
        const tpLine = openPos.entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);
        if (high >= stopLine) {
          const pnl = Math.round((openPos.entryPrice - stopLine) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
          trades.push({ time: candleTime, action: 'stop_loss', price: stopLine, reason: `損切り(空売り)`, pnl });
          openPos = null;
          continue;
        }
        if (low <= tpLine) {
          const pnl = Math.round((openPos.entryPrice - tpLine) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
          trades.push({ time: candleTime, action: 'take_profit', price: tpLine, reason: `利確(空売り)`, pnl });
          openPos = null;
          continue;
        }
      }

      // 大引け強制決済
      if (candleTime >= '15:30') {
        const pnl = openPos.side === 'long'
          ? Math.round((close - openPos.entryPrice) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100)
          : Math.round((openPos.entryPrice - close) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
        trades.push({ time: candleTime, action: 'forced_close', price: close, reason: `大引け強制決済`, pnl });
        openPos = null;
        continue;
      }
    }

    // エントリー禁止時刻
    if (candleTime >= NO_ENTRY_AFTER) continue;
    // 既にポジションあり
    if (openPos) continue;

    // シグナル検出
    const withSignals = detectSignals(buffer);
    const latest = withSignals[withSignals.length - 1];
    buffer[buffer.length - 1] = latest;

    if (!latest.signal) continue;
    signalCount++;
    totalSignals++;

    const sig = latest.signal;

    // HybridAフィルター
    const firstCandle = buffer[0];
    const openPrice = firstCandle?.open ?? close;
    const priceChangeRatio = (close - openPrice) / openPrice * 100;
    const isBullish = priceChangeRatio >= 0.2;

    if (sig.type === 'buy') {
      openPos = { side: 'long', entryPrice: close, entryTime: candleTime, reason: sig.reason };
      trades.push({ time: candleTime, action: 'buy', price: close, reason: sig.reason });
      totalEntries++;
    } else if (sig.type === 'sell') {
      if (isBullish) {
        // HybridAフィルターでスキップ
        console.log(`  [${symbol}] ${candleTime} SELL シグナル → HybridAフィルターでスキップ (priceChange=${priceChangeRatio.toFixed(2)}%)`);
        continue;
      }
      openPos = { side: 'short', entryPrice: close, entryTime: candleTime, reason: sig.reason };
      trades.push({ time: candleTime, action: 'short', price: close, reason: sig.reason });
      totalEntries++;
    }
  }

  // 未決済ポジションを大引け終値で強制決済
  if (openPos && symCandles.length > 0) {
    const lastCandle = symCandles[symCandles.length - 1];
    const close = parseFloat(lastCandle.close);
    const pnl = openPos.side === 'long'
      ? Math.round((close - openPos.entryPrice) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100)
      : Math.round((openPos.entryPrice - close) * Math.floor(3_000_000 * 0.9 / openPos.entryPrice / 100) * 100);
    trades.push({ time: lastCandle.candleTime, action: 'forced_close', price: close, reason: '大引け強制決済(残)', pnl });
  }

  if (trades.length > 0 || signalCount > 0) {
    console.log(`\n【${symbol}】 シグナル数: ${signalCount}, 取引数: ${trades.length}`);
    for (const t of trades) {
      const pnlStr = t.pnl !== undefined ? ` 損益:${t.pnl >= 0 ? '+' : ''}${t.pnl.toLocaleString()}円` : '';
      console.log(`  ${t.time} [${t.action}] @${t.price} ${t.reason}${pnlStr}`);
    }
  }
}

console.log(`\n=== 集計 ===`);
console.log(`総シグナル数: ${totalSignals}`);
console.log(`総エントリー数: ${totalEntries}`);

await conn.end();
