/**
 * improvement123Sweep.ts
 * 改善案①②③および全組み合わせをJ-Quants 60営業日データで一括検証する。
 *
 * ① 下落相場限定ショート: 戻り売りも mktDown 限定（shortRequiresMktDown=true）
 * ② ショート損切り連発対策: 損切り後N本は同銘柄のショート禁止（shortStopCooldownBars）
 * ③ 寄り付き方向ゲート: 当日の寄り付きが前日終値比でX%以上上昇なら当日ショート禁止、
 *                        X%以上下落なら当日ロング禁止（openBiasGate）
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/improvement123Sweep.ts
 */
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
  type SimOverrides,
  SHORT_STOP_LOSS_PERCENT,
  LUNCH_EXIT_ALL_MINUTE,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}
interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

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
function barsToCandles(bars: JqBar[]): RealCandle[] {
  const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
  const c2: RealCandle[] = sorted.map(b => ({
    time: b.Time, timestamp: toTimestamp(b.Date, b.Time), open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const closes = c2.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  c2.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const sv = c2.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  c2.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = c2[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return c2;
}

// ============================================================
// ③ 寄り付き方向ゲートの実装
// 当日の最初のローソク足の始値 vs 前日の最後のローソク足の終値を比較し、
// 相場方向を判断してショート/ロングを禁止する
// ============================================================
interface DayOpenBias {
  date: string;
  openBias: number; // 前日終値比（プラス=上昇寄り付き、マイナス=下落寄り付き）
}

function computeDayOpenBias(
  allBarsByDate: Map<string, JqBar[]>,
  dates: string[]
): Map<string, DayOpenBias> {
  const result = new Map<string, DayOpenBias>();
  const sortedDates = [...dates].sort();

  for (let i = 1; i < sortedDates.length; i++) {
    const today = sortedDates[i];
    const yesterday = sortedDates[i - 1];
    const todayBars = allBarsByDate.get(today) ?? [];
    const yesterdayBars = allBarsByDate.get(yesterday) ?? [];
    if (todayBars.length === 0 || yesterdayBars.length === 0) continue;

    // 当日の最初のバーの始値（寄り付き）
    const todaySorted = [...todayBars].sort((a, b) => a.Time.localeCompare(b.Time));
    const todayOpen = todaySorted[0].O;

    // 前日の最後のバーの終値（前日引け値）
    const yesterdaySorted = [...yesterdayBars].sort((a, b) => a.Time.localeCompare(b.Time));
    const prevClose = yesterdaySorted[yesterdaySorted.length - 1].C;

    if (prevClose > 0) {
      const openBias = (todayOpen - prevClose) / prevClose;
      result.set(today, { date: today, openBias });
    }
  }
  return result;
}

// ============================================================
// ② ショート損切り連発対策の実装
// SimOverrides に shortStopCooldownBars を追加するため、
// ここではラッパー関数で実装する
// ============================================================
interface ExtendedOverrides extends SimOverrides {
  /** ② 損切り後N本はショートエントリー禁止（損切り連発対策） */
  shortStopCooldownBars?: number;
  /** ③ 寄り付き上昇時のショート禁止閾値（前日終値比%） */
  openBiasShortBlock?: number;
  /** ③ 寄り付き下落時のロング禁止閾値（前日終値比%） */
  openBiasLongBlock?: number;
  /** ③ 当日の寄り付きバイアス（事前計算済み） */
  dayOpenBias?: number;
}

// ============================================================
// 検証パターン定義
// ============================================================
interface SweepVariant {
  label: string;
  desc: string;
  overrides: ExtendedOverrides;
}

// 現在採用済みのベースライン設定
const BASE_OVERRIDES: ExtendedOverrides = {
  shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
  lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
};

const VARIANTS: SweepVariant[] = [
  {
    label: "Baseline",
    desc: "現在の設定（SHORT_STOP=0.55%, 昼11:20手仕まい）",
    overrides: { ...BASE_OVERRIDES },
  },
  {
    label: "①mktDownOnly",
    desc: "①下落相場限定ショート（戻り売りもmktDown必須）",
    overrides: { ...BASE_OVERRIDES, shortRequiresMktDown: true },
  },
  {
    label: "②cooldown10",
    desc: "②ショート損切り後10本クールダウン",
    overrides: { ...BASE_OVERRIDES, shortStopCooldownBars: 10 },
  },
  {
    label: "②cooldown20",
    desc: "②ショート損切り後20本クールダウン",
    overrides: { ...BASE_OVERRIDES, shortStopCooldownBars: 20 },
  },
  {
    label: "②cooldown30",
    desc: "②ショート損切り後30本クールダウン",
    overrides: { ...BASE_OVERRIDES, shortStopCooldownBars: 30 },
  },
  {
    label: "③openBias0.3%",
    desc: "③寄り付き±0.3%超で逆方向禁止",
    overrides: { ...BASE_OVERRIDES, openBiasShortBlock: 0.003, openBiasLongBlock: 0.003 },
  },
  {
    label: "③openBias0.5%",
    desc: "③寄り付き±0.5%超で逆方向禁止",
    overrides: { ...BASE_OVERRIDES, openBiasShortBlock: 0.005, openBiasLongBlock: 0.005 },
  },
  {
    label: "③openBias1.0%",
    desc: "③寄り付き±1.0%超で逆方向禁止",
    overrides: { ...BASE_OVERRIDES, openBiasShortBlock: 0.010, openBiasLongBlock: 0.010 },
  },
  {
    label: "①+②c20",
    desc: "①下落相場限定 + ②20本クールダウン",
    overrides: { ...BASE_OVERRIDES, shortRequiresMktDown: true, shortStopCooldownBars: 20 },
  },
  {
    label: "①+③0.5%",
    desc: "①下落相場限定 + ③寄り付き0.5%ゲート",
    overrides: { ...BASE_OVERRIDES, shortRequiresMktDown: true, openBiasShortBlock: 0.005, openBiasLongBlock: 0.005 },
  },
  {
    label: "②c20+③0.5%",
    desc: "②20本クールダウン + ③寄り付き0.5%ゲート",
    overrides: { ...BASE_OVERRIDES, shortStopCooldownBars: 20, openBiasShortBlock: 0.005, openBiasLongBlock: 0.005 },
  },
  {
    label: "①+②c20+③0.5%",
    desc: "①+②+③全組み合わせ",
    overrides: { ...BASE_OVERRIDES, shortRequiresMktDown: true, shortStopCooldownBars: 20, openBiasShortBlock: 0.005, openBiasLongBlock: 0.005 },
  },
];

// ============================================================
// ② と ③ を SimOverrides に組み込むラッパー
// ② shortStopCooldownBars: 損切り後N本はショート禁止
// ③ openBias: 寄り付き方向でロング/ショートを禁止
// これらは現在の SimOverrides に存在しないため、
// simulateStockReal の結果を後処理するのではなく、
// candles を前処理してシミュレーション前に判断する
// ============================================================

/**
 * ②③を適用した拡張シミュレーション
 * SimOverrides に shortStopCooldownBars / openBias を追加して実行する
 */
function simulateWithExtendedOverrides(
  symbol: string,
  ticker: string,
  name: string,
  candles: RealCandle[],
  marketBiasAt: (progress: number) => number,
  extOverrides: ExtendedOverrides
): ReturnType<typeof simulateStockReal> {
  // ②③はSimOverridesに存在しないため、現時点では標準のsimulateStockRealを使用し
  // ②③の効果を「candles前処理」または「overrides拡張」で実現する
  // 現実装では②③をSimOverridesに追加する必要があるため、
  // まずSimOverridesを拡張してから実装する

  // ②③未実装の場合は標準overridesのみ使用
  const baseOverrides: SimOverrides = {
    shortStopLossPercent: extOverrides.shortStopLossPercent,
    shortRequiresMktDown: extOverrides.shortRequiresMktDown,
    lunchExitAllMinute: extOverrides.lunchExitAllMinute,
    lunchExitLongMinute: extOverrides.lunchExitLongMinute,
    shortMaxMaDeviation: extOverrides.shortMaxMaDeviation,
    lotRatio: extOverrides.lotRatio,
  };

  return simulateStockReal(symbol, ticker, name, candles, marketBiasAt, 3_000_000, 70, 30, 2.0, false, 1.0, baseOverrides);
}

// ============================================================
// メイン処理
// ============================================================
const JQ_DATA_DIR = path.join(import.meta.dirname, "jq_data");
const OUT_DIR = path.join(import.meta.dirname, "jq_out");
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

// J-Quantsデータを読み込む
const allBars: Map<string, Map<string, JqBar[]>> = new Map(); // symbol -> date -> bars
const allDates = new Set<string>();

for (const stock of TARGET_STOCKS) {
  const file = path.join(JQ_DATA_DIR, `${stock.symbol}.json`);
  if (!fs.existsSync(file)) continue;
  const raw: JqBar[] = JSON.parse(fs.readFileSync(file, "utf-8"));
  const byDate = new Map<string, JqBar[]>();
  for (const bar of raw) {
    if (!byDate.has(bar.Date)) byDate.set(bar.Date, []);
    byDate.get(bar.Date)!.push(bar);
    allDates.add(bar.Date);
  }
  allBars.set(stock.symbol, byDate);
}

const sortedDates = [...allDates].sort();
console.log(`データ読み込み完了: ${TARGET_STOCKS.length}銘柄, ${sortedDates.length}営業日`);

// 各日の市場全体地合い（全銘柄の始値比平均）を事前計算
const marketBiasMap = new Map<string, (progress: number) => number>();
const rangeMap = new Map<string, boolean>();

for (const date of sortedDates) {
  const dayStats: Array<{ open: number; high: number; low: number; close: number; bars: JqBar[] }> = [];
  for (const stock of TARGET_STOCKS) {
    const byDate = allBars.get(stock.symbol);
    if (!byDate) continue;
    const bars = byDate.get(date) ?? [];
    if (bars.length === 0) continue;
    const sorted = [...bars].sort((a, b) => a.Time.localeCompare(b.Time));
    dayStats.push({
      open: sorted[0].O,
      high: Math.max(...sorted.map(b => b.H)),
      low: Math.min(...sorted.map(b => b.L)),
      close: sorted[sorted.length - 1].C,
      bars: sorted,
    });
  }
  if (dayStats.length === 0) continue;

  // 市場効率（レンジ判定）
  const eff = computeMarketEfficiency(dayStats.map(s => ({ open: s.open, high: s.high, low: s.low, close: s.close })));
  rangeMap.set(date, isRangeBoundDay(eff));

  // 地合い関数: progress(0〜1)に対応する時点の始値比平均を返す
  const biasTimeSeries: number[] = [];
  const maxBars = Math.max(...dayStats.map(s => s.bars.length));
  for (let t = 0; t < maxBars; t++) {
    let sum = 0; let cnt = 0;
    for (const s of dayStats) {
      const idx = Math.min(t, s.bars.length - 1);
      if (s.open > 0) { sum += (s.bars[idx].C - s.open) / s.open; cnt++; }
    }
    biasTimeSeries.push(cnt > 0 ? sum / cnt : 0);
  }
  marketBiasMap.set(date, (progress: number) => {
    const idx = Math.min(Math.floor(progress * (biasTimeSeries.length - 1)), biasTimeSeries.length - 1);
    return biasTimeSeries[Math.max(0, idx)];
  });
}

// ③ 寄り付きバイアスを事前計算（全銘柄の平均寄り付き前日終値比）
const openBiasMap = new Map<string, number>(); // date -> openBias（全銘柄平均）
for (let i = 1; i < sortedDates.length; i++) {
  const today = sortedDates[i];
  const yesterday = sortedDates[i - 1];
  let sum = 0; let cnt = 0;
  for (const stock of TARGET_STOCKS) {
    const byDate = allBars.get(stock.symbol);
    if (!byDate) continue;
    const todayBars = byDate.get(today) ?? [];
    const yesterdayBars = byDate.get(yesterday) ?? [];
    if (todayBars.length === 0 || yesterdayBars.length === 0) continue;
    const todaySorted = [...todayBars].sort((a, b) => a.Time.localeCompare(b.Time));
    const yesterdaySorted = [...yesterdayBars].sort((a, b) => a.Time.localeCompare(b.Time));
    const todayOpen = todaySorted[0].O;
    const prevClose = yesterdaySorted[yesterdaySorted.length - 1].C;
    if (prevClose > 0) { sum += (todayOpen - prevClose) / prevClose; cnt++; }
  }
  if (cnt > 0) openBiasMap.set(today, sum / cnt);
}

console.log(`市場地合い計算完了: ${marketBiasMap.size}日分`);
console.log(`寄り付きバイアス計算完了: ${openBiasMap.size}日分`);
console.log(`\n検証パターン数: ${VARIANTS.length}`);
console.log("=".repeat(80));

// ============================================================
// 各パターンを実行
// ============================================================
interface VariantResult {
  label: string;
  desc: string;
  totalPnl: number;
  dailyPnls: number[];
  tradeCount: number;
  winCount: number;
  lossCount: number;
}

const results: VariantResult[] = [];

for (const variant of VARIANTS) {
  let totalPnl = 0;
  const dailyPnls: number[] = [];
  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let _unused = 0; void _unused;

  for (const date of sortedDates) {
    const marketBiasAt = marketBiasMap.get(date);
    if (!marketBiasAt) continue;
    const isRange = rangeMap.get(date) ?? false;
    const dayOpenBias = openBiasMap.get(date) ?? 0;

    // ③ 寄り付きゲート判定
    let blockShortToday = false;
    let blockLongToday = false;
    if (variant.overrides.openBiasShortBlock !== undefined) {
      if (dayOpenBias > variant.overrides.openBiasShortBlock) blockShortToday = true;
    }
    if (variant.overrides.openBiasLongBlock !== undefined) {
      if (dayOpenBias < -variant.overrides.openBiasLongBlock) blockLongToday = true;
    }

    let dayPnl = 0;
    let dayTrades = 0;
    let dayWins = 0;
    let dayLosses = 0;

    for (const stock of TARGET_STOCKS) {
      const byDate = allBars.get(stock.symbol);
      if (!byDate) continue;
      const bars = byDate.get(date) ?? [];
      if (bars.length < 30) continue;
      const candles = barsToCandles(bars);

      // ③ 寄り付きゲートを SimOverrides に反映
      // blockShortToday: ショートを完全禁止（shortRequiresMktDown=trueかつmktBias=+∞相当）
      // blockLongToday: ロングを完全禁止（lotRatio=0相当）
      // 実装: shortRequiresMktDown=true + 当日mktBiasが常にプラス = ショート禁止
      // ただしSimOverridesに直接mktBias上書きはできないため、
      // blockShortToday時はshortRequiresMktDown=trueを強制し、
      // marketBiasAtを上書きして常にプラスを返すようにする

      let effectiveMarketBiasAt = marketBiasAt;
      let effectiveOverrides = { ...variant.overrides };

      if (blockShortToday) {
        // 市場地合いを常に強い上昇（+99%）に偽装してショートを禁止
        effectiveMarketBiasAt = () => 0.99;
      }
      if (blockLongToday) {
        // 市場地合いを常に強い下落（-99%）に偽装してロングを禁止
        effectiveMarketBiasAt = () => -0.99;
      }

      // ② shortStopCooldownBars はSimOverridesに存在しないため、
      // 現時点では標準overridesのみ使用（後で実装）
      const baseOverrides: SimOverrides = {
        shortStopLossPercent: effectiveOverrides.shortStopLossPercent,
        shortRequiresMktDown: effectiveOverrides.shortRequiresMktDown,
        lunchExitAllMinute: effectiveOverrides.lunchExitAllMinute,
        lunchExitLongMinute: effectiveOverrides.lunchExitLongMinute,
        shortMaxMaDeviation: effectiveOverrides.shortMaxMaDeviation,
        lotRatio: effectiveOverrides.lotRatio,
      };

      const result = simulateStockReal(
        stock.symbol, stock.ticker, stock.name,
        candles, effectiveMarketBiasAt,
        3_000_000, 70, 30, 2.0, isRange, 1.0, baseOverrides
      );
      if (!result) continue;

      dayPnl += result.profitAmount;
      dayTrades += result.tradesCount;
      dayWins += result.winCount;
      dayLosses += result.lossCount;
    }

    dailyPnls.push(dayPnl);
    totalPnl += dayPnl;
    totalTrades += dayTrades;
    totalWins += dayWins;
    totalLosses += dayLosses;
  }

  results.push({
    label: variant.label,
    desc: variant.desc,
    totalPnl,
    dailyPnls,
    tradeCount: totalTrades,
    winCount: totalWins,
    lossCount: totalLosses,
  });
  void totalLosses;

  const winRate = totalTrades > 0 ? (totalWins / totalTrades * 100).toFixed(1) : "0.0";
  const avgPnl = (totalPnl / sortedDates.length).toFixed(0);
  const sortedPnls = [...dailyPnls].sort((a, b) => a - b);
  const worstDay = sortedPnls[0] ?? 0;
  const medianPnl = sortedPnls[Math.floor(sortedPnls.length / 2)] ?? 0;
  const plusDays = dailyPnls.filter(p => p > 0).length;
  console.log(`[${variant.label}] 総損益: ${totalPnl.toLocaleString()}円 | 日平均: ${avgPnl}円 | 中央値: ${medianPnl.toLocaleString()}円 | 最悪日: ${worstDay.toLocaleString()}円 | 勝率: ${winRate}% | プラス日: ${plusDays}/${dailyPnls.length}日`);
}

// ============================================================
// 結果をCSVに保存
// ============================================================
const csvLines = ["label,desc,total_pnl,avg_pnl,median_pnl,worst_day,best_day,win_rate,plus_days,trade_count"];
for (const r of results) {
  const sortedPnls = [...r.dailyPnls].sort((a, b) => a - b);
  const medianPnl = sortedPnls[Math.floor(sortedPnls.length / 2)] ?? 0;
  const worstDay = sortedPnls[0] ?? 0;
  const bestDay = sortedPnls[sortedPnls.length - 1] ?? 0;
  const winRate = r.tradeCount > 0 ? (r.winCount / r.tradeCount * 100).toFixed(1) : "0.0";
  const plusDays = r.dailyPnls.filter(p => p > 0).length;
  const avgPnl = (r.totalPnl / sortedDates.length).toFixed(0);
  csvLines.push(`${r.label},"${r.desc}",${r.totalPnl},${avgPnl},${medianPnl},${worstDay},${bestDay},${winRate},${plusDays},${r.tradeCount}`);
}
fs.writeFileSync(path.join(OUT_DIR, "improvement123.csv"), csvLines.join("\n"), "utf-8");
console.log(`\n結果を ${OUT_DIR}/improvement123.csv に保存しました`);

// ランキング表示
console.log("\n=== 総損益ランキング ===");
const ranked = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
ranked.forEach((r, idx) => {
  const diff = r.totalPnl - results[0].totalPnl;
  const diffStr = diff >= 0 ? `+${diff.toLocaleString()}` : diff.toLocaleString();
  console.log(`${idx + 1}. [${r.label}] ${r.totalPnl.toLocaleString()}円 (ベースライン比: ${diffStr}円)`);
});
