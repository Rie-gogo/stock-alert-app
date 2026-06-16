/**
 * replay_jq.ts
 * replay_today.mtsと同じロジックをJ-Quantsのローカルデータで再現する
 * 6/11・6/12の結果を検証する
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/replay_jq.ts
 */

import * as fs from "fs";
import * as path from "path";
import { detectSignals, calcMA, calcRSI, calcBollinger, type CandleWithSignal } from "../server/routers/stockData";
import { TARGET_STOCKS } from "../shared/stocks";

// === replay_today.mtsと同じ定数 ===
const INITIAL_CAPITAL_PER_STOCK = 3_000_000;
const LOT_RATIO = 0.9;
const STOP_LOSS_PERCENT = 0.7;  // realtimeSimEngine.tsと同じ（6/11良い結果の設定）
const TAKE_PROFIT_PERCENT = 1.5;
const MIN_CANDLES_FOR_SIGNAL = 30;
const NO_ENTRY_AFTER = "15:15";  // realtimeSimEngine.tsと同じ（6/11良い結果の設定）
const MARKET_CLOSE_TIME = "15:30";

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

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
  action: string;
  price: number;
  shares: number;
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

function simulateDay(tradeDate: string, dataDir: string): { totalPnl: number; winCount: number; lossCount: number; trades: Trade[] } {
  const allTrades: Trade[] = [];
  let totalPnl = 0;
  let winCount = 0;
  let lossCount = 0;

  for (const stock of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${stock.symbol}.json`);
    if (!fs.existsSync(fp)) continue;

    const allBars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const dayBars = allBars.filter(b => b.Date === tradeDate).sort((a, b) => a.Time < b.Time ? -1 : 1);
    if (dayBars.length < MIN_CANDLES_FOR_SIGNAL) continue;

    const buffer: CandleWithSignal[] = [];
    let openPos: OpenPosition | null = null;
    const symbolTrades: Trade[] = [];

    for (const bar of dayBars) {
      const candleTime = bar.Time; // "HH:MM"
      const open = bar.O;
      const high = bar.H;
      const low = bar.L;
      const close = bar.C;
      const volume = bar.Vo;

      // バッファに追加
      buffer.push({
        time: `${tradeDate}T${candleTime}:00`,
        dayKey: tradeDate,
        timestamp: new Date(`${tradeDate}T${candleTime}:00+09:00`).getTime(),
        open, high, low, close, volume,
        ma5: null, ma25: null, rsi: null,
        bbUpper: null, bbMiddle: null, bbLower: null,
      });

      // MA5・MA25・RSI・BBを計算して最新足に設定
      const closes2 = buffer.map(c => c.close);
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
            symbol: stock.symbol, symbolName: stock.name,
            action: side === "long" ? "sell" : "cover",
            price: exitPrice, shares,
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
          symbol: stock.symbol, symbolName: stock.name,
          action: "forced_close",
          price: close, shares,
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

      // HybridAフィルター（BULLISH相場ではSHORT禁止）
      const firstCandle = buffer[0];
      const openPriceFirst = firstCandle?.open ?? close;
      const priceChangeRatio = (close - openPriceFirst) / openPriceFirst * 100;
      const isBullish = priceChangeRatio >= 0.2;

      if (sig.type === "buy") {
        const shares = calcShares(close);
        openPos = { symbol: stock.symbol, side: "long", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason };
        symbolTrades.push({
          symbol: stock.symbol, symbolName: stock.name,
          action: "buy",
          price: close, shares,
          pnl: null, reason: sig.reason, tradeTime: candleTime, side: "long",
        });
      } else if (sig.type === "sell") {
        if (isBullish) continue; // BULLISH相場ではSHORT禁止
        const shares = calcShares(close);
        openPos = { symbol: stock.symbol, side: "short", entryPrice: close, shares, entryTime: candleTime, entryReason: sig.reason };
        symbolTrades.push({
          symbol: stock.symbol, symbolName: stock.name,
          action: "short",
          price: close, shares,
          pnl: null, reason: sig.reason, tradeTime: candleTime, side: "short",
        });
      }
    }

    // 引け後も残ったポジションを終値で強制決済
    if (openPos && dayBars.length > 0) {
      const lastBar = dayBars[dayBars.length - 1];
      const lastClose = lastBar.C;
      const { entryPrice, shares, side } = openPos;
      const pnl = side === "long"
        ? (lastClose - entryPrice) * shares
        : (entryPrice - lastClose) * shares;
      totalPnl += pnl;
      if (pnl > 0) winCount++; else lossCount++;
      symbolTrades.push({
        symbol: stock.symbol, symbolName: stock.name,
        action: "forced_close",
        price: lastClose, shares,
        pnl, reason: "引け強制決済", tradeTime: lastBar.Time, side,
      });
    }

    allTrades.push(...symbolTrades);

    if (symbolTrades.length > 0) {
      const symPnl = symbolTrades.reduce((s, t) => s + (t.pnl ?? 0), 0);
      console.log(`  ${stock.symbol} ${stock.name}: ${symbolTrades.filter(t => t.pnl !== null).length}回, ${symPnl >= 0 ? "+" : ""}${Math.round(symPnl).toLocaleString()}円`);
      for (const t of symbolTrades) {
        const pnlStr = t.pnl !== null ? ` → ${t.pnl >= 0 ? "+" : ""}${Math.round(t.pnl).toLocaleString()}円` : "";
        console.log(`    ${t.tradeTime} ${t.action.padEnd(12)} @${t.price.toLocaleString()}円 ×${t.shares}株  [${t.reason.slice(0, 40)}]${pnlStr}`);
      }
    }
  }

  return { totalPnl, winCount, lossCount, trades: allTrades };
}

async function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");
  const TARGET_DATES = ["2026-06-11", "2026-06-12"];

  let grandTotal = 0;

  for (const tradeDate of TARGET_DATES) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📊 ${tradeDate} （replay_today.mtsと同じロジック）`);
    console.log(`${"=".repeat(60)}`);

    const { totalPnl, winCount, lossCount, trades } = simulateDay(tradeDate, dataDir);
    const totalDecisions = winCount + lossCount;
    const winRate = totalDecisions > 0 ? (winCount / totalDecisions * 100).toFixed(1) : "0.0";

    console.log(`\n  取引数（決済）: ${totalDecisions}件`);
    console.log(`  勝ち: ${winCount}件 / 負け: ${lossCount}件 / 勝率: ${winRate}%`);
    console.log(`  損益合計: ${totalPnl >= 0 ? "+" : ""}${Math.round(totalPnl).toLocaleString()}円`);

    grandTotal += totalPnl;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`📈 2日間合計: ${grandTotal >= 0 ? "+" : ""}${Math.round(grandTotal).toLocaleString()}円`);
  console.log(`${"=".repeat(60)}`);
}

main().catch(console.error);
