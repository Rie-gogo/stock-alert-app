/**
 * analysis/symbolCharacteristicsAnalysis.ts
 *
 * マイナス取引の銘柄特性を詳細分析する。
 *
 * 分析軸:
 *   1. セクター別マイナス取引集計
 *   2. 当日ギャップアップ/ダウン幅（寄り値と前日終値の乖離）
 *   3. 当日出来高急増率（当日出来高 vs 直近5日平均）
 *   4. 日中ボラティリティ（当日の高値-安値 / 寄り値）
 *   5. エントリー時点の出来高急増（エントリー足の出来高 vs 直近10本平均）
 *   6. 銘柄×損切り種別のクロス集計
 *   7. 銘柄×セクター×損益の詳細テーブル
 *   8. 各銘柄の「マイナス取引が多い日の特徴」
 *   9. HIGH_VOL_SYMBOLS（極小ロット銘柄）の損益貢献分析
 */

import * as fs from "fs";
import * as path from "path";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
  REGIME_CONSTANTS,
} from "../server/realSimulation";
import { TARGET_STOCKS, getSector } from "../shared/stocks";

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

// ─── 拡張マイナス取引型 ────────────────────────────────────────────────────────

interface LossTradeWithContext {
  date: string;
  symbol: string;
  name: string;
  sector: string;
  direction: "long" | "short";
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  profit: number;
  profitPct: number;
  holdBars: number;
  stopReason: string;
  regime: string;
  isHighVolSymbol: boolean;
  // 銘柄特性（当日）
  gapPct: number;           // ギャップ（寄り値 vs 前日終値）%
  intraDayVol: number;      // 日中ボラ（高値-安値 / 寄り値）%
  dayVolume: number;        // 当日総出来高
  // エントリー時点の特性
  entryVolRatio: number;    // エントリー足の出来高 / 直近10本平均
}

// ─── メイン ────────────────────────────────────────────────────────────────────

function main() {
  console.log("J-Quants データ読み込み中...");
  const { byTicker, allDays } = loadData();
  console.log(`  ${byTicker.size} 銘柄, ${allDays.length} 営業日\n`);

  const allLossTrades: LossTradeWithContext[] = [];
  const allTrades: { profit: number; symbol: string; sector: string; isHighVol: boolean }[] = [];
  let totalProfit = 0;

  // 前日終値を記録（ギャップ計算用）
  const prevClose = new Map<string, number>(); // symbol -> 前日終値

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
    const biasAtMid = marketBiasAt(0.3);
    const regime = biasAtMid > 0.003 ? "up" : biasAtMid < -0.003 ? "down" : "neutral";

    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;

      // 当日の銘柄特性を計算
      const open = candles[0]?.open ?? 0;
      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const close = candles[candles.length - 1]?.close ?? 0;
      const dayVolume = candles.reduce((s, c) => s + c.volume, 0);
      const intraDayVol = open > 0 ? ((high - low) / open) * 100 : 0;
      const prevC = prevClose.get(s.symbol);
      const gapPct = prevC && prevC > 0 ? ((open - prevC) / prevC) * 100 : 0;

      // 前日終値を更新
      prevClose.set(s.symbol, close);

      const isHighVolSymbol = REGIME_CONSTANTS.HIGH_VOL_SYMBOLS.has(s.symbol);

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;

      totalProfit += res.profitAmount;

      let openEntry: { time: string; price: number; shares: number; type: "buy" | "short"; barIdx: number } | null = null;

      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          const barIdx = candles.findIndex(c => c.time === t.time);
          openEntry = { time: t.time, price: t.price, shares: t.shares, type: t.type, barIdx };
        } else if ((t.type === "sell" || t.type === "cover") && openEntry) {
          const profit = t.profit ?? 0;
          allTrades.push({ profit, symbol: s.symbol, sector: getSector(s.symbol), isHighVol: isHighVolSymbol });

          if (profit < 0) {
            const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
            const rawReason = sig?.reason ?? "";
            const stopReason = rawReason.split("(")[0].trim() || "不明";

            const exitIdx = candles.findIndex(c => c.time === t.time);
            const holdBars = exitIdx >= openEntry.barIdx && openEntry.barIdx >= 0 ? exitIdx - openEntry.barIdx : 0;

            const direction = openEntry.type === "short" ? "short" : "long";
            const rawPct = openEntry.price > 0 ? ((t.price - openEntry.price) / openEntry.price) * 100 : 0;
            const profitPct = direction === "short" ? -rawPct : rawPct;

            // エントリー時点の出来高比率（エントリー足 / 直近10本平均）
            const entryBar = candles[openEntry.barIdx];
            const prevBars = candles.slice(Math.max(0, openEntry.barIdx - 10), openEntry.barIdx);
            const avgVol = prevBars.length > 0 ? prevBars.reduce((s, c) => s + c.volume, 0) / prevBars.length : 1;
            const entryVolRatio = avgVol > 0 ? (entryBar?.volume ?? 0) / avgVol : 1;

            allLossTrades.push({
              date: day,
              symbol: s.symbol,
              name: s.name,
              sector: getSector(s.symbol),
              direction,
              entryTime: openEntry.time,
              exitTime: t.time,
              entryPrice: openEntry.price,
              exitPrice: t.price,
              profit,
              profitPct,
              holdBars,
              stopReason,
              regime,
              isHighVolSymbol,
              gapPct,
              intraDayVol,
              dayVolume,
              entryVolRatio,
            });
          }
          openEntry = null;
        }
      }
    }
  }

  const totalLoss = allLossTrades.reduce((s, t) => s + t.profit, 0);
  const totalGain = allTrades.filter(t => t.profit > 0).reduce((s, t) => s + t.profit, 0);
  const winCount = allTrades.filter(t => t.profit > 0).length;
  const lossCount = allLossTrades.length;

  console.log(`━━━ 全体サマリー ━━━`);
  console.log(`全取引: ${allTrades.length}件 (勝${winCount} / 負${lossCount})`);
  console.log(`勝率: ${((winCount / allTrades.length) * 100).toFixed(1)}%`);
  console.log(`総損益: ${totalProfit.toLocaleString()}円`);
  console.log(`利益合計: +${totalGain.toLocaleString()}円`);
  console.log(`損失合計: ${totalLoss.toLocaleString()}円`);
  console.log(`損益比(PF): ${Math.abs(totalGain / totalLoss).toFixed(2)}`);

  // ─── 1. セクター別 ──────────────────────────────────────────────────────────
  console.log("\n━━━ 1. セクター別マイナス取引 ━━━");
  const bySector = new Map<string, { lossCount: number; totalLoss: number; totalTrades: number; totalProfit: number }>();
  for (const t of allTrades) {
    const e = bySector.get(t.sector) ?? { lossCount: 0, totalLoss: 0, totalTrades: 0, totalProfit: 0 };
    e.totalTrades++;
    e.totalProfit += t.profit;
    if (t.profit < 0) { e.lossCount++; e.totalLoss += t.profit; }
    bySector.set(t.sector, e);
  }
  console.log(`  ${"セクター".padEnd(12)} | ${"負け".padStart(4)} | ${"損失合計".padStart(12)} | ${"全取引".padStart(6)} | ${"勝率".padStart(6)} | ${"損益合計".padStart(12)}`);
  console.log(`  ${"─".repeat(70)}`);
  for (const [sec, v] of Array.from(bySector.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    const winRate = ((v.totalTrades - v.lossCount) / v.totalTrades * 100).toFixed(0);
    console.log(`  ${sec.padEnd(12)} | ${String(v.lossCount).padStart(4)} | ${v.totalLoss.toLocaleString().padStart(12)}円 | ${String(v.totalTrades).padStart(6)} | ${winRate.padStart(5)}% | ${v.totalProfit.toLocaleString().padStart(12)}円`);
  }

  // ─── 2. ギャップアップ/ダウン幅別 ──────────────────────────────────────────
  console.log("\n━━━ 2. ギャップ幅別マイナス取引（寄り値 vs 前日終値）━━━");
  // ギャップが計算できる取引のみ（初日は前日終値なし）
  const gapTrades = allLossTrades.filter(t => t.gapPct !== 0);
  const gapBuckets = [
    { label: "大ギャップダウン（-3%以下）", min: -999, max: -3 },
    { label: "中ギャップダウン（-3%〜-1%）", min: -3, max: -1 },
    { label: "小ギャップダウン（-1%〜-0.3%）", min: -1, max: -0.3 },
    { label: "フラット（±0.3%以内）", min: -0.3, max: 0.3 },
    { label: "小ギャップアップ（0.3%〜1%）", min: 0.3, max: 1 },
    { label: "中ギャップアップ（1%〜3%）", min: 1, max: 3 },
    { label: "大ギャップアップ（3%以上）", min: 3, max: 999 },
  ];
  for (const b of gapBuckets) {
    const trades = gapTrades.filter(t => t.gapPct > b.min && t.gapPct <= b.max);
    if (trades.length === 0) continue;
    const tl = trades.reduce((s, t) => s + t.profit, 0);
    const avgGap = (trades.reduce((s, t) => s + t.gapPct, 0) / trades.length).toFixed(2);
    console.log(`  ${b.label}: ${trades.length}件, 損失合計 ${tl.toLocaleString()}円, 平均ギャップ ${avgGap}%`);
  }

  // ─── 3. 日中ボラティリティ別 ────────────────────────────────────────────────
  console.log("\n━━━ 3. 日中ボラティリティ別マイナス取引（高値-安値 / 寄り値）━━━");
  const volBuckets = [
    { label: "超低ボラ（<2%）", min: 0, max: 2 },
    { label: "低ボラ（2%〜4%）", min: 2, max: 4 },
    { label: "中ボラ（4%〜6%）", min: 4, max: 6 },
    { label: "高ボラ（6%〜8%）", min: 6, max: 8 },
    { label: "超高ボラ（8%以上）", min: 8, max: 999 },
  ];
  for (const b of volBuckets) {
    const trades = allLossTrades.filter(t => t.intraDayVol > b.min && t.intraDayVol <= b.max);
    if (trades.length === 0) continue;
    const tl = trades.reduce((s, t) => s + t.profit, 0);
    const avgVol = (trades.reduce((s, t) => s + t.intraDayVol, 0) / trades.length).toFixed(1);
    console.log(`  ${b.label}: ${trades.length}件, 損失合計 ${tl.toLocaleString()}円, 平均ボラ ${avgVol}%`);
  }

  // ─── 4. エントリー時点の出来高急増率別 ─────────────────────────────────────
  console.log("\n━━━ 4. エントリー時点の出来高急増率別マイナス取引 ━━━");
  console.log("   （エントリー足の出来高 / 直近10本平均）");
  const volRatioBuckets = [
    { label: "出来高急減（<0.5倍）", min: 0, max: 0.5 },
    { label: "出来高平均以下（0.5〜1.0倍）", min: 0.5, max: 1.0 },
    { label: "出来高やや多め（1.0〜2.0倍）", min: 1.0, max: 2.0 },
    { label: "出来高急増（2.0〜5.0倍）", min: 2.0, max: 5.0 },
    { label: "出来高爆増（5.0倍以上）", min: 5.0, max: 999 },
  ];
  for (const b of volRatioBuckets) {
    const trades = allLossTrades.filter(t => t.entryVolRatio > b.min && t.entryVolRatio <= b.max);
    if (trades.length === 0) continue;
    const tl = trades.reduce((s, t) => s + t.profit, 0);
    const avgRatio = (trades.reduce((s, t) => s + t.entryVolRatio, 0) / trades.length).toFixed(2);
    console.log(`  ${b.label}: ${trades.length}件, 損失合計 ${tl.toLocaleString()}円, 平均倍率 ${avgRatio}倍`);
  }

  // ─── 5. 銘柄×セクター×損益詳細 ─────────────────────────────────────────────
  console.log("\n━━━ 5. 銘柄×セクター×損益詳細テーブル ━━━");
  const bySymbol = new Map<string, { lossCount: number; totalLoss: number; totalTrades: number; totalProfit: number; name: string; sector: string; isHighVol: boolean }>();
  for (const t of allTrades) {
    const s = TARGET_STOCKS.find(s => s.symbol === t.symbol);
    if (!s) continue;
    const e = bySymbol.get(t.symbol) ?? { lossCount: 0, totalLoss: 0, totalTrades: 0, totalProfit: 0, name: s.name, sector: t.sector, isHighVol: t.isHighVol };
    e.totalTrades++;
    e.totalProfit += t.profit;
    if (t.profit < 0) { e.lossCount++; e.totalLoss += t.profit; }
    bySymbol.set(t.symbol, e);
  }
  console.log(`  ${"銘柄".padEnd(6)} ${"名前".padEnd(18)} ${"セクター".padEnd(10)} ${"ロット".padEnd(6)} | ${"負け".padStart(4)} | ${"損失合計".padStart(12)} | ${"全取引".padStart(6)} | ${"勝率".padStart(6)} | ${"損益合計".padStart(12)}`);
  console.log(`  ${"─".repeat(100)}`);
  for (const [sym, v] of Array.from(bySymbol.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    const winRate = v.totalTrades > 0 ? ((v.totalTrades - v.lossCount) / v.totalTrades * 100).toFixed(0) : "0";
    const lotLabel = v.isHighVol ? "極小" : "通常";
    console.log(`  ${sym.padEnd(6)} ${v.name.padEnd(18)} ${v.sector.padEnd(10)} ${lotLabel.padEnd(6)} | ${String(v.lossCount).padStart(4)} | ${v.totalLoss.toLocaleString().padStart(12)}円 | ${String(v.totalTrades).padStart(6)} | ${winRate.padStart(5)}% | ${v.totalProfit.toLocaleString().padStart(12)}円`);
  }

  // ─── 6. 銘柄×損切り種別 クロス集計 ─────────────────────────────────────────
  console.log("\n━━━ 6. 銘柄×損切り種別 クロス集計（損失合計） ━━━");
  const crossMap = new Map<string, Map<string, number>>();
  const allReasons = new Set<string>();
  for (const t of allLossTrades) {
    allReasons.add(t.stopReason);
    const inner = crossMap.get(t.symbol) ?? new Map<string, number>();
    inner.set(t.stopReason, (inner.get(t.stopReason) ?? 0) + t.profit);
    crossMap.set(t.symbol, inner);
  }
  const reasonList = Array.from(allReasons).sort();
  // ヘッダー
  const reasonShort = reasonList.map(r => r.slice(0, 10));
  console.log(`  ${"銘柄".padEnd(6)} | ${reasonShort.map(r => r.padEnd(12)).join(" | ")}`);
  console.log(`  ${"─".repeat(6 + reasonList.length * 15)}`);
  for (const [sym, inner] of Array.from(crossMap.entries()).sort((a, b) => {
    const ta = Array.from(a[1].values()).reduce((s, v) => s + v, 0);
    const tb = Array.from(b[1].values()).reduce((s, v) => s + v, 0);
    return ta - tb;
  })) {
    const cols = reasonList.map(r => {
      const v = inner.get(r) ?? 0;
      return v === 0 ? "─".padStart(12) : v.toLocaleString().padStart(12);
    });
    console.log(`  ${sym.padEnd(6)} | ${cols.join(" | ")}`);
  }

  // ─── 7. 高ボラ日（日中ボラ>6%）のマイナス取引分析 ──────────────────────────
  console.log("\n━━━ 7. 高ボラ日（日中ボラ>6%）のマイナス取引 ━━━");
  const highVolDayLoss = allLossTrades.filter(t => t.intraDayVol > 6);
  const normalVolDayLoss = allLossTrades.filter(t => t.intraDayVol <= 6);
  const hvTotal = highVolDayLoss.reduce((s, t) => s + t.profit, 0);
  const nvTotal = normalVolDayLoss.reduce((s, t) => s + t.profit, 0);
  console.log(`  高ボラ日（>6%）: ${highVolDayLoss.length}件, 損失合計 ${hvTotal.toLocaleString()}円, 平均 ${highVolDayLoss.length > 0 ? Math.round(hvTotal / highVolDayLoss.length).toLocaleString() : 0}円`);
  console.log(`  通常ボラ日（≤6%）: ${normalVolDayLoss.length}件, 損失合計 ${nvTotal.toLocaleString()}円, 平均 ${normalVolDayLoss.length > 0 ? Math.round(nvTotal / normalVolDayLoss.length).toLocaleString() : 0}円`);
  if (highVolDayLoss.length > 0) {
    console.log(`  高ボラ日の銘柄別:`);
    const hvBySym = new Map<string, number>();
    for (const t of highVolDayLoss) hvBySym.set(t.symbol, (hvBySym.get(t.symbol) ?? 0) + t.profit);
    for (const [sym, loss] of Array.from(hvBySym.entries()).sort((a, b) => a[1] - b[1])) {
      const name = TARGET_STOCKS.find(s => s.symbol === sym)?.name ?? sym;
      console.log(`    ${sym} ${name}: ${loss.toLocaleString()}円`);
    }
  }

  // ─── 8. ギャップアップ大（>3%）の日のマイナス取引分析 ──────────────────────
  console.log("\n━━━ 8. 大ギャップアップ日（>3%）のマイナス取引 ━━━");
  const bigGapUpLoss = allLossTrades.filter(t => t.gapPct > 3);
  const bigGapDownLoss = allLossTrades.filter(t => t.gapPct < -3);
  const bgTotal = bigGapUpLoss.reduce((s, t) => s + t.profit, 0);
  const bdTotal = bigGapDownLoss.reduce((s, t) => s + t.profit, 0);
  console.log(`  大ギャップアップ（>3%）: ${bigGapUpLoss.length}件, 損失合計 ${bgTotal.toLocaleString()}円`);
  console.log(`  大ギャップダウン（<-3%）: ${bigGapDownLoss.length}件, 損失合計 ${bdTotal.toLocaleString()}円`);
  if (bigGapUpLoss.length > 0) {
    console.log(`  大ギャップアップ日の詳細:`);
    for (const t of bigGapUpLoss.sort((a, b) => a.profit - b.profit).slice(0, 10)) {
      console.log(`    ${t.date} ${t.symbol}(${t.name}) ${t.direction} gap:+${t.gapPct.toFixed(1)}% vol:${t.intraDayVol.toFixed(1)}% ${t.stopReason} ${t.profit.toLocaleString()}円`);
    }
  }

  // ─── 9. 出来高爆増エントリー（>5倍）の分析 ─────────────────────────────────
  console.log("\n━━━ 9. 出来高爆増エントリー（>5倍）の詳細 ━━━");
  const highVolEntryLoss = allLossTrades.filter(t => t.entryVolRatio > 5);
  if (highVolEntryLoss.length > 0) {
    const hveTot = highVolEntryLoss.reduce((s, t) => s + t.profit, 0);
    console.log(`  ${highVolEntryLoss.length}件, 損失合計 ${hveTot.toLocaleString()}円`);
    for (const t of highVolEntryLoss.sort((a, b) => a.profit - b.profit)) {
      console.log(`    ${t.date} ${t.symbol}(${t.name}) ${t.direction} volRatio:${t.entryVolRatio.toFixed(1)}x gap:${t.gapPct.toFixed(1)}% ${t.stopReason} ${t.profit.toLocaleString()}円`);
    }
  } else {
    console.log(`  該当なし`);
  }

  // ─── 10. 極小ロット銘柄 vs 通常ロット銘柄 ───────────────────────────────────
  console.log("\n━━━ 10. 極小ロット銘柄 vs 通常ロット銘柄 ━━━");
  const highVolLoss = allLossTrades.filter(t => t.isHighVolSymbol);
  const normalLoss = allLossTrades.filter(t => !t.isHighVolSymbol);
  const hvLossTotal = highVolLoss.reduce((s, t) => s + t.profit, 0);
  const nvLossTotal = normalLoss.reduce((s, t) => s + t.profit, 0);
  const hvTrades = allTrades.filter(t => t.isHighVol);
  const nvTrades = allTrades.filter(t => !t.isHighVol);
  const hvWinRate = hvTrades.length > 0 ? ((hvTrades.filter(t => t.profit > 0).length / hvTrades.length) * 100).toFixed(1) : "0";
  const nvWinRate = nvTrades.length > 0 ? ((nvTrades.filter(t => t.profit > 0).length / nvTrades.length) * 100).toFixed(1) : "0";
  console.log(`  極小ロット銘柄: ${highVolLoss.length}件のマイナス, 損失合計 ${hvLossTotal.toLocaleString()}円, 勝率 ${hvWinRate}%`);
  console.log(`  通常ロット銘柄: ${normalLoss.length}件のマイナス, 損失合計 ${nvLossTotal.toLocaleString()}円, 勝率 ${nvWinRate}%`);

  // ─── 11. 損失ワースト10取引の詳細 ──────────────────────────────────────────
  console.log("\n━━━ 11. 損失ワースト10取引の詳細 ━━━");
  for (const t of allLossTrades.sort((a, b) => a.profit - b.profit).slice(0, 10)) {
    console.log(`  ${t.date} ${t.symbol}(${t.name}/${t.sector}) ${t.direction} ${t.entryTime}→${t.exitTime} gap:${t.gapPct.toFixed(1)}% vol:${t.intraDayVol.toFixed(1)}% volRatio:${t.entryVolRatio.toFixed(1)}x "${t.stopReason}" ${t.profit.toLocaleString()}円`);
  }

  // ─── 12. 銘柄別ギャップ特性 ─────────────────────────────────────────────────
  console.log("\n━━━ 12. 銘柄別ギャップ特性（マイナス取引のみ）━━━");
  const gapBySymbol = new Map<string, { gaps: number[]; vols: number[]; totalLoss: number; name: string }>();
  for (const t of allLossTrades) {
    const e = gapBySymbol.get(t.symbol) ?? { gaps: [], vols: [], totalLoss: 0, name: t.name };
    if (t.gapPct !== 0) e.gaps.push(t.gapPct);
    e.vols.push(t.intraDayVol);
    e.totalLoss += t.profit;
    gapBySymbol.set(t.symbol, e);
  }
  console.log(`  ${"銘柄".padEnd(6)} ${"名前".padEnd(18)} | ${"平均ギャップ".padStart(12)} | ${"平均ボラ".padStart(10)} | ${"損失合計".padStart(12)}`);
  console.log(`  ${"─".repeat(70)}`);
  for (const [sym, v] of Array.from(gapBySymbol.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    const avgGap = v.gaps.length > 0 ? (v.gaps.reduce((s, g) => s + g, 0) / v.gaps.length).toFixed(2) : "N/A";
    const avgVol = v.vols.length > 0 ? (v.vols.reduce((s, g) => s + g, 0) / v.vols.length).toFixed(1) : "N/A";
    console.log(`  ${sym.padEnd(6)} ${v.name.padEnd(18)} | ${(avgGap + "%").padStart(12)} | ${(avgVol + "%").padStart(10)} | ${v.totalLoss.toLocaleString().padStart(12)}円`);
  }

  // ─── 13. 対策候補のまとめ ────────────────────────────────────────────────────
  console.log("\n━━━ 13. 対策候補のまとめ ━━━");
  // ギャップアップ大（>3%）の日にショートエントリーしたケース
  const gapUpShortLoss = allLossTrades.filter(t => t.gapPct > 3 && t.direction === "short");
  const gapUpLongLoss = allLossTrades.filter(t => t.gapPct > 3 && t.direction === "long");
  console.log(`  大ギャップアップ日のショート損失: ${gapUpShortLoss.length}件, ${gapUpShortLoss.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);
  console.log(`  大ギャップアップ日のロング損失: ${gapUpLongLoss.length}件, ${gapUpLongLoss.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);

  // 高ボラ日（>6%）のショートエントリー
  const highVolShortLoss = allLossTrades.filter(t => t.intraDayVol > 6 && t.direction === "short");
  console.log(`  高ボラ日（>6%）のショート損失: ${highVolShortLoss.length}件, ${highVolShortLoss.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);

  // 高ボラ日（>6%）のロングエントリー
  const highVolLongLoss = allLossTrades.filter(t => t.intraDayVol > 6 && t.direction === "long");
  console.log(`  高ボラ日（>6%）のロング損失: ${highVolLongLoss.length}件, ${highVolLongLoss.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);

  // 出来高急増（>3倍）エントリーの損失
  const highVolEntryAll = allLossTrades.filter(t => t.entryVolRatio > 3);
  console.log(`  出来高急増（>3倍）エントリーの損失: ${highVolEntryAll.length}件, ${highVolEntryAll.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);

  // 銘柄別損益ランキング（通常ロットのみ）
  console.log("\n  【通常ロット銘柄の損益ランキング】");
  const normalSymbols = Array.from(bySymbol.entries()).filter(([, v]) => !v.isHighVol).sort((a, b) => a[1].totalProfit - b[1].totalProfit);
  for (const [sym, v] of normalSymbols) {
    const tag = v.totalProfit < 0 ? " ← 損失超過（要検討）" : "";
    console.log(`    ${sym} ${v.name}(${v.sector}): 損益 ${v.totalProfit.toLocaleString()}円, 勝率 ${((v.totalTrades - v.lossCount) / v.totalTrades * 100).toFixed(0)}%${tag}`);
  }
}

main();
