/**
 * findDownDays.ts
 * 主要銘柄の日足を取得し、過去の「下落日（前日終値比マイナス、特に急落日）」を特定する。
 * あわせて、5分足(range=1mo)・15分足(range=1mo)で過去のどこまで日中データが取れるかを確認する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/findDownDays.ts
 */
import { callDataApi } from "../server/_core/dataApi";

interface DailyBar { date: string; close: number; chgPct: number | null; }

async function fetchDaily(ticker: string, range: string): Promise<DailyBar[]> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", {
    query: { symbol: ticker, region: "JP", interval: "1d", range },
  });
  const data = raw as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ close: (number | null)[] }> } }> } };
  const result = data?.chart?.result?.[0];
  if (!result) return [];
  const ts = result.timestamp ?? [];
  const close = result.indicators.quote[0].close;
  const bars: DailyBar[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = close[i];
    if (c == null) continue;
    const jst = new Date(ts[i] * 1000 + 9 * 3600 * 1000);
    const date = `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`;
    bars.push({ date, close: c, chgPct: null });
  }
  for (let i = 1; i < bars.length; i++) {
    bars[i].chgPct = ((bars[i].close - bars[i - 1].close) / bars[i - 1].close) * 100;
  }
  return bars;
}

async function probeIntraday(ticker: string, interval: string, range: string): Promise<{ firstDate: string; lastDate: string; days: number } | null> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", {
    query: { symbol: ticker, region: "JP", interval, range },
  });
  const data = raw as { chart?: { result?: Array<{ timestamp: number[] }> } };
  const ts = data?.chart?.result?.[0]?.timestamp ?? [];
  if (!ts.length) return null;
  const dates = new Set<string>();
  for (const t of ts) {
    const jst = new Date(t * 1000 + 9 * 3600 * 1000);
    dates.add(`${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(jst.getUTCDate()).padStart(2, "0")}`);
  }
  const sorted = Array.from(dates).sort();
  return { firstDate: sorted[0], lastDate: sorted[sorted.length - 1], days: sorted.length };
}

async function main() {
  const ticker = "7203.T"; // トヨタ（市場全体の代理）
  console.log("=== 日足から下落日を特定（直近3ヶ月） ===");
  const daily = await fetchDaily(ticker, "3mo");
  const downDays = daily.filter(b => b.chgPct !== null && b.chgPct < -1.0).sort((a, b) => (a.chgPct! - b.chgPct!));
  console.log(`総営業日: ${daily.length}, うち前日比-1%以上の下落日: ${downDays.length}`);
  console.log("急落日トップ10（前日比%）:");
  for (const d of downDays.slice(0, 10)) console.log(`  ${d.date}\t${d.chgPct!.toFixed(2)}%\tclose=${d.close}`);

  console.log("\n=== 日中足の取得可能範囲 ===");
  for (const [iv, rg] of [["5m", "1mo"], ["15m", "1mo"], ["15m", "3mo"], ["30m", "3mo"], ["1h", "3mo"]] as const) {
    const p = await probeIntraday(ticker, iv, rg);
    await new Promise(r => setTimeout(r, 300));
    if (p) console.log(`  interval=${iv} range=${rg}: ${p.days}日分 (${p.firstDate} 〜 ${p.lastDate})`);
    else console.log(`  interval=${iv} range=${rg}: データなし`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
