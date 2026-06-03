/**
 * analysis/shortStopDetailAnalysis.ts
 *
 * 空売り損切り17件のエントリー直前5〜10本のローソク足・出来高・テクニカル指標を
 * 全件抽出して共通パターンを探す。
 *
 * 分析軸:
 * 1. エントリー直前の値動き（上昇率・下落率・ヒゲ比率）
 * 2. 出来高の変化（エントリー直前の出来高 vs 直近平均）
 * 3. RSI・MA・BBの状態
 * 4. エントリー後の値動き（なぜ損切りになったか）
 * 5. 市場バイアス（その日の全体相場）
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/shortStopDetailAnalysis.ts
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

interface ShortStopCase {
  date: string;
  symbol: string;
  name: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  profit: number;
  lossPercent: number;
  // エントリー直前の状態
  rsiAtEntry: number | null;
  ma5AtEntry: number | null;
  ma25AtEntry: number | null;
  bbUpperAtEntry: number | null;
  bbLowerAtEntry: number | null;
  flowAtEntry: number | null;
  slopeAtEntry: number | null;
  // エントリー直前5本の値動き
  pre5ChangePercent: number;   // 5本前→エントリー時の変化率
  pre3ChangePercent: number;   // 3本前→エントリー時の変化率
  pre1ChangePercent: number;   // 1本前→エントリー時の変化率
  // 出来高
  volAtEntry: number;
  volAvg20: number;
  volRatioAtEntry: number;     // エントリー時出来高 / 直近20本平均
  // エントリー後の値動き
  post1ChangePercent: number;  // エントリー後1本の変化率
  post3ChangePercent: number;  // エントリー後3本の変化率
  post5ChangePercent: number;  // エントリー後5本の変化率
  maxAdversePercent: number;   // エントリー後の最大逆行幅（損切りまで）
  // 市場バイアス
  marketBiasAtEntry: number;
  // 当日の全体相場
  marketEff: number;
  isRangeBound: boolean;
}

function main() {
  console.log("データ読み込み中...");
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
  console.log(`  ${allDays.length} 営業日\n`);

  const cases: ShortStopCase[] = [];

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

      // 空売り損切りのペアを抽出
      let openEntry: { time: string; price: number; shares: number; candleIdx: number } | null = null;
      for (const t of res.trades) {
        if (t.type === "short") {
          const idx = candles.findIndex(c => c.time === t.time);
          openEntry = { time: t.time, price: t.price, shares: t.shares, candleIdx: idx };
        } else if (t.type === "cover" && openEntry) {
          const profit = t.profit ?? 0;
          const sig = (res.signals ?? []).find(sg => sg.time === t.time && sg.type === "cover");
          const reason = (sig?.reason ?? "").split("(")[0].trim();

          if (reason === "空売り損切り") {
            const entryIdx = openEntry.candleIdx;
            const exitIdx = candles.findIndex(c => c.time === t.time);
            const entryCandle = candles[entryIdx];

            if (!entryCandle) { openEntry = null; continue; }

            // エントリー直前の値動き
            const pre5 = entryIdx >= 5 ? candles[entryIdx - 5] : null;
            const pre3 = entryIdx >= 3 ? candles[entryIdx - 3] : null;
            const pre1 = entryIdx >= 1 ? candles[entryIdx - 1] : null;

            const pre5Change = pre5 ? (entryCandle.close - pre5.close) / pre5.close * 100 : 0;
            const pre3Change = pre3 ? (entryCandle.close - pre3.close) / pre3.close * 100 : 0;
            const pre1Change = pre1 ? (entryCandle.close - pre1.close) / pre1.close * 100 : 0;

            // 出来高
            const volSlice = candles.slice(Math.max(0, entryIdx - 20), entryIdx);
            const volAvg20 = volSlice.length > 0 ? volSlice.reduce((s, c) => s + c.volume, 0) / volSlice.length : 1;
            const volRatio = volAvg20 > 0 ? entryCandle.volume / volAvg20 : 1;

            // エントリー後の値動き
            const post1 = exitIdx >= entryIdx + 1 ? candles[entryIdx + 1] : null;
            const post3 = exitIdx >= entryIdx + 3 ? candles[entryIdx + 3] : null;
            const post5 = exitIdx >= entryIdx + 5 ? candles[entryIdx + 5] : null;
            const post1Change = post1 ? (post1.close - entryCandle.close) / entryCandle.close * 100 : 0;
            const post3Change = post3 ? (post3.close - entryCandle.close) / entryCandle.close * 100 : 0;
            const post5Change = post5 ? (post5.close - entryCandle.close) / entryCandle.close * 100 : 0;

            // 最大逆行幅（エントリーから損切りまでの高値）
            const betweenCandles = candles.slice(entryIdx, exitIdx + 1);
            const maxHigh = betweenCandles.length > 0 ? Math.max(...betweenCandles.map(c => c.high)) : entryCandle.close;
            const maxAdverse = (maxHigh - openEntry.price) / openEntry.price * 100;

            // 市場バイアス（エントリー時点）
            const progress = candles.length > 1 ? entryIdx / (candles.length - 1) : 0;
            const bias = marketBiasAt(progress);

            const lossPercent = openEntry.price > 0 ? (t.price - openEntry.price) / openEntry.price * 100 : 0;

            cases.push({
              date: day,
              symbol: s.symbol,
              name: s.name,
              entryTime: openEntry.time,
              entryPrice: openEntry.price,
              exitTime: t.time,
              exitPrice: t.price,
              profit,
              lossPercent,
              rsiAtEntry: entryCandle.rsi,
              ma5AtEntry: entryCandle.ma5,
              ma25AtEntry: entryCandle.ma25,
              bbUpperAtEntry: entryCandle.bbUpper,
              bbLowerAtEntry: entryCandle.bbLower,
              flowAtEntry: entryCandle.flow,
              slopeAtEntry: entryCandle.slope,
              pre5ChangePercent: pre5Change,
              pre3ChangePercent: pre3Change,
              pre1ChangePercent: pre1Change,
              volAtEntry: entryCandle.volume,
              volAvg20,
              volRatioAtEntry: volRatio,
              post1ChangePercent: post1Change,
              post3ChangePercent: post3Change,
              post5ChangePercent: post5Change,
              maxAdversePercent: maxAdverse,
              marketBiasAtEntry: bias,
              marketEff: eff,
              isRangeBound: rangeBound,
            });
          }
          openEntry = null;
        }
      }
    }
  }

  console.log(`\n空売り損切り件数: ${cases.length}件\n`);

  // ━━━ 1. 全件一覧 ━━━
  console.log("━━━ 1. 全件一覧 ━━━");
  console.log(`${"日付".padEnd(12)} ${"銘柄".padEnd(16)} ${"エントリー".padEnd(8)} ${"決済".padEnd(8)} ${"損失".padStart(8)} ${"損失%".padStart(7)} ${"RSI".padStart(6)} ${"5本前%".padStart(8)} ${"1本前%".padStart(8)} ${"出来高比".padStart(8)} ${"市場バイアス".padStart(10)}`);
  console.log("-".repeat(110));
  for (const c of cases.sort((a, b) => a.profit - b.profit)) {
    console.log(
      `${c.date.padEnd(12)} ${c.name.substring(0, 14).padEnd(16)} ${c.entryTime.padEnd(8)} ${c.exitTime.padEnd(8)}` +
      ` ${c.profit.toString().padStart(8)} ${c.lossPercent.toFixed(2).padStart(6)}%` +
      ` ${(c.rsiAtEntry ?? 0).toFixed(0).padStart(6)}` +
      ` ${c.pre5ChangePercent.toFixed(2).padStart(7)}%` +
      ` ${c.pre1ChangePercent.toFixed(2).padStart(7)}%` +
      ` ${c.volRatioAtEntry.toFixed(2).padStart(8)}x` +
      ` ${c.marketBiasAtEntry.toFixed(4).padStart(10)}`
    );
  }

  // ━━━ 2. 統計サマリー ━━━
  console.log("\n━━━ 2. 統計サマリー ━━━");
  const avg = (arr: number[]) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
  const median = (arr: number[]) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

  const rsiVals = cases.map(c => c.rsiAtEntry ?? 50);
  const pre5Vals = cases.map(c => c.pre5ChangePercent);
  const pre3Vals = cases.map(c => c.pre3ChangePercent);
  const pre1Vals = cases.map(c => c.pre1ChangePercent);
  const volRatioVals = cases.map(c => c.volRatioAtEntry);
  const biasVals = cases.map(c => c.marketBiasAtEntry);
  const post1Vals = cases.map(c => c.post1ChangePercent);
  const post3Vals = cases.map(c => c.post3ChangePercent);
  const maxAdverseVals = cases.map(c => c.maxAdversePercent);

  console.log(`RSI at entry:       平均 ${avg(rsiVals).toFixed(1)}, 中央値 ${median(rsiVals).toFixed(1)}, 最小 ${Math.min(...rsiVals).toFixed(1)}, 最大 ${Math.max(...rsiVals).toFixed(1)}`);
  console.log(`5本前からの変化率:  平均 ${avg(pre5Vals).toFixed(2)}%, 中央値 ${median(pre5Vals).toFixed(2)}%, 最小 ${Math.min(...pre5Vals).toFixed(2)}%, 最大 ${Math.max(...pre5Vals).toFixed(2)}%`);
  console.log(`3本前からの変化率:  平均 ${avg(pre3Vals).toFixed(2)}%, 中央値 ${median(pre3Vals).toFixed(2)}%, 最小 ${Math.min(...pre3Vals).toFixed(2)}%, 最大 ${Math.max(...pre3Vals).toFixed(2)}%`);
  console.log(`1本前からの変化率:  平均 ${avg(pre1Vals).toFixed(2)}%, 中央値 ${median(pre1Vals).toFixed(2)}%, 最小 ${Math.min(...pre1Vals).toFixed(2)}%, 最大 ${Math.max(...pre1Vals).toFixed(2)}%`);
  console.log(`出来高比（vs20本平均）: 平均 ${avg(volRatioVals).toFixed(2)}x, 中央値 ${median(volRatioVals).toFixed(2)}x, 最小 ${Math.min(...volRatioVals).toFixed(2)}x, 最大 ${Math.max(...volRatioVals).toFixed(2)}x`);
  console.log(`市場バイアス:       平均 ${avg(biasVals).toFixed(4)}, 中央値 ${median(biasVals).toFixed(4)}, 最小 ${Math.min(...biasVals).toFixed(4)}, 最大 ${Math.max(...biasVals).toFixed(4)}`);
  console.log(`エントリー後1本変化率: 平均 ${avg(post1Vals).toFixed(2)}%, 中央値 ${median(post1Vals).toFixed(2)}%`);
  console.log(`エントリー後3本変化率: 平均 ${avg(post3Vals).toFixed(2)}%, 中央値 ${median(post3Vals).toFixed(2)}%`);
  console.log(`最大逆行幅:         平均 ${avg(maxAdverseVals).toFixed(2)}%, 中央値 ${median(maxAdverseVals).toFixed(2)}%, 最大 ${Math.max(...maxAdverseVals).toFixed(2)}%`);

  // ━━━ 3. RSI分布 ━━━
  console.log("\n━━━ 3. RSI分布（エントリー時） ━━━");
  const rsiBuckets = [
    { label: "RSI < 30 (売られすぎ)", min: 0, max: 30 },
    { label: "RSI 30-40", min: 30, max: 40 },
    { label: "RSI 40-50", min: 40, max: 50 },
    { label: "RSI 50-60", min: 50, max: 60 },
    { label: "RSI 60-70", min: 60, max: 70 },
    { label: "RSI 70+ (買われすぎ)", min: 70, max: 100 },
  ];
  for (const b of rsiBuckets) {
    const cnt = rsiVals.filter(r => r >= b.min && r < b.max).length;
    const bar = "█".repeat(cnt * 2);
    console.log(`  ${b.label.padEnd(22)} ${cnt.toString().padStart(3)}件 ${bar}`);
  }

  // ━━━ 4. 市場バイアス分布 ━━━
  console.log("\n━━━ 4. 市場バイアス分布（エントリー時） ━━━");
  const biasBuckets = [
    { label: "< -0.01 (強い下落相場)", min: -1, max: -0.01 },
    { label: "-0.01〜0 (弱い下落)", min: -0.01, max: 0 },
    { label: "0〜+0.01 (弱い上昇)", min: 0, max: 0.01 },
    { label: "+0.01〜+0.02 (上昇)", min: 0.01, max: 0.02 },
    { label: "> +0.02 (強い上昇相場)", min: 0.02, max: 1 },
  ];
  for (const b of biasBuckets) {
    const cnt = biasVals.filter(v => v >= b.min && v < b.max).length;
    const bar = "█".repeat(cnt * 2);
    console.log(`  ${b.label.padEnd(24)} ${cnt.toString().padStart(3)}件 ${bar}`);
  }

  // ━━━ 5. 5本前からの上昇率分布 ━━━
  console.log("\n━━━ 5. エントリー直前5本の上昇率分布 ━━━");
  const pre5Buckets = [
    { label: "< -1.0% (急落後)", min: -10, max: -1.0 },
    { label: "-1.0〜-0.5%", min: -1.0, max: -0.5 },
    { label: "-0.5〜0% (下落)", min: -0.5, max: 0 },
    { label: "0〜+0.5% (小幅上昇)", min: 0, max: 0.5 },
    { label: "+0.5〜+1.0% (上昇)", min: 0.5, max: 1.0 },
    { label: "> +1.0% (急騰後)", min: 1.0, max: 10 },
  ];
  for (const b of pre5Buckets) {
    const cnt = pre5Vals.filter(v => v >= b.min && v < b.max).length;
    const bar = "█".repeat(cnt * 2);
    console.log(`  ${b.label.padEnd(22)} ${cnt.toString().padStart(3)}件 ${bar}`);
  }

  // ━━━ 6. 出来高比分布 ━━━
  console.log("\n━━━ 6. 出来高比分布（エントリー時 vs 直近20本平均） ━━━");
  const volBuckets = [
    { label: "< 0.5x (出来高少ない)", min: 0, max: 0.5 },
    { label: "0.5〜1.0x (平均以下)", min: 0.5, max: 1.0 },
    { label: "1.0〜1.5x (平均的)", min: 1.0, max: 1.5 },
    { label: "1.5〜2.0x (やや多い)", min: 1.5, max: 2.0 },
    { label: "2.0〜3.0x (多い)", min: 2.0, max: 3.0 },
    { label: "> 3.0x (急増)", min: 3.0, max: 100 },
  ];
  for (const b of volBuckets) {
    const cnt = volRatioVals.filter(v => v >= b.min && v < b.max).length;
    const bar = "█".repeat(cnt * 2);
    console.log(`  ${b.label.padEnd(22)} ${cnt.toString().padStart(3)}件 ${bar}`);
  }

  // ━━━ 7. 銘柄別集計 ━━━
  console.log("\n━━━ 7. 銘柄別集計 ━━━");
  const bySymbol = new Map<string, { name: string; count: number; totalProfit: number; avgRsi: number; avgPre5: number; avgBias: number; avgVolRatio: number }>();
  for (const c of cases) {
    const a = bySymbol.get(c.symbol) ?? { name: c.name, count: 0, totalProfit: 0, avgRsi: 0, avgPre5: 0, avgBias: 0, avgVolRatio: 0 };
    a.count++; a.totalProfit += c.profit; a.avgRsi += c.rsiAtEntry ?? 50; a.avgPre5 += c.pre5ChangePercent; a.avgBias += c.marketBiasAtEntry; a.avgVolRatio += c.volRatioAtEntry;
    bySymbol.set(c.symbol, a);
  }
  console.log(`${"銘柄".padEnd(20)} ${"件数".padStart(4)} ${"合計損失".padStart(10)} ${"平均RSI".padStart(8)} ${"平均5本前%".padStart(10)} ${"平均バイアス".padStart(12)} ${"平均出来高比".padStart(12)}`);
  console.log("-".repeat(85));
  for (const [sym, a] of Array.from(bySymbol.entries()).sort((x, y) => x[1].totalProfit - y[1].totalProfit)) {
    const n = a.count;
    console.log(`${a.name.substring(0, 18).padEnd(20)} ${n.toString().padStart(4)} ${a.totalProfit.toString().padStart(10)} ${(a.avgRsi/n).toFixed(1).padStart(8)} ${(a.avgPre5/n).toFixed(2).padStart(9)}% ${(a.avgBias/n).toFixed(4).padStart(12)} ${(a.avgVolRatio/n).toFixed(2).padStart(11)}x`);
  }

  // ━━━ 8. 時間帯別集計 ━━━
  console.log("\n━━━ 8. 時間帯別集計 ━━━");
  const byHour = new Map<number, { count: number; totalProfit: number; avgRsi: number; avgBias: number }>();
  for (const c of cases) {
    const hour = parseInt(c.entryTime.split(":")[0]);
    const a = byHour.get(hour) ?? { count: 0, totalProfit: 0, avgRsi: 0, avgBias: 0 };
    a.count++; a.totalProfit += c.profit; a.avgRsi += c.rsiAtEntry ?? 50; a.avgBias += c.marketBiasAtEntry;
    byHour.set(hour, a);
  }
  console.log(`${"時間帯".padEnd(8)} ${"件数".padStart(4)} ${"合計損失".padStart(10)} ${"平均RSI".padStart(8)} ${"平均バイアス".padStart(12)}`);
  console.log("-".repeat(50));
  for (const [hour, a] of Array.from(byHour.entries()).sort((x, y) => x[0] - y[0])) {
    const n = a.count;
    console.log(`${(hour + "時台").padEnd(8)} ${n.toString().padStart(4)} ${a.totalProfit.toString().padStart(10)} ${(a.avgRsi/n).toFixed(1).padStart(8)} ${(a.avgBias/n).toFixed(4).padStart(12)}`);
  }

  // ━━━ 9. 回避条件の候補 ━━━
  console.log("\n━━━ 9. 回避条件の候補（閾値別ヒット率） ━━━");
  const conditions = [
    { label: "市場バイアス > +0.005（上昇相場でショート禁止）", fn: (c: ShortStopCase) => c.marketBiasAtEntry > 0.005 },
    { label: "市場バイアス > +0.003", fn: (c: ShortStopCase) => c.marketBiasAtEntry > 0.003 },
    { label: "市場バイアス > 0（プラスでショート禁止）", fn: (c: ShortStopCase) => c.marketBiasAtEntry > 0 },
    { label: "5本前から+0.3%以上上昇してショート", fn: (c: ShortStopCase) => c.pre5ChangePercent > 0.3 },
    { label: "5本前から+0.5%以上上昇してショート", fn: (c: ShortStopCase) => c.pre5ChangePercent > 0.5 },
    { label: "5本前から+1.0%以上上昇してショート", fn: (c: ShortStopCase) => c.pre5ChangePercent > 1.0 },
    { label: "1本前から+0.2%以上上昇してショート", fn: (c: ShortStopCase) => c.pre1ChangePercent > 0.2 },
    { label: "1本前から+0.3%以上上昇してショート", fn: (c: ShortStopCase) => c.pre1ChangePercent > 0.3 },
    { label: "RSI < 40 でショート（売られすぎ）", fn: (c: ShortStopCase) => (c.rsiAtEntry ?? 50) < 40 },
    { label: "RSI < 45 でショート", fn: (c: ShortStopCase) => (c.rsiAtEntry ?? 50) < 45 },
    { label: "出来高比 > 2.0x でショート", fn: (c: ShortStopCase) => c.volRatioAtEntry > 2.0 },
    { label: "出来高比 > 1.5x でショート", fn: (c: ShortStopCase) => c.volRatioAtEntry > 1.5 },
    { label: "バイアス>0 かつ 5本前+0.3%以上", fn: (c: ShortStopCase) => c.marketBiasAtEntry > 0 && c.pre5ChangePercent > 0.3 },
    { label: "バイアス>0.003 かつ 1本前+0.2%以上", fn: (c: ShortStopCase) => c.marketBiasAtEntry > 0.003 && c.pre1ChangePercent > 0.2 },
  ];
  for (const cond of conditions) {
    const hits = cases.filter(cond.fn);
    const hitRate = cases.length > 0 ? hits.length / cases.length * 100 : 0;
    const hitProfit = hits.reduce((s, c) => s + c.profit, 0);
    console.log(`  ${cond.label.padEnd(40)} ヒット ${hits.length.toString().padStart(3)}件 (${hitRate.toFixed(0).padStart(3)}%) 損失 ${hitProfit.toLocaleString().padStart(10)}円`);
  }

  // ━━━ 10. CSV出力 ━━━
  const outDir = path.join(process.cwd(), "analysis", "jq_out");
  fs.mkdirSync(outDir, { recursive: true });
  const csvRows = ["date,symbol,name,entryTime,exitTime,profit,lossPercent,rsiAtEntry,pre5Change,pre3Change,pre1Change,volRatio,marketBias,post1Change,post3Change,maxAdverse,marketEff,isRangeBound"];
  for (const c of cases) {
    csvRows.push([
      c.date, c.symbol, `"${c.name}"`, c.entryTime, c.exitTime,
      c.profit, c.lossPercent.toFixed(3),
      (c.rsiAtEntry ?? "").toString(), c.pre5ChangePercent.toFixed(3),
      c.pre3ChangePercent.toFixed(3), c.pre1ChangePercent.toFixed(3),
      c.volRatioAtEntry.toFixed(3), c.marketBiasAtEntry.toFixed(5),
      c.post1ChangePercent.toFixed(3), c.post3ChangePercent.toFixed(3),
      c.maxAdversePercent.toFixed(3), c.marketEff.toFixed(3), String(c.isRangeBound),
    ].join(","));
  }
  fs.writeFileSync(path.join(outDir, "short_stop_cases.csv"), csvRows.join("\n"), "utf8");
  console.log(`\n[出力] analysis/jq_out/short_stop_cases.csv に ${cases.length}件を保存`);
}

main();
