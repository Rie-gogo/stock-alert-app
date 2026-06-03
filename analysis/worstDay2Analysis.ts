/**
 * worstDay2Analysis.ts
 * 大損失日（3/23・3/30・4/28・4/30）のトレード内訳を詳細分析する
 * 各日の銘柄別損益・決済理由・エントリー条件を出力する
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  return data.map((_, i) => {
    if (i < period - 1) return null;
    return data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  });
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const rsi: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return rsi;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = data[i] - data[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let avgGain = gains / period, avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < data.length; i++) {
    const d = data[i] - data[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(0, d)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -d)) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return rsi;
}
function calcBollinger(data: number[], period = 20, mult = 2): { upper: (number | null)[]; lower: (number | null)[] } {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const w = data.slice(i - period + 1, i + 1);
    const avg = w.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    upper[i] = avg + mult * std;
    lower[i] = avg - mult * std;
  }
  return { upper, lower };
}

function barsToCandles(bars: JqBar[]): RealCandle[] {
  const closes = bars.map(b => b.C);
  const ma5arr = calcMA(closes, 5);
  const ma25arr = calcMA(closes, 25);
  const rsiarr = calcRSI(closes, 14);
  const { upper, lower } = calcBollinger(closes, 20, 2);
  const flowArr: (number | null)[] = bars.map((b, i) => {
    if (i < FLOW_LOOKBACK - 1) return null;
    let sum = 0;
    for (let j = i - FLOW_LOOKBACK + 1; j <= i; j++) {
      const range = bars[j].H - bars[j].L;
      const pos = range > 0 ? (bars[j].C - bars[j].L) / range : 0.5;
      sum += (pos - 0.5) * bars[j].Vo;
    }
    return sum;
  });
  const slopeArr: (number | null)[] = bars.map((_, i) => {
    if (i < SLOPE_LOOKBACK) return null;
    const prev = ma25arr[i - SLOPE_LOOKBACK];
    const curr = ma25arr[i];
    if (prev == null || curr == null) return null;
    return (curr - prev) / (prev * SLOPE_LOOKBACK);
  });
  return bars.map((b, i) => ({
    time: b.Time.slice(0, 5),
    timestamp: new Date(`${b.Date}T${b.Time.slice(0, 5)}:00+09:00`).getTime(),
    open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: ma5arr[i], ma25: ma25arr[i], rsi: rsiarr[i],
    bbUpper: upper[i], bbLower: lower[i],
    flow: flowArr[i], slope: slopeArr[i],
  }));
}

const TARGET_DATES = ["2026-03-23", "2026-03-30", "2026-04-28", "2026-04-30"];
const JQ_DIR = path.join(__dirname, "jq_data");

async function main() {
  for (const targetDate of TARGET_DATES) {
    console.log(`\n${"=".repeat(70)}`);
    console.log(`📅 ${targetDate} の詳細分析`);
    console.log("=".repeat(70));

    // 各銘柄のローソク足を読み込む
    const candleMap = new Map<string, RealCandle[]>();
    for (const stock of TARGET_STOCKS) {
      const filePath = path.join(JQ_DIR, `${stock.symbol}.json`);
      if (!fs.existsSync(filePath)) continue;
      const allBars: JqBar[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      const dayBars = allBars.filter(b => b.Date === targetDate);
      if (dayBars.length === 0) continue;
      candleMap.set(stock.symbol, barsToCandles(dayBars));
    }

    if (candleMap.size === 0) {
      console.log(`  データなし（休場日の可能性）`);
      continue;
    }

    // 市場効率を計算
    const symbols = Array.from(candleMap.keys());
    const ratioSeries: number[][] = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      const open = cs[0]?.open ?? 0;
      return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
    });
    const marketBiasByProgress = (p: number): number => {
      let sum = 0; let cnt = 0;
      for (const series of ratioSeries) {
        if (series.length === 0) continue;
        const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1))));
        sum += series[idx]; cnt++;
      }
      return cnt > 0 ? sum / cnt : 0;
    };
    const dayStats = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 };
    });
    const marketEfficiency = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(marketEfficiency);

    console.log(`  市場効率: ${marketEfficiency.toFixed(3)} | レンジ日: ${rangeBound}`);

    // 各銘柄をシミュレーション
    const results: Array<{ symbol: string; name: string; profit: number; trades: number; win: number; loss: number; tradeDetails: string[] }> = [];
    for (const stock of TARGET_STOCKS) {
      const candles = candleMap.get(stock.symbol);
      if (!candles) continue;
      const res = simulateStockReal(
        stock.symbol, stock.ticker, stock.name, candles,
        marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;

      // トレード詳細を組み立て
      const tradeDetails: string[] = [];
      let openTrade: { time: string; price: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          openTrade = { time: t.time, price: t.price, type: t.type };
        } else if ((t.type === "sell" || t.type === "cover") && openTrade) {
          const profit = t.profit ?? 0;
          const direction = openTrade.type === "buy" ? "ロング" : "ショート";
          // Find the signal for this trade to get the reason
          const sig = res.signals.find(s => s.time === t.time && (s.type === "sell" || s.type === "cover"));
          const reason = sig?.reason ?? "不明";
          tradeDetails.push(`  ${direction} ${openTrade.time}→${t.time} @${openTrade.price.toFixed(0)}→${t.price.toFixed(0)} ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円 [${reason}]`);
          openTrade = null;
        }
      }

      results.push({
        symbol: stock.symbol,
        name: stock.name,
        profit: res.profitAmount,
        trades: res.tradesCount,
        win: res.winCount,
        loss: res.lossCount,
        tradeDetails,
      });
    }

    // 損益順にソート
    results.sort((a, b) => a.profit - b.profit);
    const totalProfit = results.reduce((s, r) => s + r.profit, 0);
    console.log(`  合計損益: ${totalProfit >= 0 ? "+" : ""}${totalProfit.toLocaleString()}円\n`);

    // 損失銘柄のみ詳細表示
    const losers = results.filter(r => r.profit < 0);
    const winners = results.filter(r => r.profit > 0);
    console.log(`  ▼ 損失銘柄 (${losers.length}銘柄)`);
    for (const r of losers) {
      console.log(`  ${r.name}(${r.symbol}): ${r.profit.toLocaleString()}円 [${r.win}勝${r.loss}敗]`);
      for (const d of r.tradeDetails) console.log(d);
    }
    console.log(`\n  ▲ 利益銘柄 (${winners.length}銘柄)`);
    for (const r of winners) {
      console.log(`  ${r.name}(${r.symbol}): +${r.profit.toLocaleString()}円 [${r.win}勝${r.loss}敗]`);
    }

    // 決済理由の集計
    const reasonMap = new Map<string, { count: number; profit: number }>();
    for (const r of results) {
      for (const detail of r.tradeDetails) {
        const match = detail.match(/\[(.+)\]/);
        if (!match) continue;
        const reason = match[1].replace(/\s*\(.*?\)\s*/g, "").trim(); // パラメータ部分を除去
        const profitMatch = detail.match(/([\+\-][\d,]+)円/);
        const profit = profitMatch ? parseInt(profitMatch[1].replace(/,/g, "")) : 0;
        const existing = reasonMap.get(reason) ?? { count: 0, profit: 0 };
        reasonMap.set(reason, { count: existing.count + 1, profit: existing.profit + profit });
      }
    }
    console.log(`\n  ▼ 決済理由別集計`);
    const sortedReasons = Array.from(reasonMap.entries()).sort((a, b) => a[1].profit - b[1].profit);
    for (const [reason, { count, profit }] of sortedReasons) {
      console.log(`  ${reason}: ${count}回, ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円`);
    }
  }
}

main().catch(console.error);
