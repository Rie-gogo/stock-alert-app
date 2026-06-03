/**
 * paramSweep.ts
 * 過去5営業日分の1分足を全銘柄取得し、複数の損切り幅でシミュレーションを実行して
 * 合計損益・勝率を比較する。データ取得は1回だけ行い、シミュレーションのみ繰り返す。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/paramSweep.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
} from "../server/realSimulation";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const slice = data.slice(i - period + 1, i + 1);
    result[i] = slice.reduce((a, b) => a + b, 0) / period;
  }
  return result;
}
function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = []; const losses: number[] = [];
  for (let i = 1; i < data.length; i++) { const diff = data[i] - data[i - 1]; gains.push(Math.max(diff, 0)); losses.push(Math.max(-diff, 0)); }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100; else { const rs = avgGain / avgLoss; result[i] = 100 - 100 / (1 + rs); }
    if (i < data.length - 1) { avgGain = (avgGain * (period - 1) + gains[i]) / period; avgLoss = (avgLoss * (period - 1) + losses[i]) / period; }
  }
  return result;
}
function calcBollinger(data: number[], period = 20, stdDevMult = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = avg + stdDevMult * std; lower[i] = avg - stdDevMult * std;
  }
  return { upper, lower };
}

interface RawBar { timestamp: number; jstDate: string; time: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetch5dByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const rawData = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "1m", range: "5d" } });
  const data = rawData as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }> } }> } };
  const byDay = new Map<string, RawBar[]>();
  const result = data?.chart?.result?.[0]; if (!result) return byDay;
  const ts = result.timestamp ?? []; const q = result.indicators.quote[0];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || c == null) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    const jstDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`;
    const hh = String(jst.getUTCHours()).padStart(2,"0"); const mm = String(jst.getUTCMinutes()).padStart(2,"0");
    const arr = byDay.get(jstDate) ?? [];
    arr.push({ timestamp: ts[i]*1000, jstDate, time: `${hh}:${mm}`, open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0 });
    byDay.set(jstDate, arr);
  }
  return byDay;
}
function toCandles(bars: RawBar[]): RealCandle[] {
  const candles: RealCandle[] = bars.map(b => ({ time: b.time, timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14); const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const signedVol = candles.map(c => { const range = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / range; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

async function main() {
  console.log("[sweep] Fetching 5d 1m data for all symbols...");
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try { byTicker.set(s.symbol, await fetch5dByDay(s.ticker)); } catch (e) { console.warn(`  ${s.symbol} fetch failed:`, (e as Error).message); }
    await new Promise(r => setTimeout(r, 350));
  }
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[sweep] Days: ${allDays.join(", ")}`);

  // 日ごとの candleMap / marketBias / rangeBound を事前計算（シミュ前の共通処理）
  const dayCtx = allDays.map(day => {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, toCandles(bars));
    }
    if (candleMap.size < 5) return null;
    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const rangeBound = isRangeBoundDay(computeMarketEfficiency(dayStats));
    return { day, candleMap, marketBiasByProgress, rangeBound };
  }).filter((x): x is NonNullable<typeof x> => x !== null);

  const stopLevels = [0.8, 1.0, 1.2, 1.5, 2.0];
  console.log("\n===== STOP-LOSS SWEEP (5 days total) =====");
  console.log("stopLoss%, totalProfit, avgPerDay, win, loss, winRate, dailyBreakdown");
  for (const sl of stopLevels) {
    let total = 0, win = 0, loss = 0; const daily: number[] = [];
    for (const ctx of dayCtx) {
      let dp = 0;
      for (const s of TARGET_STOCKS) {
        const candles = ctx.candleMap.get(s.symbol); if (!candles) continue;
        const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, ctx.marketBiasByProgress, 3_000_000, 70, 30, sl, ctx.rangeBound);
        if (!res) continue;
        dp += res.profitAmount; win += res.winCount; loss += res.lossCount;
      }
      total += dp; daily.push(Math.round(dp));
    }
    const wr = (win + loss) > 0 ? win / (win + loss) : 0;
    console.log(`${sl}%, ${Math.round(total)}, ${Math.round(total / dayCtx.length)}, ${win}, ${loss}, ${(wr*100).toFixed(1)}%, [${daily.join(", ")}]`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
