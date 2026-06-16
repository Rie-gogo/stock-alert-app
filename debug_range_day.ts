/**
 * debug_range_day.ts
 * 6/11・6/12のレンジ相場判定（skipTradingRangeDay）の値を確認する
 */
import { computeMarketEfficiency, isRangeBoundDay, REGIME_CONSTANTS } from "./server/realSimulation";

const JQUANTS_API_KEY = process.env.JQUANTS_API_KEY ?? "";

const SIMULATION_STOCKS = [
  { symbol: "3436", ticker: "3436.T", name: "SUMCO" },
  { symbol: "3778", ticker: "3778.T", name: "さくら" },
  { symbol: "6981", ticker: "6981.T", name: "村田" },
  { symbol: "6758", ticker: "6758.T", name: "ソニー" },
  { symbol: "8306", ticker: "8306.T", name: "三菱UFJ" },
  { symbol: "8035", ticker: "8035.T", name: "東エレ" },
  { symbol: "6857", ticker: "6857.T", name: "アドバンテスト" },
  { symbol: "6920", ticker: "6920.T", name: "レーザーテック" },
  { symbol: "7011", ticker: "7011.T", name: "三菱重工" },
  { symbol: "9984", ticker: "9984.T", name: "SBG" },
];

async function fetchCandles(ticker: string, dateStr: string) {
  const symbol = ticker.replace(".T", "");
  const jqCode = `${symbol}0`;
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${dateStr}&to=${dateStr}`;
  const resp = await fetch(url, { headers: { "x-api-key": JQUANTS_API_KEY } });
  if (!resp.ok) return null;
  const data = await resp.json() as { data?: any[] };
  const bars = data.data ?? [];
  const candles = bars
    .filter((b: any) => {
      const [hh, mm] = b.Time.split(":").map(Number);
      const t = hh * 60 + mm;
      return t >= 9 * 60 && t <= 15 * 60 + 30;
    })
    .map((b: any) => ({
      time: b.Time,
      open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    }));
  return candles.length >= 30 ? candles : null;
}

async function analyzeDay(dateStr: string) {
  console.log(`\n=== ${dateStr} レンジ相場判定デバッグ ===`);
  
  const candleMap = new Map<string, any[]>();
  for (const stock of SIMULATION_STOCKS) {
    const candles = await fetchCandles(stock.ticker, dateStr);
    if (candles) candleMap.set(stock.symbol, candles);
    await new Promise(r => setTimeout(r, 300));
  }

  const symbols = Array.from(candleMap.keys());
  const dayStats = symbols.map(sym => {
    const cs = candleMap.get(sym)!;
    const open = cs[0]?.open ?? 0;
    const close = cs[cs.length - 1]?.close ?? 0;
    const high = Math.max(...cs.map((c: any) => c.high));
    const low = Math.min(...cs.map((c: any) => c.low));
    const range = open > 0 ? (high - low) / open : 0;
    const netChange = open > 0 ? Math.abs(close - open) / open : 0;
    const efficiency = range > 0 ? netChange / range : 0;
    console.log(`  ${sym}: range=${(range*100).toFixed(2)}%, netChange=${(netChange*100).toFixed(2)}%, efficiency=${efficiency.toFixed(3)}`);
    return { open, high, low, close };
  });

  const marketEfficiency = computeMarketEfficiency(dayStats);
  const rangeBound = isRangeBoundDay(marketEfficiency);
  
  console.log(`\n  市場効率: ${marketEfficiency.toFixed(3)} (閾値: ${REGIME_CONSTANTS.RANGE_EFFICIENCY_THRESHOLD})`);
  console.log(`  レンジ相場判定: ${rangeBound ? "⚠️ YES → 全銘柄エントリー禁止！" : "✅ NO → 通常取引"}`);
  
  return { marketEfficiency, rangeBound };
}

async function main() {
  for (const dateStr of ["2026-06-11", "2026-06-12"]) {
    await analyzeDay(dateStr);
  }
}

main().catch(console.error);
