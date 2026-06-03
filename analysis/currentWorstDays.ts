/**
 * currentWorstDays.ts
 * 現在の最悪日（-55,700円: 5/19 など）のトレード内訳を詳細分析する
 * 全60日のデイリー損益を出力し、ワースト5日を詳細分析する
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

const JQ_DIR = path.join(__dirname, "jq_data");

async function runDay(dateStr: string): Promise<{ profit: number; eff: number; range: boolean; details: string[] }> {
  const candleMap = new Map<string, RealCandle[]>();
  for (const stock of TARGET_STOCKS) {
    const filePath = path.join(JQ_DIR, `${stock.symbol}.json`);
    if (!fs.existsSync(filePath)) continue;
    const allBars: JqBar[] = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const dayBars = allBars.filter(b => b.Date === dateStr);
    if (dayBars.length === 0) continue;
    candleMap.set(stock.symbol, barsToCandles(dayBars));
  }
  if (candleMap.size === 0) return { profit: 0, eff: 0, range: false, details: [] };

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

  let dayProfit = 0;
  const details: string[] = [];
  for (const stock of TARGET_STOCKS) {
    const candles = candleMap.get(stock.symbol);
    if (!candles) continue;
    const res = simulateStockReal(
      stock.symbol, stock.ticker, stock.name, candles,
      marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound, 1.0,
      { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
    );
    if (!res) continue;
    dayProfit += res.profitAmount;
    if (res.profitAmount !== 0) {
      let openTrade: { time: string; price: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          openTrade = { time: t.time, price: t.price, type: t.type };
        } else if ((t.type === "sell" || t.type === "cover") && openTrade) {
          const profit = t.profit ?? 0;
          const direction = openTrade.type === "buy" ? "ロング" : "ショート";
          const sig = res.signals.find(s => s.time === t.time && (s.type === "sell" || s.type === "cover"));
          const reason = sig?.reason?.replace(/\s*\(.*?\)\s*/g, "").trim() ?? "不明";
          details.push(`  ${stock.name}(${stock.symbol}) ${direction} ${openTrade.time}→${t.time}: ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円 [${reason}]`);
          openTrade = null;
        }
      }
    }
  }
  return { profit: dayProfit, eff: marketEfficiency, range: rangeBound, details };
}

async function main() {
  // まず全日の損益を集計してワースト5を特定
  const files = fs.readdirSync(JQ_DIR).filter(f => f.endsWith(".json"));
  const allDates = new Set<string>();
  for (const f of files.slice(0, 1)) {
    const bars: JqBar[] = JSON.parse(fs.readFileSync(path.join(JQ_DIR, f), "utf-8"));
    bars.forEach(b => allDates.add(b.Date));
  }
  const sortedDates = Array.from(allDates).sort();

  console.log("全日損益サマリー:");
  const dayResults: Array<{ date: string; profit: number; eff: number }> = [];
  for (const date of sortedDates) {
    const { profit, eff, range } = await runDay(date);
    dayResults.push({ date, profit, eff });
    const mark = profit < -30000 ? " ★WORST" : profit > 50000 ? " ★BEST" : "";
    console.log(`  ${date}: ${profit >= 0 ? "+" : ""}${profit.toLocaleString()}円 eff=${eff.toFixed(2)} range=${range}${mark}`);
  }

  // ワースト5を詳細分析
  const worst5 = [...dayResults].sort((a, b) => a.profit - b.profit).slice(0, 5);
  console.log("\n\n====== ワースト5日 詳細分析 ======");
  for (const { date, profit, eff } of worst5) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📅 ${date}: ${profit.toLocaleString()}円 (市場効率: ${eff.toFixed(3)})`);
    const { details } = await runDay(date);
    for (const d of details) console.log(d);
  }
}

main().catch(console.error);
