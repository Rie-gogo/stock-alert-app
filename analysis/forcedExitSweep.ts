/**
 * analysis/forcedExitSweep.ts
 *
 * 昼休み前強制決済・引け値強制決済の損失削減対策をスイープ検証する。
 *
 * 対策候補:
 *   A. 11:10以降のショートエントリー禁止（11時台3分保有ショートを排除）
 *   B. 11:00以降のショートエントリー禁止
 *   C. 10:45以降のロングエントリー禁止（昼休み前に決済できる時間を確保）
 *   D. 10:30以降のロングエントリー禁止
 *   E. 10:00以降のロングエントリー禁止（10時台ロング全禁止）
 *   F. A + C の組み合わせ
 *   G. A + D の組み合わせ
 *   H. B + D の組み合わせ
 *   I. 引け値強制決済対策: 14:30以降のエントリー禁止
 *   J. 引け値強制決済対策: 14:00以降のエントリー禁止
 *   K. 引け値強制決済対策: 13:30以降のエントリー禁止
 *   L. A + D + I の組み合わせ
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

// ─── 型定義 ────────────────────────────────────────────────────────────────────

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }
interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

// ─── 指標計算 ──────────────────────────────────────────────────────────────────

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

// ─── データ読み込み ────────────────────────────────────────────────────────────

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

// ─── バックテスト実行（SimOverridesを使わず、キャンドルをフィルタリング） ────

function timeToMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * noShortAfterMin: この分以降のショートエントリーを禁止（例: 11:10 → 670）
 * noLongAfterMin: この分以降のロングエントリーを禁止（例: 10:30 → 630）
 * noEntryAfterMin: この分以降の全エントリーを禁止（引け値対策）
 */
function runBacktest(
  byTicker: Map<string, Map<string, JqBar[]>>,
  allDays: string[],
  noShortAfterMin: number | null,
  noLongAfterMin: number | null,
  noEntryAfterMin: number | null,
): number {
  let grandTotal = 0;

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

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        {
          shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
          lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
          noShortAfterHour: noShortAfterMin !== null ? Math.floor(noShortAfterMin / 60) : undefined,
          noLongAfterHour: noLongAfterMin !== null ? Math.floor(noLongAfterMin / 60) : undefined,
        }
      );
      if (!res) continue;
      grandTotal += res.profitAmount;
    }
  }

  return Math.round(grandTotal);
}

// ─── より細かい時刻フィルター（SimOverridesに分単位を追加） ─────────────────
// SimOverridesにはhour単位しかないため、分単位のフィルターは別の方法で実装する
// → 代わりに、by_reason.csvのデータを使って対策の効果を推定する

function runBacktestWithMinuteFilter(
  byTicker: Map<string, Map<string, JqBar[]>>,
  allDays: string[],
  noShortAfterMinute: number | null,  // 例: 11*60+10 = 670
  noLongAfterMinute: number | null,   // 例: 10*60+30 = 630
  noEntryAfterMinute: number | null,  // 例: 14*60+30 = 870
): number {
  let grandTotal = 0;

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

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        {
          shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
          lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
        }
      );
      if (!res) continue;

      // 分単位フィルターを適用: 対象エントリーをスキップした場合の損益を計算
      let filteredProfit = 0;
      let openEntry: { time: string; price: number; shares: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          const entryMin = timeToMinutes(t.time);
          let skip = false;
          if (noShortAfterMinute !== null && t.type === "short" && entryMin >= noShortAfterMinute) skip = true;
          if (noLongAfterMinute !== null && t.type === "buy" && entryMin >= noLongAfterMinute) skip = true;
          if (noEntryAfterMinute !== null && entryMin >= noEntryAfterMinute) skip = true;
          if (!skip) openEntry = { time: t.time, price: t.price, shares: t.shares, type: t.type };
          else openEntry = null; // スキップ
        } else if ((t.type === "sell" || t.type === "cover") && openEntry) {
          filteredProfit += t.profit ?? 0;
          openEntry = null;
        }
        // openEntryがnullの場合（スキップされたエントリー）は決済もスキップ
      }
      grandTotal += filteredProfit;
    }
  }

  return Math.round(grandTotal);
}

// ─── メイン ────────────────────────────────────────────────────────────────────

function main() {
  console.log("データ読み込み中...");
  const { byTicker, allDays } = loadData();
  console.log(`  ${allDays.length} 営業日\n`);

  const baseline = runBacktestWithMinuteFilter(byTicker, allDays, null, null, null);
  console.log(`ベースライン: ${baseline.toLocaleString()}円\n`);

  const scenarios = [
    { label: "A: 11:10以降のショート禁止", noShort: 11 * 60 + 10, noLong: null as number | null, noEntry: null as number | null },
    { label: "B: 11:00以降のショート禁止", noShort: 11 * 60 + 0, noLong: null, noEntry: null },
    { label: "C: 10:45以降のロング禁止", noShort: null, noLong: 10 * 60 + 45, noEntry: null },
    { label: "D: 10:30以降のロング禁止", noShort: null, noLong: 10 * 60 + 30, noEntry: null },
    { label: "E: 10:00以降のロング禁止", noShort: null, noLong: 10 * 60 + 0, noEntry: null },
    { label: "F: A + C（11:10ショート禁止 + 10:45ロング禁止）", noShort: 11 * 60 + 10, noLong: 10 * 60 + 45, noEntry: null },
    { label: "G: A + D（11:10ショート禁止 + 10:30ロング禁止）", noShort: 11 * 60 + 10, noLong: 10 * 60 + 30, noEntry: null },
    { label: "H: B + D（11:00ショート禁止 + 10:30ロング禁止）", noShort: 11 * 60 + 0, noLong: 10 * 60 + 30, noEntry: null },
    { label: "I: 14:30以降エントリー禁止（引け値対策）", noShort: null, noLong: null, noEntry: 14 * 60 + 30 },
    { label: "J: 14:00以降エントリー禁止（引け値対策）", noShort: null, noLong: null, noEntry: 14 * 60 + 0 },
    { label: "K: 13:30以降エントリー禁止（引け値対策）", noShort: null, noLong: null, noEntry: 13 * 60 + 30 },
    { label: "L: A + D + I（11:10ショート禁止 + 10:30ロング禁止 + 14:30エントリー禁止）", noShort: 11 * 60 + 10, noLong: 10 * 60 + 30, noEntry: 14 * 60 + 30 },
    { label: "M: A + D + J（11:10ショート禁止 + 10:30ロング禁止 + 14:00エントリー禁止）", noShort: 11 * 60 + 10, noLong: 10 * 60 + 30, noEntry: 14 * 60 + 0 },
  ];

  console.log("シナリオ検証中...\n");
  const results: { label: string; profit: number; diff: number }[] = [];

  for (const s of scenarios) {
    const profit = runBacktestWithMinuteFilter(byTicker, allDays, s.noShort, s.noLong, s.noEntry);
    const diff = profit - baseline;
    results.push({ label: s.label, profit, diff });
    console.log(`  ${s.label}: ${profit.toLocaleString()}円 (差分: ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  }

  // 結果を差分順に表示
  console.log("\n━━━ 結果サマリー（差分順） ━━━");
  for (const r of results.sort((a, b) => b.diff - a.diff)) {
    const sign = r.diff >= 0 ? "+" : "";
    console.log(`  ${sign}${r.diff.toLocaleString()}円  ${r.label}: ${r.profit.toLocaleString()}円`);
  }

  console.log(`\nベースライン: ${baseline.toLocaleString()}円`);
  console.log("注意: このスクリプトはエントリーをスキップする方式で計算しているため、");
  console.log("      実際の SimOverrides を使った場合と若干異なる可能性があります。");
}

main();
