/**
 * worstDayAnalysis.ts
 * 最悪日（3/9・4/27）のトレード内訳を詳細分析する。
 * 各銘柄のトレード・シグナルをダンプして損失の根本原因を特定する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/worstDayAnalysis.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
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

function toTimestamp(date: string, time: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return Date.UTC(y, mo - 1, d, hh - 9, mm, 0);
}

function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const c2: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = c2.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  c2.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = c2.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  c2.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = c2[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return c2;
}

function analyzeDay(day: string, byTicker: Map<string, Map<string, JqBar[]>>) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`📅 ${day} の詳細分析`);
  console.log("=".repeat(60));

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
  console.log(`市場効率: ${eff.toFixed(3)} | レンジ相場: ${rangeBound}`);

  // 市場全体の動き
  const marketOpen = marketBiasAt(0);
  const marketMid = marketBiasAt(0.5);
  const marketClose = marketBiasAt(1.0);
  console.log(`市場地合い: 寄り=${(marketOpen*100).toFixed(2)}% 中間=${(marketMid*100).toFixed(2)}% 引け=${(marketClose*100).toFixed(2)}%`);

  let dayTotal = 0;
  const stockResults: Array<{ symbol: string; name: string; profit: number; trades: number; details: string[] }> = [];

  for (const s of TARGET_STOCKS) {
    const candles = candleMap.get(s.symbol);
    if (!candles) continue;

    const res = simulateStockReal(
      s.symbol, s.ticker, s.name, candles, marketBiasAt,
      3_000_000, 70, 30, 2.0, rangeBound, 1.0,
      { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT }
    );
    if (!res) continue;

    dayTotal += res.profitAmount;

    if (res.profitAmount === 0 && res.tradesCount === 0) continue;

    const details: string[] = [];
    let openTrade: { time: string; price: number; shares: number; type: string } | null = null;

    for (const t of res.trades) {
      if (t.type === "buy" || t.type === "short") {
        openTrade = { time: t.time, price: t.price, shares: t.shares, type: t.type };
      } else if ((t.type === "sell" || t.type === "cover") && openTrade) {
        const profit = t.profit ?? 0;
        const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
        const reason = sig?.reason ?? "不明";
        const pnlStr = profit >= 0 ? `+${profit.toLocaleString()}` : profit.toLocaleString();
        details.push(`  ${openTrade.type === "short" ? "S" : "L"} ${openTrade.time}→${t.time} @${openTrade.price}→${t.price} ${openTrade.shares}株 ${pnlStr}円 [${reason}]`);
        openTrade = null;
      }
    }

    stockResults.push({ symbol: s.symbol, name: s.name, profit: res.profitAmount, trades: res.tradesCount, details });
  }

  // 損失の大きい順にソート
  stockResults.sort((a, b) => a.profit - b.profit);

  for (const r of stockResults) {
    const pnlStr = r.profit >= 0 ? `+${r.profit.toLocaleString()}` : r.profit.toLocaleString();
    console.log(`\n[${r.symbol}] ${r.name}: ${pnlStr}円 (${r.trades}取引)`);
    for (const d of r.details) console.log(d);
  }

  console.log(`\n📊 ${day} 合計: ${dayTotal >= 0 ? "+" : ""}${dayTotal.toLocaleString()}円`);
  return { day, total: dayTotal, eff, rangeBound };
}

function main() {
  const dataDir = path.join(process.cwd(), "analysis", "jq_data");

  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(dataDir, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  // 最悪日と周辺の日を分析
  const targetDays = ["2026-03-09", "2026-04-27"];

  for (const day of targetDays) {
    analyzeDay(day, byTicker);
  }

  // 損失-30,000円以上の全日を一覧
  console.log("\n\n" + "=".repeat(60));
  console.log("損失-30,000円以上の日の一覧");
  console.log("=".repeat(60));

  const allDays = new Set<string>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) allDays.add(d);
  const sortedDays = Array.from(allDays).sort();

  const bigLossDays: Array<{ day: string; total: number; eff: number }> = [];

  for (const day of sortedDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars));
    }
    if (candleMap.size < 5) continue;

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

    let dayTotal = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT });
      if (res) dayTotal += res.profitAmount;
    }

    if (dayTotal <= -30000) {
      bigLossDays.push({ day, total: Math.round(dayTotal), eff });
    }
  }

  bigLossDays.sort((a, b) => a.total - b.total);
  console.log(`${"日付".padEnd(12)} ${"損益".padStart(10)} ${"市場効率".padStart(8)}`);
  for (const r of bigLossDays) {
    console.log(`${r.day.padEnd(12)} ${r.total.toLocaleString().padStart(10)} ${r.eff.toFixed(3).padStart(8)}`);
  }
  console.log(`\n合計 ${bigLossDays.length} 日が-30,000円以上の損失`);
}

main();
