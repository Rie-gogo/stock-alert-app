/**
 * intradayDownDays.ts
 * 5分足(range=1mo, 約20営業日)を使い、各営業日の「日中(寄り→引け)の全銘柄平均騰落(bias%)」を計算。
 * bias% が負の日 = 日中ずっと下げた『本物の下落相場日』を特定する。
 * あわせて各日の市場効率(トレンド性)も出し、空売りが機能しうる相場だったかを評価する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/intradayDownDays.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import { computeMarketEfficiency } from "../server/realSimulation";

interface RawBar { timestamp: number; jstDate: string; open: number; high: number; low: number; close: number; }

async function fetch1moByDay(ticker: string): Promise<Map<string, RawBar[]>> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "5m", range: "1mo" } });
  const data = raw as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open: (number|null)[]; high: (number|null)[]; low: (number|null)[]; close: (number|null)[] }> } }> } };
  const byDay = new Map<string, RawBar[]>();
  const result = data?.chart?.result?.[0];
  if (!result) return byDay;
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  for (let i = 0; i < ts.length; i++) {
    const o = q.open[i], h = q.high[i], l = q.low[i], c = q.close[i];
    if (o == null || c == null) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    const jstDate = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    const arr = byDay.get(jstDate) ?? [];
    arr.push({ timestamp: ts[i] * 1000, jstDate, open: o, high: h ?? o, low: l ?? o, close: c });
    byDay.set(jstDate, arr);
  }
  return byDay;
}

async function main() {
  console.log("[intraday] Fetching 1mo 5m data for all symbols...");
  const byTicker = new Map<string, Map<string, RawBar[]>>();
  for (const s of TARGET_STOCKS) {
    try { byTicker.set(s.symbol, await fetch1moByDay(s.ticker)); } catch (e) { console.warn(`  ${s.symbol} fail`, (e as Error).message); }
    await new Promise(r => setTimeout(r, 300));
  }
  const dayCount = new Map<string, number>();
  for (const byDay of byTicker.values()) for (const d of byDay.keys()) dayCount.set(d, (dayCount.get(d) ?? 0) + 1);
  const allDays = Array.from(dayCount.keys()).sort();

  const rows: { day: string; bias: number; eff: number; downStocks: number; total: number }[] = [];
  for (const day of allDays) {
    const stats: { open: number; high: number; low: number; close: number }[] = [];
    let biasSum = 0, cnt = 0, downStocks = 0;
    for (const s of TARGET_STOCKS) {
      const bars = byTicker.get(s.symbol)?.get(day);
      if (!bars || bars.length < 20) continue;
      const open = bars[0].open, close = bars[bars.length - 1].close;
      const high = Math.max(...bars.map(b => b.high)), low = Math.min(...bars.map(b => b.low));
      stats.push({ open, high, low, close });
      const chg = open > 0 ? (close - open) / open : 0;
      biasSum += chg; cnt++;
      if (chg < 0) downStocks++;
    }
    if (cnt < 5) continue;
    const eff = computeMarketEfficiency(stats);
    rows.push({ day, bias: (biasSum / cnt) * 100, eff, downStocks, total: cnt });
  }

  console.log("\n===== 20営業日: 日中(寄り→引け)の地合い =====");
  console.log("day\tbias%\teff\t下落銘柄/全体");
  for (const r of rows) {
    const mark = r.bias < 0 ? "  ← 下落日" : "";
    console.log(`${r.day}\t${r.bias.toFixed(2)}\t${r.eff.toFixed(2)}\t${r.downStocks}/${r.total}${mark}`);
  }
  const downDays = rows.filter(r => r.bias < 0);
  console.log(`\n下落日(bias%<0): ${downDays.length}日 / 全${rows.length}日`);
  if (downDays.length) {
    console.log("下落日の詳細:");
    for (const r of downDays.sort((a, b) => a.bias - b.bias)) console.log(`  ${r.day}\tbias=${r.bias.toFixed(2)}%\teff=${r.eff.toFixed(2)}\t下落${r.downStocks}/${r.total}銘柄`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
