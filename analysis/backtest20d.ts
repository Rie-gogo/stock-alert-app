/**
 * backtest20d.ts
 * 5分足(interval=5m, range=1mo)で直近20営業日分を全銘柄取得し、
 * 本番と同一の改善後ロジック(simulateStockReal, 損切り2.0%)でバックテストする。
 *
 * 1分足は過去5〜7営業日しか取得できないため、20営業日の傾向把握には5分足を用いる。
 * 粒度は粗くなるが、日次損益・勝率・決済理由・時間帯の全体傾向を把握する目的には十分。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/backtest20d.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import {
  simulateStockReal,
  computeMarketEfficiency,
  isRangeBoundDay,
} from "../server/realSimulation";
import * as fs from "fs";
import * as path from "path";

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

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

interface RawBar { timestamp: number; jstDate: string; time: string; open: number; high: number; low: number; close: number; volume: number; }

async function fetch1moByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "5m", range: "1mo" } });
  const data = raw as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[]; volume: (number|null)[] }> } }> } };
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
  const sv = candles.map(c => { const r = (c.high - c.low) || 1; const clv = ((c.close - c.low) - (c.high - c.close)) / r; return clv * c.volume; });
  candles.forEach((c, i) => {
    if (i >= FLOW_LOOKBACK - 1) { let s = 0; for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += sv[k]; c.flow = s; }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) { const prev = candles[i - SLOPE_LOOKBACK].ma25; if (prev !== null && prev !== 0) c.slope = (c.ma25 - prev) / prev; }
  });
  return candles;
}

async function main() {
  console.log("[20d] Fetching 5m/1mo data for all symbols...");
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try { byTicker.set(s.symbol, await fetch1moByDay(s.ticker)); } catch (e) { console.warn(`  ${s.symbol} fetch failed:`, (e as Error).message); }
    await new Promise(r => setTimeout(r, 350));
  }
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();
  console.log(`[20d] Days found (${allDays.length}): ${allDays.join(", ")}`);

  const dailyRows: string[] = ["date,marketEfficiency,rangeBoundDay,totalProfit,winCount,lossCount,winRate"];
  const reasonAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const hourAgg = new Map<string, { profit: number; win: number; loss: number; count: number }>();
  const symbolAgg = new Map<string, { name: string; profit: number; win: number; loss: number; trades: number }>();
  const dailyProfits: number[] = [];

  let grandTotal = 0, grandWin = 0, grandLoss = 0, posDays = 0, negDays = 0;

  for (const day of allDays) {
    const candleMap = new Map<string, RealCandle[]>();
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 30) continue; // 5分足は1日約60〜75本。最低30本確保
      candleMap.set(s.symbol, toCandles(bars));
    }
    if (candleMap.size < 5) { console.log(`[20d] ${day}: too few symbols (${candleMap.size}), skip`); continue; }

    const symbols = Array.from(candleMap.keys());
    const ratioSeries = symbols.map(sym => { const cs = candleMap.get(sym)!; const open = cs[0]?.open ?? 0; return cs.map(c => (open > 0 ? (c.close - open) / open : 0)); });
    const marketBiasByProgress = (p: number): number => { let sum = 0, cnt = 0; for (const series of ratioSeries) { if (!series.length) continue; const idx = Math.min(series.length - 1, Math.max(0, Math.round(p * (series.length - 1)))); sum += series[idx]; cnt++; } return cnt > 0 ? sum / cnt : 0; };
    const dayStats = symbols.map(sym => { const cs = candleMap.get(sym)!; return { open: cs[0]?.open ?? 0, high: Math.max(...cs.map(c => c.high)), low: Math.min(...cs.map(c => c.low)), close: cs[cs.length - 1]?.close ?? 0 }; });
    const eff = computeMarketEfficiency(dayStats);
    const rangeBound = isRangeBoundDay(eff);

    let dayProfit = 0, dayWin = 0, dayLoss = 0;
    for (const s of TARGET_STOCKS) {
      const candles = candleMap.get(s.symbol); if (!candles) continue;
      const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, marketBiasByProgress, 3_000_000, 70, 30, 2.0, rangeBound);
      if (!res) continue;
      dayProfit += res.profitAmount; dayWin += res.winCount; dayLoss += res.lossCount;

      const agg = symbolAgg.get(s.symbol) ?? { name: s.name, profit: 0, win: 0, loss: 0, trades: 0 };
      agg.profit += res.profitAmount; agg.win += res.winCount; agg.loss += res.lossCount; agg.trades += res.tradesCount;
      symbolAgg.set(s.symbol, agg);

      let open: { time: string; price: number; shares: number; type: string } | null = null;
      for (const t of res.trades) {
        if (t.type === "buy" || t.type === "short") open = { time: t.time, price: t.price, shares: t.shares, type: t.type };
        else if ((t.type === "sell" || t.type === "cover") && open) {
          const profit = t.profit ?? 0;
          const sig = (res.signals ?? []).find(sg => sg.time === t.time && (sg.type === "sell" || sg.type === "cover"));
          const reasonKey = (sig?.reason ?? "").split("(")[0].trim() || "不明";
          const ra = reasonAgg.get(reasonKey) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          ra.profit += profit; ra.count++; if (profit > 0) ra.win++; else ra.loss++; reasonAgg.set(reasonKey, ra);
          const hour = open.time.split(":")[0] + ":00";
          const ha = hourAgg.get(hour) ?? { profit: 0, win: 0, loss: 0, count: 0 };
          ha.profit += profit; ha.count++; if (profit > 0) ha.win++; else ha.loss++; hourAgg.set(hour, ha);
          open = null;
        }
      }
    }
    const wr = (dayWin + dayLoss) > 0 ? dayWin / (dayWin + dayLoss) : 0;
    dailyRows.push([day, eff.toFixed(3), String(rangeBound), Math.round(dayProfit), dayWin, dayLoss, wr.toFixed(3)].join(","));
    dailyProfits.push(Math.round(dayProfit));
    grandTotal += dayProfit; grandWin += dayWin; grandLoss += dayLoss;
    if (dayProfit > 0) posDays++; else if (dayProfit < 0) negDays++;
    console.log(`[20d] ${day}: profit=${Math.round(dayProfit)} win=${dayWin} loss=${dayLoss} eff=${eff.toFixed(2)} range=${rangeBound}`);
  }

  const outDir = path.join(process.cwd(), "analysis", "out20d");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "daily.csv"), dailyRows.join("\n"), "utf8");

  const symRows = ["symbol,name,profit,win,loss,trades,winRate"];
  for (const [sym, a] of Array.from(symbolAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.trades > 0 ? a.win / a.trades : 0;
    symRows.push([sym, a.name, Math.round(a.profit), a.win, a.loss, a.trades, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_symbol.csv"), symRows.join("\n"), "utf8");

  const reasonRows = ["reason,profit,win,loss,count,winRate"];
  for (const [r, a] of Array.from(reasonAgg.entries()).sort((x, y) => x[1].profit - y[1].profit)) {
    const wr = a.count > 0 ? a.win / a.count : 0;
    reasonRows.push([`"${r}"`, Math.round(a.profit), a.win, a.loss, a.count, wr.toFixed(3)].join(","));
  }
  fs.writeFileSync(path.join(outDir, "by_reason.csv"), reasonRows.join("\n"), "utf8");

  const tradedDays = dailyProfits.length;
  const avg = tradedDays > 0 ? grandTotal / tradedDays : 0;
  const overallWr = (grandWin + grandLoss) > 0 ? grandWin / (grandWin + grandLoss) : 0;
  const best = Math.max(...dailyProfits), worst = Math.min(...dailyProfits);
  const daysOver15k = dailyProfits.filter(p => p >= 15000).length;

  console.log("\n===== 20-DAY SUMMARY (5m bars) =====");
  console.log(`Traded days: ${tradedDays}`);
  console.log(`Total profit: ${Math.round(grandTotal)} yen`);
  console.log(`Avg/day: ${Math.round(avg)} yen`);
  console.log(`Win/Loss trades: ${grandWin}/${grandLoss}  winRate: ${(overallWr*100).toFixed(1)}%`);
  console.log(`Positive days: ${posDays}, Negative days: ${negDays}`);
  console.log(`Best day: ${best}, Worst day: ${worst}`);
  console.log(`Days >= 15000 yen: ${daysOver15k}/${tradedDays}`);
  console.log("\nDaily:"); console.log(dailyRows.join("\n"));
  console.log("\nBy reason:"); console.log(reasonRows.join("\n"));
  console.log("\nBy symbol:"); console.log(symRows.join("\n"));
  console.log(`\n[20d] CSVs written to ${outDir}`);
}
main().catch(e => { console.error(e); process.exit(1); });
