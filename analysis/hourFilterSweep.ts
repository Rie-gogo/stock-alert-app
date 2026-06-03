/**
 * analysis/hourFilterSweep.ts
 *
 * 時間帯フィルターの効果を検証する。
 *
 * 分析で判明した損失:
 *   10時×short: 18件 / -113,750円 / 平均-6,319円
 *   10時×long:   8件 /  -48,800円 / 平均-6,100円
 *   9時×short:   8件 /  -40,300円 / 平均-5,037円
 *   11時×short: 18件 /  -23,900円 / 平均-1,328円（小損多数）
 *   9時×long:    2件 /  -13,900円 / 平均-6,950円
 *   11時×long:   3件 /  -12,100円 / 平均-4,033円
 *
 * 検証: noShortAfterHour と noLongAfterHour の各組み合わせ
 */

import * as fs from "fs";
import * as path from "path";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import { TARGET_STOCKS } from "../shared/stocks";

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }
interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

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
function barsToCandles(bars: JqBar[], date: string): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBB(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= 9) { let s = 0; for (let k = i - 9; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= 25 && c.ma25 !== null) { const prev = candles[i - 25].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

const DATA_DIR = path.join(process.cwd(), "analysis", "jq_data");

function loadData() {
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(DATA_DIR, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) continue;
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  return { byTicker, allDays };
}

interface SweepOverrides {
  shortStopLossPercent?: number;
  lunchExitAllMinute?: string;
  noShortAfterHour?: number;
  noLongAfterHour?: number;
}

function runBacktest(byTicker: Map<string, Map<string, JqBar[]>>, allDays: string[], overrides: SweepOverrides): number {
  let grandTotal = 0;
  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, barsToCandles(bars, day));
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
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        {
          shortStopLossPercent: overrides.shortStopLossPercent ?? SHORT_STOP_LOSS_PERCENT,
          lunchExitAllMinute: overrides.lunchExitAllMinute ?? LUNCH_EXIT_ALL_MINUTE,
          noShortAfterHour: overrides.noShortAfterHour,
          noLongAfterHour: overrides.noLongAfterHour,
        }
      );
      if (!res) continue;
      grandTotal += res.profitAmount;
    }
  }
  return grandTotal;
}

function main() {
  console.log("データ読み込み中...");
  const { byTicker, allDays } = loadData();
  const baseline = runBacktest(byTicker, allDays, {});
  console.log(`ベースライン: ${baseline.toLocaleString()}円\n`);

  // ─── ショート時間帯フィルター ──────────────────────────────────────────────────
  console.log("━━━ noShortAfterHour スイープ ━━━");
  const shortHourCandidates = [9, 10, 11, undefined as number | undefined];
  let bestShortHour: number | undefined = undefined;
  let bestShortHourProfit = baseline;
  for (const h of shortHourCandidates) {
    const profit = runBacktest(byTicker, allDays, { noShortAfterHour: h });
    const diff = profit - baseline;
    const label = h === undefined ? "なし（現在）" : `${h}時以降ショート禁止`;
    const mark = diff > 0 ? " ↑" : "";
    console.log(`  ${label}: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)${mark}`);
    if (profit > bestShortHourProfit) { bestShortHourProfit = profit; bestShortHour = h; }
  }
  console.log(`  → 最良: ${bestShortHour === undefined ? "なし" : `${bestShortHour}時以降ショート禁止`} (+${(bestShortHourProfit - baseline).toLocaleString()}円)\n`);

  // ─── ロング時間帯フィルター ──────────────────────────────────────────────────
  console.log("━━━ noLongAfterHour スイープ ━━━");
  const longHourCandidates = [10, 11, undefined as number | undefined];
  let bestLongHour: number | undefined = undefined;
  let bestLongHourProfit = baseline;
  for (const h of longHourCandidates) {
    const profit = runBacktest(byTicker, allDays, { noLongAfterHour: h });
    const diff = profit - baseline;
    const label = h === undefined ? "なし（現在）" : `${h}時以降ロング禁止`;
    const mark = diff > 0 ? " ↑" : "";
    console.log(`  ${label}: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)${mark}`);
    if (profit > bestLongHourProfit) { bestLongHourProfit = profit; bestLongHour = h; }
  }
  console.log(`  → 最良: ${bestLongHour === undefined ? "なし" : `${bestLongHour}時以降ロング禁止`} (+${(bestLongHourProfit - baseline).toLocaleString()}円)\n`);

  // ─── 全組み合わせ最良 ─────────────────────────────────────────────────────────
  console.log("━━━ 全対策組み合わせ（最良候補） ━━━");
  const combos = [
    { label: "ベースライン", shortStop: SHORT_STOP_LOSS_PERCENT, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: undefined as number | undefined, noLongH: undefined as number | undefined },
    { label: "shortStop=0.50%", shortStop: 0.50, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: undefined, noLongH: undefined },
    { label: `noShortAfterHour=${bestShortHour}`, shortStop: SHORT_STOP_LOSS_PERCENT, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: bestShortHour, noLongH: undefined },
    { label: `noLongAfterHour=${bestLongHour}`, shortStop: SHORT_STOP_LOSS_PERCENT, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: undefined, noLongH: bestLongHour },
    { label: `shortStop=0.50% + noShortH=${bestShortHour}`, shortStop: 0.50, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: bestShortHour, noLongH: undefined },
    { label: `shortStop=0.50% + noShortH=${bestShortHour} + noLongH=${bestLongHour}`, shortStop: 0.50, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: bestShortHour, noLongH: bestLongHour },
    { label: `全対策最良`, shortStop: 0.50, lunchExit: LUNCH_EXIT_ALL_MINUTE, noShortH: bestShortHour, noLongH: bestLongHour },
  ];
  let bestCombo = combos[0];
  let bestComboProfit = baseline;
  for (const c of combos) {
    const profit = runBacktest(byTicker, allDays, { shortStopLossPercent: c.shortStop, lunchExitAllMinute: c.lunchExit, noShortAfterHour: c.noShortH, noLongAfterHour: c.noLongH });
    const diff = profit - baseline;
    const mark = diff > 0 ? " ↑" : "";
    console.log(`  ${c.label}: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)${mark}`);
    if (profit > bestComboProfit) { bestComboProfit = profit; bestCombo = c; }
  }
  console.log(`\n  ★ 最良組み合わせ: ${bestCombo.label}`);
  console.log(`    総損益: ${bestComboProfit.toLocaleString()}円 (ベースライン比 +${(bestComboProfit - baseline).toLocaleString()}円)`);
}

main();
