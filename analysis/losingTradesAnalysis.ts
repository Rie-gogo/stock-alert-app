/**
 * analysis/losingTradesAnalysis.ts
 *
 * J-Quants 60営業日バックテストの全マイナス取引を洗い出し、
 * 原因・共通点を多軸で集計する。
 *
 * 集計軸:
 *   1. 銘柄別
 *   2. 時間帯別（エントリー時刻の時）
 *   3. 決済理由別（signals.reason の先頭部分）
 *   4. 保有時間別（バー数）
 *   5. レジーム別（up/down/neutral）
 *   6. 損失幅別（損失率）
 *   7. ロング/ショート別
 *   8. 決済理由×方向 クロス集計
 *   9. 時間帯×方向 クロス集計
 *  10. 銘柄×決済理由 クロス集計
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

const FLOW_LB = 10;
const SLOPE_LB = 25;

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
    if (i >= FLOW_LB - 1) { let s = 0; for (let k = i - FLOW_LB + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LB && c.ma25 !== null) { const prev = candles[i - SLOPE_LB].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

// ─── データ読み込み ────────────────────────────────────────────────────────────

const DATA_DIR = path.join(process.cwd(), "analysis", "jq_data");
const OUT_DIR = path.join(process.cwd(), "analysis", "jq_out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── マイナス取引型 ────────────────────────────────────────────────────────────

interface LossTrade {
  date: string;
  symbol: string;
  name: string;
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
}

// ─── メイン ────────────────────────────────────────────────────────────────────

function main() {
  console.log("J-Quants データ読み込み中...");
  const byTicker = new Map<string, Map<string, JqBar[]>>();
  for (const s of TARGET_STOCKS) {
    const fp = path.join(DATA_DIR, `${s.symbol}.json`);
    if (!fs.existsSync(fp)) { console.warn(`[missing] ${s.symbol}.json`); continue; }
    const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const byDay = new Map<string, JqBar[]>();
    for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
    byTicker.set(s.symbol, byDay);
  }

  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`  ${byTicker.size} 銘柄, ${allDays.length} 営業日 (${allDays[0]} .. ${allDays[allDays.length - 1]})`);

  const allLossTrades: LossTrade[] = [];
  const allTrades: { profit: number }[] = [];
  let totalProfit = 0;

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
      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;

      totalProfit += res.profitAmount;

      // buy/sell, short/cover をペアリングして完結した取引を作る
      let openEntry: { time: string; price: number; shares: number; type: "buy" | "short" } | null = null;

      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          openEntry = { time: t.time, price: t.price, shares: t.shares, type: t.type };
        } else if ((t.type === "sell" || t.type === "cover") && openEntry) {
          const profit = t.profit ?? 0;
          allTrades.push({ profit });

          if (profit < 0) {
            // 決済理由を signals から取得
            const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
            const rawReason = sig?.reason ?? "";
            // 括弧の前の部分だけ取る（例: "損切り (2.0%下落)" → "損切り"）
            const stopReason = rawReason.split("(")[0].trim() || "不明";

            // 保有バー数
            const entryIdx = candles.findIndex(c => c.time === openEntry!.time);
            const exitIdx = candles.findIndex(c => c.time === t.time);
            const holdBars = exitIdx >= entryIdx && entryIdx >= 0 ? exitIdx - entryIdx : 0;

            // 損失率（ロング: (exit-entry)/entry, ショート: (entry-exit)/entry）
            const direction = openEntry.type === "short" ? "short" : "long";
            const rawPct = openEntry.price > 0 ? ((t.price - openEntry.price) / openEntry.price) * 100 : 0;
            const profitPct = direction === "short" ? -rawPct : rawPct;

            allLossTrades.push({
              date: day,
              symbol: s.symbol,
              name: s.name,
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

  console.log(`\n━━━ 全体サマリー ━━━`);
  console.log(`全取引: ${allTrades.length}件 (勝${winCount} / 負${lossCount})`);
  console.log(`勝率: ${((winCount / allTrades.length) * 100).toFixed(1)}%`);
  console.log(`総損益: ${totalProfit.toLocaleString()}円`);
  console.log(`利益合計: +${totalGain.toLocaleString()}円`);
  console.log(`損失合計: ${totalLoss.toLocaleString()}円`);
  console.log(`損益比(PF): ${Math.abs(totalGain / totalLoss).toFixed(2)}`);
  console.log(`マイナス取引の平均損失: ${Math.round(totalLoss / lossCount).toLocaleString()}円`);

  // ─── 集計1: 銘柄別 ──────────────────────────────────────────────────────────
  console.log("\n━━━ 銘柄別マイナス取引 ━━━");
  const bySymbol = new Map<string, { count: number; totalLoss: number; name: string }>();
  for (const t of allLossTrades) {
    const e = bySymbol.get(t.symbol) ?? { count: 0, totalLoss: 0, name: t.name };
    e.count++; e.totalLoss += t.profit;
    bySymbol.set(t.symbol, e);
  }
  for (const [sym, v] of Array.from(bySymbol.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    console.log(`  ${sym} ${v.name}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計2: 時間帯別 ─────────────────────────────────────────────────────────
  console.log("\n━━━ 時間帯別マイナス取引（エントリー時刻の時） ━━━");
  const byHour = new Map<number, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const h = parseInt(t.entryTime.split(":")[0], 10);
    const e = byHour.get(h) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    byHour.set(h, e);
  }
  for (const [h, v] of Array.from(byHour.entries()).sort((a, b) => a[0] - b[0])) {
    console.log(`  ${h}時台: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計3: 決済理由別 ───────────────────────────────────────────────────────
  console.log("\n━━━ 決済理由別マイナス取引 ━━━");
  const byReason = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const e = byReason.get(t.stopReason) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    byReason.set(t.stopReason, e);
  }
  for (const [r, v] of Array.from(byReason.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    console.log(`  "${r}": ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計4: 保有時間別 ───────────────────────────────────────────────────────
  console.log("\n━━━ 保有時間別マイナス取引（バー数） ━━━");
  const holdBuckets = [
    { label: "1〜5本（超短期）", min: 1, max: 5 },
    { label: "6〜15本（短期）", min: 6, max: 15 },
    { label: "16〜30本（中期）", min: 16, max: 30 },
    { label: "31〜60本（長期）", min: 31, max: 60 },
    { label: "61本以上（超長期）", min: 61, max: 9999 },
  ];
  for (const bucket of holdBuckets) {
    const trades = allLossTrades.filter(t => t.holdBars >= bucket.min && t.holdBars <= bucket.max);
    if (trades.length === 0) continue;
    const totalL = trades.reduce((s, t) => s + t.profit, 0);
    console.log(`  ${bucket.label}: ${trades.length}件, 損失合計 ${totalL.toLocaleString()}円, 平均 ${Math.round(totalL / trades.length).toLocaleString()}円`);
  }

  // ─── 集計5: レジーム別 ───────────────────────────────────────────────────────
  console.log("\n━━━ レジーム別マイナス取引 ━━━");
  const byRegime = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const e = byRegime.get(t.regime) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    byRegime.set(t.regime, e);
  }
  for (const [r, v] of Array.from(byRegime.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    console.log(`  ${r}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計6: 損失幅別 ─────────────────────────────────────────────────────────
  console.log("\n━━━ 損失幅別マイナス取引（損失率） ━━━");
  const lossBuckets = [
    { label: "0〜-0.3%（微損）", min: -0.3, max: 0 },
    { label: "-0.3〜-0.55%（小損）", min: -0.55, max: -0.3 },
    { label: "-0.55〜-1.0%（中損）", min: -1.0, max: -0.55 },
    { label: "-1.0〜-2.0%（大損）", min: -2.0, max: -1.0 },
    { label: "-2.0%超（最大損失）", min: -99, max: -2.0 },
  ];
  for (const bucket of lossBuckets) {
    const trades = allLossTrades.filter(t => t.profitPct <= bucket.max && t.profitPct > bucket.min);
    if (trades.length === 0) continue;
    const totalL = trades.reduce((s, t) => s + t.profit, 0);
    console.log(`  ${bucket.label}: ${trades.length}件, 損失合計 ${totalL.toLocaleString()}円, 平均 ${Math.round(totalL / trades.length).toLocaleString()}円`);
  }

  // ─── 集計7: ロング/ショート別 ────────────────────────────────────────────────
  console.log("\n━━━ ロング/ショート別マイナス取引 ━━━");
  const byDir = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const e = byDir.get(t.direction) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    byDir.set(t.direction, e);
  }
  for (const [d, v] of Array.from(byDir.entries())) {
    console.log(`  ${d}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計8: 決済理由×方向 クロス集計 ─────────────────────────────────────────
  console.log("\n━━━ 決済理由×方向 クロス集計（損失合計 上位15） ━━━");
  const crossMap = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const key = `${t.direction}×${t.stopReason}`;
    const e = crossMap.get(key) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    crossMap.set(key, e);
  }
  for (const [key, v] of Array.from(crossMap.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss).slice(0, 15)) {
    console.log(`  ${key}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計9: 時間帯×方向 クロス集計 ─────────────────────────────────────────
  console.log("\n━━━ 時間帯×方向 クロス集計 ━━━");
  const hourDirMap = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const h = parseInt(t.entryTime.split(":")[0], 10);
    const key = `${h}時×${t.direction}`;
    const e = hourDirMap.get(key) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    hourDirMap.set(key, e);
  }
  for (const [key, v] of Array.from(hourDirMap.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss)) {
    console.log(`  ${key}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 集計10: 銘柄×決済理由 クロス集計（損失上位） ──────────────────────────
  console.log("\n━━━ 銘柄×決済理由 クロス集計（損失上位15） ━━━");
  const symReasonMap = new Map<string, { count: number; totalLoss: number }>();
  for (const t of allLossTrades) {
    const key = `${t.symbol}(${t.name})×${t.stopReason}`;
    const e = symReasonMap.get(key) ?? { count: 0, totalLoss: 0 };
    e.count++; e.totalLoss += t.profit;
    symReasonMap.set(key, e);
  }
  for (const [key, v] of Array.from(symReasonMap.entries()).sort((a, b) => a[1].totalLoss - b[1].totalLoss).slice(0, 15)) {
    console.log(`  ${key}: ${v.count}件, 損失合計 ${v.totalLoss.toLocaleString()}円, 平均 ${Math.round(v.totalLoss / v.count).toLocaleString()}円`);
  }

  // ─── 最大損失取引TOP20 ───────────────────────────────────────────────────────
  console.log("\n━━━ 最大損失取引 TOP20 ━━━");
  const top20 = [...allLossTrades].sort((a, b) => a.profit - b.profit).slice(0, 20);
  for (const t of top20) {
    console.log(
      `  ${t.date} ${t.symbol}(${t.name}) ${t.direction} ${t.entryTime}→${t.exitTime} ` +
      `${t.entryPrice.toFixed(0)}→${t.exitPrice.toFixed(0)} ${t.profit.toLocaleString()}円 (${t.profitPct.toFixed(2)}%) ` +
      `${t.holdBars}本 [${t.stopReason}] ${t.regime}`
    );
  }

  // ─── CSV出力 ─────────────────────────────────────────────────────────────────
  const csvLines = [
    "date,symbol,name,direction,entryTime,exitTime,entryPrice,exitPrice,profit,profitPct,holdBars,stopReason,regime",
    ...allLossTrades.map(t =>
      [t.date, t.symbol, t.name, t.direction, t.entryTime, t.exitTime,
       t.entryPrice.toFixed(0), t.exitPrice.toFixed(0), t.profit.toFixed(0),
       t.profitPct.toFixed(3), t.holdBars, `"${t.stopReason}"`, t.regime].join(",")
    ),
  ];
  const csvPath = path.join(OUT_DIR, "losing_trades.csv");
  fs.writeFileSync(csvPath, csvLines.join("\n"), "utf-8");
  console.log(`\nCSV出力: ${csvPath} (${allLossTrades.length}行)`);
}

main();
