/**
 * analysis/symbolCountermeasureSweep.ts
 *
 * 銘柄特性分析から導出した対策候補をスイープ検証する。
 *
 * 対策候補:
 *   A) 太陽誘電（6976）を監視対象から除外（損失超過銘柄）
 *   B) 高ボラ日（日中ボラ>6%）のショートエントリーを禁止
 *      ※ 高ボラ日はシミュレーション呼び出しをスキップするのではなく、
 *         その日の取引結果から「ショート取引の損益」を除外して集計する
 *         → 実際には「ショートを行わなかった場合」の近似値
 *   C) 高ボラ日（>6%）のロング禁止
 *   D) 高ボラ日（>6%）の全エントリー禁止
 *   E) 中ギャップアップ（1〜3%）のショート禁止
 *   F) 大ギャップアップ（>3%）のショート禁止
 *   G) 中+大ギャップアップ（>1%）のショート禁止
 *   H) 太陽誘電のショートのみ禁止
 *   I) 高ボラ日閾値5%でショート禁止
 *   J) 高ボラ日閾値7%でショート禁止
 *   K) 高ボラ日閾値8%でショート禁止
 *   L) A+B（太陽誘電除外 + 高ボラ日ショート禁止）
 *   M) A+D（太陽誘電除外 + 高ボラ日全エントリー禁止）
 *
 * 実装方式:
 *   全取引を事前に収集し、各対策の「除外条件」に合致する取引を除外して
 *   総損益を再計算する。これにより「その取引をしなかった場合」の近似値を得る。
 *   ただし、除外した取引が他の取引に影響を与える（ポジション管理等）可能性は
 *   考慮しない（近似値として扱う）。
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
  for (const byTicker2 of byTicker.values()) for (const d of byTicker2.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  return { byTicker, allDays };
}

// ─── 全取引の収集 ─────────────────────────────────────────────────────────────

interface TradeRecord {
  date: string;
  symbol: string;
  direction: "long" | "short";
  profit: number;
  intraDayVol: number;  // 当日の日中ボラ（%）
  gapPct: number;       // 当日のギャップ（%）
}

function collectAllTrades(byTicker: Map<string, Map<string, JqBar[]>>, allDays: string[]): TradeRecord[] {
  const allTrades: TradeRecord[] = [];
  const prevClose = new Map<string, number>();

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

      const open = candles[0]?.open ?? 0;
      const high = Math.max(...candles.map(c => c.high));
      const low = Math.min(...candles.map(c => c.low));
      const close = candles[candles.length - 1]?.close ?? 0;
      const intraDayVol = open > 0 ? ((high - low) / open) * 100 : 0;
      const prevC = prevClose.get(s.symbol);
      const gapPct = prevC && prevC > 0 ? ((open - prevC) / prevC) * 100 : 0;
      prevClose.set(s.symbol, close);

      const res = simulateStockReal(
        s.symbol, s.ticker, s.name, candles, marketBiasAt,
        3_000_000, 70, 30, 2.0, rangeBound, 1.0,
        { shortStopLossPercent: SHORT_STOP_LOSS_PERCENT, lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE }
      );
      if (!res) continue;

      let openEntry: { type: "buy" | "short" } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") {
          openEntry = { type: t.type };
        } else if ((t.type === "sell" || t.type === "cover") && openEntry) {
          const profit = t.profit ?? 0;
          allTrades.push({
            date: day,
            symbol: s.symbol,
            direction: openEntry.type === "short" ? "short" : "long",
            profit,
            intraDayVol,
            gapPct,
          });
          openEntry = null;
        }
      }
    }
  }

  return allTrades;
}

// ─── メイン ────────────────────────────────────────────────────────────────────

function main() {
  console.log("データ読み込み中...");
  const { byTicker, allDays } = loadData();
  console.log(`  ${allDays.length} 営業日\n`);

  console.log("全取引を収集中...");
  const allTrades = collectAllTrades(byTicker, allDays);
  const baseline = allTrades.reduce((s, t) => s + t.profit, 0);
  console.log(`  全取引: ${allTrades.length}件, 総損益: ${baseline.toLocaleString()}円\n`);

  // ─── 各対策の効果を計算 ─────────────────────────────────────────────────────
  // 「対策Xを適用した場合」= 全取引から「対策Xが禁止する取引」を除外した損益合計
  // ただし、除外した取引の「利益」も失うため、差分がプラスなら対策有効

  const scenarios: { label: string; filter: (t: TradeRecord) => boolean }[] = [
    {
      label: "A: 太陽誘電（6976）を除外",
      filter: (t) => t.symbol !== "6976",
    },
    {
      label: "B: 高ボラ日（>6%）のショート取引を除外",
      filter: (t) => !(t.intraDayVol > 6 && t.direction === "short"),
    },
    {
      label: "C: 高ボラ日（>6%）のロング取引を除外",
      filter: (t) => !(t.intraDayVol > 6 && t.direction === "long"),
    },
    {
      label: "D: 高ボラ日（>6%）の全取引を除外",
      filter: (t) => t.intraDayVol <= 6,
    },
    {
      label: "E: 中ギャップアップ（1〜3%）のショート取引を除外",
      filter: (t) => !(t.gapPct >= 1 && t.gapPct < 3 && t.direction === "short"),
    },
    {
      label: "F: 大ギャップアップ（>3%）のショート取引を除外",
      filter: (t) => !(t.gapPct > 3 && t.direction === "short"),
    },
    {
      label: "G: ギャップアップ（>1%）のショート取引を除外",
      filter: (t) => !(t.gapPct > 1 && t.direction === "short"),
    },
    {
      label: "H: 太陽誘電のショート取引を除外",
      filter: (t) => !(t.symbol === "6976" && t.direction === "short"),
    },
    {
      label: "I: 高ボラ日（>5%）のショート取引を除外",
      filter: (t) => !(t.intraDayVol > 5 && t.direction === "short"),
    },
    {
      label: "J: 高ボラ日（>7%）のショート取引を除外",
      filter: (t) => !(t.intraDayVol > 7 && t.direction === "short"),
    },
    {
      label: "K: 高ボラ日（>8%）のショート取引を除外",
      filter: (t) => !(t.intraDayVol > 8 && t.direction === "short"),
    },
    {
      label: "L: A+B（太陽誘電除外 + 高ボラ日ショート除外）",
      filter: (t) => t.symbol !== "6976" && !(t.intraDayVol > 6 && t.direction === "short"),
    },
    {
      label: "M: A+D（太陽誘電除外 + 高ボラ日全取引除外）",
      filter: (t) => t.symbol !== "6976" && t.intraDayVol <= 6,
    },
    {
      label: "N: B+E（高ボラ日ショート除外 + 中ギャップアップショート除外）",
      filter: (t) => !(t.intraDayVol > 6 && t.direction === "short") && !(t.gapPct >= 1 && t.gapPct < 3 && t.direction === "short"),
    },
    {
      label: "O: A+G（太陽誘電除外 + ギャップアップ>1%ショート除外）",
      filter: (t) => t.symbol !== "6976" && !(t.gapPct > 1 && t.direction === "short"),
    },
    {
      label: "P: H+B（太陽誘電ショート除外 + 高ボラ日ショート除外）",
      filter: (t) => !(t.symbol === "6976" && t.direction === "short") && !(t.intraDayVol > 6 && t.direction === "short"),
    },
  ];

  console.log("対策候補スイープ結果:");
  console.log(`  ${"シナリオ".padEnd(56)} | ${"総損益".padStart(12)} | ${"差分".padStart(10)} | ${"除外件数".padStart(8)}`);
  console.log(`  ${"─".repeat(95)}`);

  for (const { label, filter } of scenarios) {
    const filtered = allTrades.filter(filter);
    const profit = filtered.reduce((s, t) => s + t.profit, 0);
    const diff = profit - baseline;
    const excluded = allTrades.length - filtered.length;
    const sign = diff >= 0 ? "+" : "";
    console.log(`  ${label.padEnd(56)} | ${profit.toLocaleString().padStart(12)}円 | ${(sign + diff.toLocaleString()).padStart(10)}円 | ${String(excluded).padStart(8)}件`);
  }

  console.log(`\n  ※ ベースライン: ${baseline.toLocaleString()}円 (${allTrades.length}件)`);

  // ─── 追加分析: 除外した取引の内訳 ──────────────────────────────────────────
  console.log("\n━━━ 各対策で除外される取引の内訳 ━━━");

  // B: 高ボラ日（>6%）のショート取引
  const bExcluded = allTrades.filter(t => t.intraDayVol > 6 && t.direction === "short");
  const bProfit = bExcluded.reduce((s, t) => s + t.profit, 0);
  const bWin = bExcluded.filter(t => t.profit > 0).length;
  console.log(`  B（高ボラ日ショート）: ${bExcluded.length}件, 損益合計 ${bProfit.toLocaleString()}円, 勝率 ${bExcluded.length > 0 ? ((bWin / bExcluded.length) * 100).toFixed(0) : 0}%`);

  // A: 太陽誘電
  const aExcluded = allTrades.filter(t => t.symbol === "6976");
  const aProfit = aExcluded.reduce((s, t) => s + t.profit, 0);
  const aWin = aExcluded.filter(t => t.profit > 0).length;
  console.log(`  A（太陽誘電全取引）: ${aExcluded.length}件, 損益合計 ${aProfit.toLocaleString()}円, 勝率 ${aExcluded.length > 0 ? ((aWin / aExcluded.length) * 100).toFixed(0) : 0}%`);

  // G: ギャップアップ>1%のショート
  const gExcluded = allTrades.filter(t => t.gapPct > 1 && t.direction === "short");
  const gProfit = gExcluded.reduce((s, t) => s + t.profit, 0);
  const gWin = gExcluded.filter(t => t.profit > 0).length;
  console.log(`  G（ギャップアップ>1%ショート）: ${gExcluded.length}件, 損益合計 ${gProfit.toLocaleString()}円, 勝率 ${gExcluded.length > 0 ? ((gWin / gExcluded.length) * 100).toFixed(0) : 0}%`);

  // H: 太陽誘電ショートのみ
  const hExcluded = allTrades.filter(t => t.symbol === "6976" && t.direction === "short");
  const hProfit = hExcluded.reduce((s, t) => s + t.profit, 0);
  const hWin = hExcluded.filter(t => t.profit > 0).length;
  console.log(`  H（太陽誘電ショートのみ）: ${hExcluded.length}件, 損益合計 ${hProfit.toLocaleString()}円, 勝率 ${hExcluded.length > 0 ? ((hWin / hExcluded.length) * 100).toFixed(0) : 0}%`);
}

main();
