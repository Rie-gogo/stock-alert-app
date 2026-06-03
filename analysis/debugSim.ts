/**
 * analysis/debugSim.ts
 * simulateStockReal の戻り値を確認する
 */
import * as fs from "fs";
import * as path from "path";
import { simulateStockReal, SHORT_STOP_LOSS_PERCENT, LUNCH_EXIT_ALL_MINUTE } from "../server/realSimulation";
import { TARGET_STOCKS } from "../shared/stocks";

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

function calcMA(data: number[], period: number): (number | null)[] {
  const r: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) r[i] = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
  return r;
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const r: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return r;
  const gains: number[] = [], losses: number[] = [];
  for (let i = 1; i < data.length; i++) { const d = data[i] - data[i - 1]; gains.push(Math.max(d, 0)); losses.push(Math.max(-d, 0)); }
  let ag = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let al = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    r[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
    if (i < data.length - 1) { ag = (ag * (period - 1) + gains[i]) / period; al = (al * (period - 1) + losses[i]) / period; }
  }
  return r;
}
function calcBB(data: number[], period = 20, m = 2) {
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

const DATA_DIR = path.join(process.cwd(), "analysis", "jq_data");
const s = TARGET_STOCKS[0];
const fp = path.join(DATA_DIR, s.symbol + ".json");
const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
const byDay = new Map<string, JqBar[]>();
for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
const days = Array.from(byDay.keys()).sort();

// 最初の有効な日を探す
for (const day of days) {
  const dayBars = byDay.get(day);
  if (!dayBars || dayBars.length < 60) continue;
  const sorted = dayBars.sort((a, b) => a.Time.localeCompare(b.Time));
  const candles = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(day, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null as number | null, ma25: null as number | null, rsi: null as number | null,
    bbUpper: null as number | null, bbLower: null as number | null, flow: null as number | null, slope: null as number | null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBB(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });

  const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, () => 0, 3_000_000, 70, 30, 2.0, false, 1.0, {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
  });

  console.log(`\n=== ${day} ===`);
  console.log("res:", res ? "not null" : "null");
  if (res) {
    console.log("trades count:", res.trades.length);
    console.log("signals count:", res.signals?.length ?? 0);
    console.log("lossCauses:", res.lossCauses);
    for (const t of res.trades) {
      console.log("  trade:", JSON.stringify(t));
    }
    for (const sig of res.signals ?? []) {
      if (sig.type === "sell" || sig.type === "cover") {
        console.log("  signal:", JSON.stringify(sig));
      }
    }
    if (res.trades.length > 0) break;
  }
}
