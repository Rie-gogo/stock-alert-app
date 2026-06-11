/**
 * replay_today.mts
 * 今日のDBに蓄積された実1分足データを使って
 * realtimeSimEngineのシグナル判定・取引ロジックを完全再現する
 */

import "dotenv/config";
import mysql from "mysql2/promise";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { getStockName } from "../shared/stocks";

const TRADE_DATE = "2026-06-11";
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.7;
const TAKE_PROFIT_PERCENT = 1.5;
const MIN_CANDLES_FOR_SIGNAL = 30;
const NO_ENTRY_AFTER = "15:15";
const MARKET_CLOSE_TIME = "15:30";

interface OpenPosition {
  symbol: string;
  side: "long" | "short";
  entryPrice: number;
  shares: number;
  entryTime: string;
  entryReason: string;
}

interface Trade {
  symbol: string;
  symbolName: string;
  action: "buy" | "sell" | "short" | "cover" | "forced_close";
  price: number;
  shares: number;
  amount: number;
  pnl: number | null;
  reason: string;
  tradeTime: string;
  side: "long" | "short";
}

function calcShares(price: number): number {
  const amount = INITIAL_CAPITAL_PER_STOCK * LOT_RATIO;
  const rawShares = Math.floor(amount / price);
  return Math.max(100, Math.floor(rawShares / 100) * 100);
}

async function main() {
  const conn = await mysql.createConnection(process.env.DATABASE_URL!);

  // 今日の全銘柄1分足を取得
  const [rows] = await conn.execute(
    `SELECT symbol, tradeDate, candleTime, open, high, low, close, volume
     FROM rt_candles
     WHERE tradeDate = ?
     ORDER BY symbol, candleTime ASC`,
    [TRADE_DATE]
  ) as [any[], any];

  await conn.end();

  if (rows.length === 0) {
    console.log("データなし");
    return;
  }

  // 銘柄ごとにグループ化
  const grouped = new Map<string, any[]>();
  for (const row of rows) {
    if (!grouped.has(row.symbol)) grouped.set(row.symbol, []);
    grouped.get(row.symbol)!.push(row);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📊 リアルタイムシミュレーション再現 ${TRADE_DATE}`);
  console.log(`${"=".repeat(60)}`);
  console.log(`銘柄数: ${grouped.size} / 合計1分足: ${rows.length}本\n`);

  const allTrades: Trade[] = [];
  let totalPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  // 銘柄ごとにシミュレーション
  for (const [symbol, candles] of Array.from(grouped.entries())) {
    const symbolName = getStockName(symbol);
    const buffer: CandleWithSignal[] = [];
    let openPos: OpenPosition | null = null;
    const symbolTrades: Trade[] = [];

    for (const c of candles) {
      const candleTime: string = c.candleTime;
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.volume ?? 0);

      // バッファに追加
      buffer.push({
        time: `${TRADE_DATE}T${c.candleTime}:00`,
        dayKey: TRADE_DATE,
        timestamp: new Date(`${TRADE_DATE}T${c.candleTime}:00+09:00`).getTime(),
        open, high, low, close, volume,
        ma5: null, ma25: null, rsi: null,
        bbUpper: null, bbMiddle: null, bbLower: null,
      });

      // MA5・MA25・RSI・BBを計算して最新足に設定
      const closes2 = buffer.map(c2 => c2.close);
      const ma5S = calcMA(closes2, 5);
      const ma25S = calcMA(closes2, 25);
      const rsiS = calcRSI(closes2, 14);
      const bbS = calcBollinger(closes2, 20);
      const li = buffer.length - 1;
      buffer[li].ma5 = ma5S[li];
      buffer[li].ma25 = ma25S[li];
      buffer[li].rsi = rsiS[li];
      buffer[li].bbUpper = bbS.upper[li];
      buffer[li].bbMiddle = bbS.middle[li];
      buffer[li].bbLower = bbS.lower[li];

      // ---- 既存ポジションの損切り・利確チェック ----
      if (openPos) {
        const { entryPrice, shares, side } = openPos;
        const stopPrice = side === "long"
          ? entryPrice * (1 - STOP_LOSS_PERCENT / 100)
          : entryPrice * (1 + STOP_LOSS_PERCENT / 100);
        const tpPrice = side === "long"
          ? entryPrice * (1 + TAKE_PROFIT_PERCENT / 100)
          : entryPrice * (1 - TAKE_PROFIT_PERCENT / 100);

        let exitPrice: number | null = null;
        let exitReason = "";

        if (side === "long") {
          if (low <= stopPrice) { exitPrice = stopPrice; exitReason = "損切り"; }
          else if (high >= tpPrice) { exitPrice = tpPrice; exitReason = "利確"; }
        } else {
          if (high >= stopPrice) { exitPrice = stopPrice; exitReason = "損切り"; }
          else if (low <= tpPrice) { exitPrice = tpPrice; exitReason = "利確"; }
        }

        if (exitPrice !== null) {
          const pnl = side === "long"
            ? (exitPrice - entryPrice) * shares
            : (entryPrice - exitPrice) * shares;
          totalPnl += pnl;
          if (pnl > 0) winCount++; else lossCount++;
          symbolTrades.push({
            symbol, symbolName,
            action: side === "long" ? "sell" : "cover",
            price: exitPrice, shares, amount: exitPrice * shares,
            pnl, reason: exitReason, tradeTime: candleTime, side,
          });
          openPos = null;
          continue;
        }
      }

      // ---- 大引け強制決済 ----
      if (candleTime >= MARKET_CLOSE_TIME && openPos) {
        const { entryPrice, shares, side } = openPos;
        const pnl = side === "long"
          ? (close - entryPrice) * shares
          : (entryPrice - close) * shares;
        totalPnl += pnl;
        if (pnl > 0) winCount++; else lossCount++;
        symbolTrades.push({
          symbol, symbolName,
          action: "forced_close",
          price: close, shares, amount: close * shares,
          pnl, reason: "大引け強制決済", tradeTime: candleTime, side,
        });
        openPos = null;
        continue;
      }

      // ---- 午後エントリー禁止 ----
      if (candleTime >= NO_ENTRY_AFTER) continue;

      // ---- 既にポジションがある場合はスキップ ----
      if (openPos) continue;

      // ---- ウォームアップ ----
      if (buffer.length < MIN_CANDLES_FOR_SIGNAL) continue;

      // ---- シグナル検出 ----
      const withSignals = detectSignals(buffer);
      const latest = withSignals[withSignals.length - 1];
      buffer[buffer.length - 1] = latest;

      if (!latest.signal) continue;

      const sig = latest.signal;

      // HybridAフィルター
      const firstCandle = buffer[0];
      const openPriceFirst = firstCandle?.open ?? close;
      const priceChangeRatio = (close - openPriceFirst) / openPriceFirst * 100;
      const isBullish = priceChangeRatio >= 0.2;

      if (sig.type === "buy") {
        // 板情報なし → 中立（通す）
        const shares = calcShares(close);
        openPos = { symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason };
        symbolTrades.push({
          symbol, symbolName,
          action: "buy",
          price: close, shares, amount: close * shares,
          pnl: null, reason: sig.reason, tradeTime: candleTime, side: "long",
        });
      } else if (sig.type === "sell") {
        if (isBullish) continue; // BULLISH相場ではSHORT禁止
        const shares = calcShares(close);
        openPos = { symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason };
        symbolTrades.push({
          symbol, symbolName,
          action: "short",
          price: close, shares, amount: close * shares,
          pnl: null, reason: sig.reason, tradeTime: candleTime, side: "short",
        });
      }
    }

    // 引け後も残ったポジションを終値で強制決済
    if (openPos && candles.length > 0) {
      const lastCandle = candles[candles.length - 1];
      const close = Number(lastCandle.close);
      const { entryPrice, shares, side } = openPos;
      const pnl = side === "long"
        ? (close - entryPrice) * shares
        : (entryPrice - close) * shares;
      totalPnl += pnl;
      if (pnl > 0) winCount++; else lossCount++;
      symbolTrades.push({
        symbol, symbolName,
        action: "forced_close",
        price: close, shares, amount: close * shares,
        pnl, reason: "引け強制決済", tradeTime: lastCandle.candleTime, side,
      });
    }

    allTrades.push(...symbolTrades);

    if (symbolTrades.length > 0) {
      const symPnl = symbolTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      console.log(`\n【${symbol} ${symbolName}】 ${symbolTrades.length}件 損益: ${symPnl >= 0 ? "+" : ""}${symPnl.toLocaleString()}円`);
      for (const t of symbolTrades) {
        const pnlStr = t.pnl !== null ? ` → 損益: ${t.pnl >= 0 ? "+" : ""}${t.pnl.toLocaleString()}円` : "";
        console.log(`  ${t.tradeTime} ${t.action.padEnd(12)} @${t.price.toLocaleString()}円 ×${t.shares}株  [${t.reason}]${pnlStr}`);
      }
    }
  }

  // ---- 全体サマリー ----
  const totalTrades = allTrades.filter(t => t.pnl !== null).length;
  const winRate = totalTrades > 0 ? (winCount / totalTrades * 100).toFixed(1) : "0.0";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📈 本日の仮想取引サマリー`);
  console.log(`${"=".repeat(60)}`);
  console.log(`取引数（決済）: ${totalTrades}件`);
  console.log(`勝ち: ${winCount}件 / 負け: ${lossCount}件 / 勝率: ${winRate}%`);
  console.log(`損益合計: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);
  console.log(`元金: 15,000,000円 → 損益率: ${(totalPnl / 15_000_000 * 100).toFixed(3)}%`);

  if (allTrades.length === 0) {
    console.log("\n⚠️  取引が1件も発生しませんでした");
    console.log("   → シグナル条件が今日の相場に合っていない可能性があります");
  }
}

main().catch(console.error);
