/**
 * analysis/closeExitAnalysis.ts
 *
 * 引け値強制決済の全件（損失・利益含む）を詳細分析する。
 * by_reason.csv では: 引け値強制決済 33件, 損益合計-106,150円, 勝率36.4%
 *
 * 分析目的:
 *   - 引け値強制決済でマイナスになった取引の詳細を把握
 *   - エントリー時刻・保有時間・最大浮き益を確認
 *   - 対策（最大保有時間短縮・プロフィットロック）の効果を推定
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

interface CloseTrade {
  date: string;
  symbol: string;
  name: string;
  direction: "long" | "short";
  entryTime: string;
  exitTime: string;
  holdMinutes: number;
  entryPrice: number;
  exitPrice: number;
  profit: number;
  maxFavorable: number;
  maxFavorableTime: string;
}

function main() {
  console.log("データ読み込み中...");
  const { byTicker, allDays } = loadData();
  console.log(`  ${allDays.length} 営業日\n`);

  const closeTrades: CloseTrade[] = [];
  let totalCloseProfit = 0;
  let closeWin = 0, closeLoss = 0;

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
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;

      let openEntry: { time: string; price: number; shares: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          openEntry = { time: t.time, price: t.price, shares: t.shares, type: t.type };
        } else if ((t.type === "sell" || t.type === "cover") && openEntry) {
          const profit = t.profit ?? 0;
          const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
          const reasonKey = (sig?.reason ?? "").split("(")[0].trim() || "不明";

          if (reasonKey === "引け値強制決済") {
            totalCloseProfit += profit;
            if (profit > 0) closeWin++; else closeLoss++;

            const direction: "long" | "short" = openEntry.type === "buy" ? "long" : "short";
            const entryPrice = openEntry.price;
            const exitPrice = t.price;
            const entryIdx = candles.findIndex(c => c.time >= openEntry!.time);
            const exitIdx = candles.findIndex(c => c.time >= t.time);
            let maxFavorable = 0;
            let maxFavorableTime = openEntry.time;

            if (entryIdx >= 0 && exitIdx >= 0) {
              for (let i = entryIdx; i <= exitIdx; i++) {
                const c = candles[i];
                if (direction === "long") {
                  const fav = (c.high - entryPrice) / entryPrice * 100;
                  if (fav > maxFavorable) { maxFavorable = fav; maxFavorableTime = c.time; }
                } else {
                  const fav = (entryPrice - c.low) / entryPrice * 100;
                  if (fav > maxFavorable) { maxFavorable = fav; maxFavorableTime = c.time; }
                }
              }
            }

            const toMin = (time: string) => { const [h, m] = time.split(":").map(Number); return h * 60 + m; };
            const holdMinutes = toMin(t.time) - toMin(openEntry.time);

            closeTrades.push({
              date: day,
              symbol: s.symbol,
              name: s.name,
              direction,
              entryTime: openEntry.time,
              exitTime: t.time,
              holdMinutes,
              entryPrice,
              exitPrice,
              profit,
              maxFavorable,
              maxFavorableTime,
            });
          }
          openEntry = null;
        }
      }
    }
  }

  console.log(`━━━ 引け値強制決済 全件集計 ━━━`);
  console.log(`  総件数: ${closeTrades.length}件 (勝:${closeWin}/負:${closeLoss})`);
  console.log(`  損益合計: ${totalCloseProfit.toLocaleString()}円`);
  console.log(`  勝率: ${closeTrades.length > 0 ? (closeWin / closeTrades.length * 100).toFixed(1) : 0}%\n`);

  // エントリー時刻の分布
  console.log("━━━ エントリー時刻の分布 ━━━");
  const byHour = new Map<number, CloseTrade[]>();
  for (const t of closeTrades) {
    const h = parseInt(t.entryTime.split(":")[0]);
    const arr = byHour.get(h) ?? [];
    arr.push(t);
    byHour.set(h, arr);
  }
  for (const [h, arr] of Array.from(byHour.entries()).sort((a, b) => a[0] - b[0])) {
    const p = arr.reduce((s, t) => s + t.profit, 0);
    const w = arr.filter(t => t.profit > 0).length;
    console.log(`  ${h}時台: ${arr.length}件 (勝:${w}/負:${arr.length - w}), 損益 ${p.toLocaleString()}円`);
  }

  // 保有時間の分布
  console.log("\n━━━ 保有時間の分布 ━━━");
  const holdBuckets = [
    { label: "〜30分", min: 0, max: 30 },
    { label: "30〜60分", min: 30, max: 60 },
    { label: "60〜120分", min: 60, max: 120 },
    { label: "120〜180分", min: 120, max: 180 },
    { label: "180分〜", min: 180, max: 999 },
  ];
  for (const b of holdBuckets) {
    const arr = closeTrades.filter(t => t.holdMinutes >= b.min && t.holdMinutes < b.max);
    if (arr.length === 0) continue;
    const p = arr.reduce((s, t) => s + t.profit, 0);
    const w = arr.filter(t => t.profit > 0).length;
    const avgFav = arr.reduce((s, t) => s + t.maxFavorable, 0) / arr.length;
    console.log(`  ${b.label}: ${arr.length}件 (勝:${w}/負:${arr.length - w}), 損益 ${p.toLocaleString()}円, 平均最大浮き益 ${avgFav.toFixed(2)}%`);
  }

  // 最大浮き益の分布
  console.log("\n━━━ 最大浮き益の分布 ━━━");
  const favBuckets = [
    { label: "浮き益なし（<0.1%）", min: 0, max: 0.1 },
    { label: "微浮き益（0.1〜0.3%）", min: 0.1, max: 0.3 },
    { label: "小浮き益（0.3〜0.5%）", min: 0.3, max: 0.5 },
    { label: "中浮き益（0.5〜1.0%）", min: 0.5, max: 1.0 },
    { label: "大浮き益（1.0%以上）", min: 1.0, max: 999 },
  ];
  for (const b of favBuckets) {
    const arr = closeTrades.filter(t => t.maxFavorable >= b.min && t.maxFavorable < b.max);
    if (arr.length === 0) continue;
    const p = arr.reduce((s, t) => s + t.profit, 0);
    const w = arr.filter(t => t.profit > 0).length;
    console.log(`  ${b.label}: ${arr.length}件 (勝:${w}/負:${arr.length - w}), 損益 ${p.toLocaleString()}円`);
  }

  // 銘柄別
  console.log("\n━━━ 銘柄別の内訳 ━━━");
  const bySymbol = new Map<string, CloseTrade[]>();
  for (const t of closeTrades) {
    const arr = bySymbol.get(t.symbol) ?? [];
    arr.push(t);
    bySymbol.set(t.symbol, arr);
  }
  for (const [sym, arr] of Array.from(bySymbol.entries()).sort((a, b) => a[1].reduce((s, t) => s + t.profit, 0) - b[1].reduce((s, t) => s + t.profit, 0))) {
    const p = arr.reduce((s, t) => s + t.profit, 0);
    const w = arr.filter(t => t.profit > 0).length;
    console.log(`  ${sym} ${arr[0].name}: ${arr.length}件 (勝:${w}/負:${arr.length - w}), 損益 ${p.toLocaleString()}円`);
  }

  // 全件リスト
  console.log("\n━━━ 全件リスト ━━━");
  for (const t of closeTrades.sort((a, b) => a.profit - b.profit)) {
    const sign = t.profit >= 0 ? "+" : "";
    console.log(`  ${t.date} ${t.symbol}${t.name} ${t.direction} エントリー${t.entryTime} 保有${t.holdMinutes}分 最大浮き益${t.maxFavorable.toFixed(2)}% ${sign}${t.profit.toLocaleString()}円`);
  }

  // プロフィットロックで救える取引
  const hadFav = closeTrades.filter(t => t.profit < 0 && t.maxFavorable >= 0.3);
  console.log(`\n━━━ プロフィットロック（0.3%）で救える引け値強制決済のマイナス取引 ━━━`);
  console.log(`  ${hadFav.length}件, 損失合計: ${hadFav.reduce((s, t) => s + t.profit, 0).toLocaleString()}円`);
  for (const t of hadFav) {
    console.log(`    ${t.date} ${t.symbol}${t.name} ${t.direction} 最大浮き益${t.maxFavorable.toFixed(2)}%@${t.maxFavorableTime} → ${t.profit.toLocaleString()}円`);
  }
}

main();
