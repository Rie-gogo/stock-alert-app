/**
 * analysis/shortStopAvoidanceSweep.ts
 *
 * 空売り損切り17件の分析結果から導いた回避フィルターをスイープ検証する。
 *
 * 分析で判明した共通パターン:
 * - 全17件が下落相場（市場バイアス < 0）でのショート
 * - RSI 35-50（売られすぎ〜中立）でのエントリーが多い
 * - 出来高比 1.0〜2.0x（平均的〜やや多い）
 * - エントリー後1本で+0.12%上昇（反発に巻き込まれる）
 *
 * 対策候補:
 * A. RSIフィルター: RSI < X でのショート禁止（売られすぎ局面でのショート禁止）
 * B. 出来高フィルター: 出来高比 > X でのショート禁止
 * C. 直前モメンタム: 直前1本が上昇中のショート禁止
 * D. 組み合わせ
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/shortStopAvoidanceSweep.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  SimOverrides,
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
function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
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

function runBacktest(overrides: SimOverrides): { totalProfit: number; tradeCount: number; winCount: number } {
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

  let totalProfit = 0, tradeCount = 0, winCount = 0;
  for (const day of allDays) {
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

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, rangeBound, 1.0, overrides);
      if (!res) continue;
      for (const t of res.trades) {
        if (t.type === "sell" || t.type === "cover") {
          const p = t.profit ?? 0;
          totalProfit += p;
          tradeCount++;
          if (p > 0) winCount++;
        }
      }
    }
  }
  return { totalProfit, tradeCount, winCount };
}

// ベースライン
const BASE_OVERRIDES: SimOverrides = {
  shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
  lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
};

console.log("ベースライン計算中...");
const baseline = runBacktest(BASE_OVERRIDES);
console.log(`ベースライン: 総損益 ${baseline.totalProfit.toLocaleString()}円, ${baseline.tradeCount}取引, 勝率 ${(baseline.winCount / baseline.tradeCount * 100).toFixed(1)}%\n`);

// ━━━ スイープシナリオ ━━━
// SimOverridesにはnoShortAfterHour/noLongAfterHourがある。
// RSIフィルター・出来高フィルターはSimOverridesに存在しないため、
// 代わりに「ショート損切り幅をさらに縮小」「ショート最小RSI閾値」などを
// SimOverridesに追加して検証する必要がある。
// ここでは既存のSimOverridesで試せる範囲でスイープする。

interface Scenario {
  label: string;
  overrides: SimOverrides;
}

const scenarios: Scenario[] = [
// ショート損切り幅のさらなる縮小
  { label: "ショート損切り 0.45%", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.45 } },
  { label: "ショート損切り 0.40%", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.40 } },
  { label: "ショート損切り 0.35%", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.35 } },
  { label: "ショート損切り 0.30%", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.30 } },
  // 昂休み前決済を早める（プルバック前に逃げる）
  { label: "昂休み前決済 11:10", overrides: { ...BASE_OVERRIDES, lunchExitAllMinute: "11:10" } },
  { label: "昂休み前決済 11:00", overrides: { ...BASE_OVERRIDES, lunchExitAllMinute: "11:00" } },
  { label: "昂休み前決済 10:50", overrides: { ...BASE_OVERRIDES, lunchExitAllMinute: "10:50" } },
  // ショートの最大保有時間を短縮（プルバックが長引く前に逃げる）
  { label: "ショート最大保有60本", overrides: { ...BASE_OVERRIDES, maxShortHoldBars: 60 } },
  { label: "ショート最大保有40本", overrides: { ...BASE_OVERRIDES, maxShortHoldBars: 40 } },
  { label: "ショート最大保有30本", overrides: { ...BASE_OVERRIDES, maxShortHoldBars: 30 } },
  { label: "ショート最大保有20本", overrides: { ...BASE_OVERRIDES, maxShortHoldBars: 20 } },
  { label: "ショート最大保有15本", overrides: { ...BASE_OVERRIDES, maxShortHoldBars: 15 } },
  // RSIフィルター: 売られすぎ局面でのショート禁止
  { label: "RSI最小値 40", overrides: { ...BASE_OVERRIDES, shortMinRsi: 40 } },
  { label: "RSI最小値 45", overrides: { ...BASE_OVERRIDES, shortMinRsi: 45 } },
  { label: "RSI最小値 50", overrides: { ...BASE_OVERRIDES, shortMinRsi: 50 } },
  // 出来高急増フィルター
  { label: "出来高比 >2.0x ショート禁止", overrides: { ...BASE_OVERRIDES, shortMaxVolRatio: 2.0 } },
  { label: "出来高比 >1.5x ショート禁止", overrides: { ...BASE_OVERRIDES, shortMaxVolRatio: 1.5 } },
  { label: "出来高比 >1.2x ショート禁止", overrides: { ...BASE_OVERRIDES, shortMaxVolRatio: 1.2 } },
  // 9時台のショート禁止（9時台4件/-29,800円）
  { label: "9時台ショート禁止", overrides: { ...BASE_OVERRIDES, noShortAfterHour: 9 } },
  // 組み合わせ
  { label: "損切り0.45% + 最大保有30本", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.45, maxShortHoldBars: 30 } },
  { label: "損切り0.45% + RSI最小40", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.45, shortMinRsi: 40 } },
  { label: "RSI最小40 + 最大保有30本", overrides: { ...BASE_OVERRIDES, shortMinRsi: 40, maxShortHoldBars: 30 } },
  { label: "損切り0.45% + RSI40 + 保有30本", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.45, shortMinRsi: 40, maxShortHoldBars: 30 } },
  { label: "損切り0.45% + 昸11:10", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.45, lunchExitAllMinute: "11:10" } },
  { label: "損切り0.40% + 昸11:10", overrides: { ...BASE_OVERRIDES, shortStopLossPercent: 0.40, lunchExitAllMinute: "11:10" } },
];

console.log(`${"シナリオ".padEnd(35)} ${"総損益".padStart(12)} ${"差分".padStart(10)} ${"取引数".padStart(6)} ${"勝率".padStart(7)}`);
console.log("-".repeat(75));

const results: { label: string; totalProfit: number; diff: number; tradeCount: number; winRate: number }[] = [];

for (const s of scenarios) {
  const r = runBacktest(s.overrides);
  const diff = r.totalProfit - baseline.totalProfit;
  const winRate = r.tradeCount > 0 ? r.winCount / r.tradeCount * 100 : 0;
  results.push({ label: s.label, totalProfit: r.totalProfit, diff, tradeCount: r.tradeCount, winRate });
  const diffStr = diff >= 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
  console.log(`${s.label.padEnd(35)} ${r.totalProfit.toLocaleString().padStart(12)} ${diffStr.padStart(10)} ${r.tradeCount.toString().padStart(6)} ${winRate.toFixed(1).padStart(6)}%`);
}

// 最良シナリオ
const best = results.reduce((a, b) => a.totalProfit > b.totalProfit ? a : b);
console.log(`\n最良シナリオ: "${best.label}" → 総損益 ${best.totalProfit.toLocaleString()}円 (差分: ${best.diff >= 0 ? "+" : ""}${best.diff.toLocaleString()}円)`);
