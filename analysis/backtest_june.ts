/**
 * backtest_june.ts
 * 6/11・6/12のバックテスト結果を詳細表示する
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/backtest_june.ts
 */

import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  type SimOverrides,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null;
  flow: number | null; slope: number | null; vwap: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) result[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return result;
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = []; const losses: number[] = [];
  for (let i = 1; i < data.length; i++) { const d = data[i] - data[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100; else { const rs = avgGain / avgLoss; result[i] = 100 - 100 / (1 + rs); }
    if (i < data.length - 1) { avgGain = (avgGain * (period - 1) + gains[i]) / period; avgLoss = (avgLoss * (period - 1) + losses[i]) / period; }
  }
  return result;
}
function calcBollinger(data: number[], period = 20, m = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const w = data.slice(i - period + 1, i + 1);
    const avg = w.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    upper[i] = avg + m * std; lower[i] = avg - m * std;
  }
  return { upper, lower };
}

function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => `${a.Date}T${a.Time}` < `${b.Date}T${b.Time}` ? -1 : 1);
  const closes = sorted.map(b => b.C);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  const signedVol = sorted.map(b => {
    const range = b.H - b.L;
    const pos = range > 0 ? ((b.C - b.L) - (b.H - b.C)) / range : 0;
    return pos * b.Vo;
  });
  const flow: (number | null)[] = new Array(sorted.length).fill(null);
  for (let i = 0; i < sorted.length; i++) {
    if (i >= FLOW_LOOKBACK - 1) {
      let s = 0;
      for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k];
      flow[i] = s;
    }
  }
  const slope: (number | null)[] = new Array(sorted.length).fill(null);
  for (let i = SLOPE_LOOKBACK; i < sorted.length; i++) {
    const curr = ma25[i]; const prev = ma25[i - SLOPE_LOOKBACK];
    if (curr !== null && prev !== null && prev > 0) slope[i] = (curr - prev) / prev;
  }
  // VWAP
  let cumPV = 0, cumV = 0;
  const vwap: (number | null)[] = new Array(sorted.length).fill(null);
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i];
    const typical = (b.H + b.L + b.C) / 3;
    cumPV += typical * b.Vo;
    cumV += b.Vo;
    vwap[i] = cumV > 0 ? cumPV / cumV : null;
  }
  return sorted.map((b, i) => ({
    time: b.Time,
    timestamp: new Date(`${b.Date}T${b.Time}:00+09:00`).getTime(),
    open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: ma5[i], ma25: ma25[i], rsi: rsi[i],
    bbUpper: bb.upper[i], bbLower: bb.lower[i],
    flow: flow[i], slope: slope[i], vwap: vwap[i],
  }));
}

async function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");
  const TARGET_DATES = ["2026-06-11", "2026-06-12"];
  
  // 現在の本番設定（SUPPRESS_AFTERNOON_ENTRY=true）
  const overrides: SimOverrides = {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
    // afternoonReentryEnabled は指定しない → SUPPRESS_AFTERNOON_ENTRY=true が適用される
  };

  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  let grandTotal = 0;
  
  for (const day of TARGET_DATES) {
    console.log(`\n=== ${day} ===`);
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    
    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      const open = cs[0]?.open ?? 0;
      return cs.map(c => (open > 0 ? (c.close - open) / open : 0));
    });
    const marketBiasAt = (p: number): number => {
      let sum = 0, cnt = 0;
      for (const series of ratioSeries) {
        if (!series.length) continue;
        const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1))));
        sum += series[idx]; cnt++;
      }
      return cnt > 0 ? sum / cnt : 0;
    };
    const dayStats = symbols.map(sym => {
      const cs = candleMap.get(sym)!;
      return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 };
    });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);
    console.log(`  レンジ相場: ${rangeBound ? "YES" : "NO"}, 効率性: ${eff.toFixed(3)}`);
    
    let dayProfit = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
      if (!res) continue;
      if (res.profitAmount !== 0 || res.tradesCount > 0) {
        console.log(`  ${s.name}(${s.symbol}): ${res.tradesCount}回, ${res.profitAmount >= 0 ? "+" : ""}${res.profitAmount.toLocaleString()}円`);
        for (const sig of (res.signals ?? [])) {
          console.log(`    ${sig.time} ${sig.type} ${sig.price}円 - ${sig.reason?.slice(0, 50)}`);
        }
      }
      dayProfit += res.profitAmount;
    }
    console.log(`  日次合計: ${dayProfit >= 0 ? "+" : ""}${Math.round(dayProfit).toLocaleString()}円`);
    grandTotal += dayProfit;
  }
  
  console.log(`\n=== 2日間合計 ===`);
  console.log(`合計: ${grandTotal >= 0 ? "+" : ""}${Math.round(grandTotal).toLocaleString()}円`);
}

main().catch(console.error);
