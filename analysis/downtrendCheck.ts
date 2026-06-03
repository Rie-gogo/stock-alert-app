/**
 * downtrendCheck.ts
 * 直近5営業日(1分足・本番ロジックそのまま)の中から、下落色の強い日を含めて
 * 「下落日に戦略がどう振る舞うか」を検証する。
 *   - 各日の市場バイアス（寄り→引けの全銘柄平均騰落）で上昇日/下落日を判定
 *   - ロング/ショート別の損益・件数・勝率
 *   - 決済理由別（トレイリング/損切り/引け 等）の集計
 *   - デイリーストップ(口座-15000)の発動有無
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/downtrendCheck.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import { applyPortfolioRules, type PerStockTrades, DEFAULT_PORTFOLIO_CONFIG } from "../server/portfolio";
import { simulateStockReal, computeMarketEfficiency, isRangeBoundDay } from "../server/realSimulation";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}
const FLOW_LOOKBACK = 10;
const SLOPE_LOOKBACK = 25;

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
    if (al === 0) r[i] = 100; else { const rs = ag / al; r[i] = 100 - 100 / (1 + rs); }
    if (i < data.length - 1) { ag = (ag * (period - 1) + gains[i]) / period; al = (al * (period - 1) + losses[i]) / period; }
  }
  return r;
}
function calcBollinger(data: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const w = data.slice(i - period + 1, i + 1);
    const avg = w.reduce((a, b) => a + b, 0) / period;
    const std = Math.sqrt(w.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
    upper[i] = avg + mult * std; lower[i] = avg - mult * std;
  }
  return { upper, lower };
}
interface RawBar { timestamp: number; jstDate: string; time: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetch5dByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "1m", range: "5d" } });
  const data = raw as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }> } }> } };
  const byDay = new Map<string, RawBar[]>();
  const result = data?.chart?.result?.[0];
  if (!result) return byDay;
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i], v = q.volume[i];
    if (o == null || c == null) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    const jstDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    const time = `${String(jst.getUTCHours()).padStart(2, "0")}:${String(jst.getUTCMinutes()).padStart(2, "0")}`;
    const arr = byDay.get(jstDate) ?? [];
    arr.push({ timestamp: ts[i] * 1000, jstDate, time, open: o, high: h ?? o, low: l ?? o, close: c, volume: v ?? 0 });
    byDay.set(jstDate, arr);
  }
  return byDay;
}
function toCandles(bars: RawBar[]): RealCandle[] {
  const candles: RealCandle[] = bars.map(b => ({ time: b.time, timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null }));
  const closes = candles.map(c => c.close);
  const ma5 = calcMA(closes, 5), ma25 = calcMA(closes, 25), rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  candles.forEach((c, i) => { c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i]; c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i]; });
  const signedVol = candles.map(c => { const range = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / range; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

async function main() {
  console.log("[downtrend] Fetching 5d 1m data for all symbols...");
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try { byTicker.set(s.symbol, await fetch5dByDay(s.ticker)); } catch (e) { console.warn(`  ${s.symbol} fail`, (e as Error).message); }
    await new Promise(r => setTimeout(r, 350));
  }
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();

  console.log("\nday\tbias%\teff\tlong#\tlongP\tshort#\tshortP\tportfolioP\tstop?");
  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 60) continue;
      candleMap.set(s.symbol, toCandles(bars));
    }
    if (candleMap.size < 5) continue;
    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);
    // 市場バイアス（寄り→引けの全銘柄平均騰落）
    const bias = dayStats.reduce((a, s) => a + (s.open > 0 ? (s.close - s.open) / s.open : 0), 0) / dayStats.length * 100;

    const perStock: PerStockTrades[] = [];
    let longCnt = 0, longP = 0, shortCnt = 0, shortP = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol);
      if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound);
      if (!res) continue;
      perStock.push({ symbol: s.symbol, trades: res.trades });
      for (const t of res.trades) {
        const p = (t as { profit?: number }).profit ?? 0;
        if (t.type === "sell") { longCnt++; longP += p; }
        else if (t.type === "cover") { shortCnt++; shortP += p; }
      }
    }
    const port = applyPortfolioRules(perStock, { ...DEFAULT_PORTFOLIO_CONFIG, dailyLossLimit: 15000, dailyProfitTarget: 0, momentumAllocation: true });
    console.log(`${day}\t${bias.toFixed(2)}\t${eff.toFixed(2)}\t${longCnt}\t${Math.round(longP)}\t${shortCnt}\t${Math.round(shortP)}\t${Math.round(port.acceptedProfit)}\t${port.dailyStopTriggered ? port.dailyStopReason : "-"}`);
  }
  console.log("\n注: type=buy がロング(買い)、type=sell がショート(空売り)。bias%が負の日が下落相場日。");
}

main().catch(e => { console.error(e); process.exit(1); });
