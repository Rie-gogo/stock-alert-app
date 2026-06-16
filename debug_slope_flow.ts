/**
 * debug_slope_flow.ts
 * 各銘柄のslope・flowの実際の値を確認してevaluateRegimeGatesのデバッグを行う
 */
import { evaluateRegimeGates, REGIME_CONSTANTS } from "./server/realSimulation";

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

const SLOPE_LOOKBACK = 25;
const FLOW_LOOKBACK = 10;

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result[i] = sum / period;
  }
  return result;
}

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
  if (candles.length < 30) return null;
  const closes = candles.map((c: any) => c.close);
  const ma25 = calcMA(closes, 25);
  const signedVol = candles.map((c: any) => {
    const r = (c.high - c.low) || 1;
    const clv = ((c.close - c.low) - (c.high - c.close)) / r;
    return clv * c.volume;
  });
  return candles.map((c: any, i: number) => ({
    ...c,
    ma25: ma25[i],
    slope: (i >= SLOPE_LOOKBACK && ma25[i] !== null && ma25[i - SLOPE_LOOKBACK] !== null)
      ? (ma25[i]! - ma25[i - SLOPE_LOOKBACK]!) / ma25[i - SLOPE_LOOKBACK]!
      : null,
    flow: i >= FLOW_LOOKBACK - 1
      ? signedVol.slice(i - FLOW_LOOKBACK + 1, i + 1).reduce((a: number, b: number) => a + b, 0)
      : null,
  }));
}

async function main() {
  const dateStr = "2026-06-11";
  console.log(`\n=== slope・flow デバッグ (${dateStr}) ===`);
  console.log(`SLOPE_THRESHOLD: ${REGIME_CONSTANTS.SLOPE_THRESHOLD}`);
  console.log(`SLOPE_LOOKBACK: ${SLOPE_LOOKBACK}`);
  console.log(`FLOW_LOOKBACK: ${FLOW_LOOKBACK}`);

  for (const stock of SIMULATION_STOCKS) {
    const candles = await fetchCandles(stock.ticker, dateStr);
    if (!candles) {
      console.log(`\n${stock.name}: データなし`);
      continue;
    }

    // slope・flowが有効な足のみ抽出
    const validBars = candles.filter((c: any) => c.slope !== null && c.flow !== null);
    if (validBars.length === 0) {
      console.log(`\n${stock.name}: slope/flow計算不可`);
      continue;
    }

    // slope・flowの統計
    const slopes = validBars.map((c: any) => c.slope as number);
    const flows = validBars.map((c: any) => c.flow as number);
    const maxSlope = Math.max(...slopes);
    const minSlope = Math.min(...slopes);
    const maxFlow = Math.max(...flows);
    const minFlow = Math.min(...flows);
    const posSlope = slopes.filter(s => s > REGIME_CONSTANTS.SLOPE_THRESHOLD).length;
    const negSlope = slopes.filter(s => s < -REGIME_CONSTANTS.SLOPE_THRESHOLD).length;
    const posFlow = flows.filter(f => f > 0).length;
    const negFlow = flows.filter(f => f < 0).length;

    // allowLong・allowShortがtrueになった足の数
    let allowLongCount = 0;
    let allowShortCount = 0;
    for (const c of validBars) {
      const { allowLong, allowShort } = evaluateRegimeGates({
        slope: c.slope as number,
        flow: c.flow as number,
        mktBias: 0,
        inWarmup: false,
        halted: false,
        isHighVolDay: false,
      });
      if (allowLong) allowLongCount++;
      if (allowShort) allowShortCount++;
    }

    console.log(`\n${stock.name} (${stock.symbol}):`);
    console.log(`  slope: min=${minSlope.toFixed(6)}, max=${maxSlope.toFixed(6)}`);
    console.log(`  flow:  min=${minFlow.toFixed(0)}, max=${maxFlow.toFixed(0)}`);
    console.log(`  slopeUp(>${REGIME_CONSTANTS.SLOPE_THRESHOLD}): ${posSlope}/${validBars.length}本`);
    console.log(`  slopeDown(<-${REGIME_CONSTANTS.SLOPE_THRESHOLD}): ${negSlope}/${validBars.length}本`);
    console.log(`  flowUp(>0): ${posFlow}/${validBars.length}本`);
    console.log(`  flowDown(<0): ${negFlow}/${validBars.length}本`);
    console.log(`  allowLong: ${allowLongCount}/${validBars.length}本`);
    console.log(`  allowShort: ${allowShortCount}/${validBars.length}本`);

    // 最初にallowLongがtrueになった足
    const firstLong = validBars.find((c: any) => {
      const { allowLong } = evaluateRegimeGates({
        slope: c.slope as number, flow: c.flow as number,
        mktBias: 0, inWarmup: false, halted: false, isHighVolDay: false,
      });
      return allowLong;
    });
    if (firstLong) {
      console.log(`  最初のallowLong: ${firstLong.time} (slope=${(firstLong.slope as number).toFixed(6)}, flow=${(firstLong.flow as number).toFixed(0)})`);
    } else {
      console.log(`  allowLong: 一度もtrueにならず`);
    }
  }
}

main().catch(console.error);
