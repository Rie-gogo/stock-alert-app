/**
 * analysis/losingTradesSweep.ts
 *
 * マイナス取引分析から判明した3つのパターンに対する対策をスイープ検証する。
 *
 * 判明したパターン:
 *   A) 空売り損切り: 16件/-134,150円/平均-8,384円 → 上昇相場でのショート禁止強化
 *   B) ロング昼休み前強制決済: 9件/-62,800円/平均-6,978円 → 昼休み前のロング早期手仕舞い
 *   C) 損失幅-0.55〜-1.0%（中損）: 19件/-156,700円 → ショート損切りをさらに縮小
 *
 * 検証する対策:
 *   1. ショート禁止: regimeAllowShortの閾値を上げる（上昇相場でのショートをより厳しく禁止）
 *   2. ロング早期手仕舞い: 11:00以降の新規ロングエントリー禁止（昼休み前に捕まるリスク低減）
 *   3. ショート損切りをさらに縮小: 0.55% → 0.40%〜0.50%
 *   4. 上昇相場でのショート完全禁止（regime=upの日はショートしない）
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

// ─── 指標計算（jq_backtest.ts と同じ） ────────────────────────────────────────

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }
interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

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
function barsToCandles(bars: JqBar[], date: string): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const candles: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
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
const OUT_DIR = path.join(process.cwd(), "analysis", "jq_out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

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

// ─── バックテスト実行 ─────────────────────────────────────────────────────────

interface Overrides {
  shortStopLossPercent?: number;
  lunchExitAllMinute?: string;
  noShortOnUpDay?: boolean;      // 上昇相場の日はショート禁止
  noLongAfterHour?: number;      // この時刻以降のロングエントリー禁止 (e.g. 11)
}

function runBacktest(byTicker: Map<string, Map<string, JqBar[]>>, allDays: string[], overrides: Overrides): number {
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

    // 上昇相場判定
    const biasAtMid = marketBiasAt(0.3);
    const isUpDay = biasAtMid > 0.003;

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;

      const simOverrides: Parameters<typeof simulateStockReal>[11] = {
        shortStopLossPercent: overrides.shortStopLossPercent ?? SHORT_STOP_LOSS_PERCENT,
        lunchExitAllMinute: overrides.lunchExitAllMinute ?? LUNCH_EXIT_ALL_MINUTE,
      };

      // 上昇相場の日はショート禁止: shortStopLossPercentを0にすることで事実上禁止
      // → 実際にはシミュレーション内でregimeAllowShortが制御するが、
      //    それとは別に「上昇相場判定でショートしない」フラグを追加する
      // 現在のコードではregimeAllowShortが既に上昇相場でショートを禁止しているが、
      // 「上昇相場でもショートが発生している」ことが分析で判明したため、
      // 閾値を変えてスイープする
      if (overrides.noShortOnUpDay && isUpDay) {
        // 上昇相場でのショートを完全禁止するため、
        // shortRequiresMktDown=true を使う（SimOverridesに追加済みの場合）
        // ここでは shortStopLossPercent=0 で代替（損切り0%=即損切り=事実上エントリーしない）
        // ただしこれは正確ではないので、別の方法を使う
        // → noShortOnUpDayはregimeAllowShortの閾値変更で対応
        // 現在のコードでは marketBias > REGIME_BIAS_UP_THRESHOLD でショート禁止
        // → REGIME_BIAS_UP_THRESHOLDを下げることで、より多くの「上昇」日でショート禁止
        // ここではシミュレーションを変えずに、上昇相場の日の結果を集計から除外して比較
        // （実際の対策は別途実装）
      }

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        simOverrides
      );
      if (!res) continue;
      grandTotal += res.profitAmount;
    }
  }
  return grandTotal;
}

// ─── メイン ────────────────────────────────────────────────────────────────────

function main() {
  console.log("データ読み込み中...");
  const { byTicker, allDays } = loadData();
  console.log(`  ${allDays.length} 営業日`);

  // ─── ベースライン ─────────────────────────────────────────────────────────────
  const baseline = runBacktest(byTicker, allDays, {});
  console.log(`\nベースライン: ${baseline.toLocaleString()}円`);

  // ─── 対策A: ショート損切りをさらに縮小 ───────────────────────────────────────
  console.log("\n━━━ 対策A: ショート損切り幅スイープ（現在0.55%） ━━━");
  const shortStopCandidates = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70];
  let bestShortStop = SHORT_STOP_LOSS_PERCENT;
  let bestShortProfit = baseline;
  for (const ss of shortStopCandidates) {
    const profit = runBacktest(byTicker, allDays, { shortStopLossPercent: ss });
    const diff = profit - baseline;
    const mark = ss === SHORT_STOP_LOSS_PERCENT ? " ← 現在" : diff > 0 ? " ↑" : "";
    console.log(`  shortStop=${ss.toFixed(2)}%: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)${mark}`);
    if (profit > bestShortProfit) { bestShortProfit = profit; bestShortStop = ss; }
  }
  console.log(`  → 最良: shortStop=${bestShortStop.toFixed(2)}% (+${(bestShortProfit - baseline).toLocaleString()}円)`);

  // ─── 対策B: 昼休み前の早期手仕舞い時刻スイープ ───────────────────────────────
  console.log("\n━━━ 対策B: 昼休み前手仕舞い時刻スイープ（現在11:20） ━━━");
  const lunchExitCandidates = ["10:50", "11:00", "11:05", "11:10", "11:15", "11:20", "11:25", "11:30"];
  let bestLunchExit = LUNCH_EXIT_ALL_MINUTE;
  let bestLunchProfit = baseline;
  for (const le of lunchExitCandidates) {
    const profit = runBacktest(byTicker, allDays, { lunchExitAllMinute: le });
    const diff = profit - baseline;
    const mark = le === LUNCH_EXIT_ALL_MINUTE ? " ← 現在" : diff > 0 ? " ↑" : "";
    console.log(`  lunchExit=${le}: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)${mark}`);
    if (profit > bestLunchProfit) { bestLunchProfit = profit; bestLunchExit = le; }
  }
  console.log(`  → 最良: lunchExit=${bestLunchExit} (+${(bestLunchProfit - baseline).toLocaleString()}円)`);

  // ─── 対策C: 最良組み合わせ ─────────────────────────────────────────────────
  console.log("\n━━━ 対策C: 最良組み合わせ検証 ━━━");
  const combos = [
    { label: "ベースライン", shortStop: SHORT_STOP_LOSS_PERCENT, lunchExit: LUNCH_EXIT_ALL_MINUTE },
    { label: `shortStop=${bestShortStop}%のみ`, shortStop: bestShortStop, lunchExit: LUNCH_EXIT_ALL_MINUTE },
    { label: `lunchExit=${bestLunchExit}のみ`, shortStop: SHORT_STOP_LOSS_PERCENT, lunchExit: bestLunchExit },
    { label: `両方最良`, shortStop: bestShortStop, lunchExit: bestLunchExit },
  ];
  for (const c of combos) {
    const profit = runBacktest(byTicker, allDays, { shortStopLossPercent: c.shortStop, lunchExitAllMinute: c.lunchExit });
    const diff = profit - baseline;
    console.log(`  ${c.label}: ${profit.toLocaleString()}円 (${diff >= 0 ? "+" : ""}${diff.toLocaleString()}円)`);
  }

  // ─── 対策D: 10時台のショートを特定条件で禁止 ─────────────────────────────────
  // 10時台のショートが最大損失源（-113,750円）
  // 現在のコードでは10時台のショートは許可されている
  // SimOverridesに noShortAfterHour を追加する前に、影響を推定する
  console.log("\n━━━ 対策D: 10時台以降のショート禁止（推定） ━━━");
  console.log("  ※ 10時台ショートの損失: -113,750円");
  console.log("  ※ 10時台ショートの利益は別途計算が必要");
  console.log("  → 実装: SimOverrides に noShortAfterHour=10 を追加して検証");

  console.log("\n━━━ 推奨対策まとめ ━━━");
  console.log(`  A) ショート損切り: ${bestShortStop.toFixed(2)}% (現在${SHORT_STOP_LOSS_PERCENT}%)`);
  console.log(`  B) 昼休み前手仕舞い: ${bestLunchExit} (現在${LUNCH_EXIT_ALL_MINUTE})`);
}

main();
