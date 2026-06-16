/**
 * debug_sim_direct.ts
 * simulateStockRealに直接キャンドルを渡してデバッグ
 * fetchRealCandlesOnceと同じロジックでキャンドルを取得し、
 * simulateStockRealに渡して内部状態を追跡する
 */

import { ENV } from "./server/_core/env";
import { simulateStockReal } from "./server/realSimulation";

const JQUANTS_API_KEY = ENV.jquantsApiKey || process.env.JQUANTS_API_KEY || "";

const SLOPE_LOOKBACK = 25;
const FLOW_LOOKBACK = 10;

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
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) result[i] = 100;
    else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

function calcBollinger(data: number[], period = 20, mult = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    upper[i] = avg + mult * std;
    lower[i] = avg - mult * std;
  }
  return { upper, lower };
}

function calcVWAP(candles: any[]) {
  let cumPV = 0, cumVol = 0;
  return candles.map(c => {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumVol += c.volume;
    return cumVol > 0 ? cumPV / cumVol : null;
  });
}

async function fetchCandles(ticker: string, dateStr: string) {
  const symbol = ticker.replace(/\.T$/, "");
  const jqCode = `${symbol}0`;
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${dateStr}&to=${dateStr}`;
  const resp = await fetch(url, { headers: { "x-api-key": JQUANTS_API_KEY } });
  if (!resp.ok) return null;
  const json = await resp.json() as { data?: any[] };
  const bars = json.data ?? [];
  const candles = bars
    .filter((b: any) => {
      const [hh, mm] = b.Time.split(":").map(Number);
      const t = hh * 60 + mm;
      return t >= 9 * 60 && t <= 15 * 60 + 30;
    })
    .map((b: any) => ({
      time: b.Time,
      timestamp: new Date(`${b.Date}T${b.Time}:00+09:00`).getTime(),
      open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
      ma5: null as number | null, ma25: null as number | null,
      rsi: null as number | null, bbUpper: null as number | null,
      bbLower: null as number | null, flow: null as number | null,
      slope: null as number | null, vwap: null as number | null,
    }));
  if (candles.length < 30) return null;
  
  const closes = candles.map((c: any) => c.close);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  const vwap = calcVWAP(candles);
  const signedVol = candles.map((c: any) => {
    const range = (c.high - c.low) || 1;
    const clv = ((c.close - c.low) - (c.high - c.close)) / range;
    return clv * c.volume;
  });
  
  candles.forEach((c: any, i: number) => {
    c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i];
    c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i];
    c.vwap = vwap[i];
    if (i >= FLOW_LOOKBACK - 1) {
      let s = 0;
      for (let k = i - FLOW_LOOKBACK + 1; k <= i; k++) s += signedVol[k];
      c.flow = s;
    }
    if (i >= SLOPE_LOOKBACK && c.ma25 !== null) {
      const prevMa = candles[i - SLOPE_LOOKBACK].ma25;
      if (prevMa !== null && prevMa !== 0) c.slope = (c.ma25 - prevMa) / prevMa;
    }
  });
  
  return candles;
}

async function main() {
  const dateStr = "2026-06-11";
  console.log(`\n=== simulateStockReal 直接呼び出しデバッグ (${dateStr}) ===`);
  
  const candles = await fetchCandles("3436.T", dateStr);
  if (!candles) { console.log("データ取得失敗"); return; }
  
  console.log(`キャンドル数: ${candles.length}`);
  
  // 10:41付近のキャンドルを確認
  const bar1041 = candles.find((c: any) => c.time === "10:41");
  const bar1040 = candles.find((c: any) => c.time === "10:40");
  if (bar1041 && bar1040) {
    console.log(`\n10:40: ma5=${bar1040.ma5?.toFixed(1)}, ma25=${bar1040.ma25?.toFixed(1)}`);
    console.log(`10:41: ma5=${bar1041.ma5?.toFixed(1)}, ma25=${bar1041.ma25?.toFixed(1)}, rsi=${bar1041.rsi?.toFixed(1)}`);
    console.log(`GC条件: prev.ma5(${bar1040.ma5?.toFixed(1)}) <= prev.ma25(${bar1040.ma25?.toFixed(1)}) = ${bar1040.ma5! <= bar1040.ma25!}`);
    console.log(`GC条件: curr.ma5(${bar1041.ma5?.toFixed(1)}) > curr.ma25(${bar1041.ma25?.toFixed(1)}) = ${bar1041.ma5! > bar1041.ma25!}`);
  }
  
  // simulateStockRealを呼び出す（mktBias=0で固定）
  const result = simulateStockReal(
    "3436",
    "3436.T",
    "SUMCO",
    candles as any,
    () => 0,
    3_000_000,
    70, 30, 2.0,
    false,
    1.0,
    { shortStopLossPercent: 0.5, lunchExitAllMinute: "11:20" }
  );
  
  if (!result) { console.log("結果なし"); return; }
  
  console.log(`\n=== 結果 ===`);
  console.log(`取引件数: ${result.tradesCount}`);
  console.log(`損益: ${result.profitAmount >= 0 ? "+" : ""}${result.profitAmount.toLocaleString()}円`);
  
  if (result.trades.length > 0) {
    console.log("\n取引一覧:");
    for (const t of result.trades) {
      const p = t.profit !== undefined ? ` (${t.profit >= 0 ? "+" : ""}${t.profit?.toLocaleString()}円)` : "";
      console.log(`  ${t.time} ${t.type} ${t.price}円 x${t.shares}株${p}`);
    }
  } else {
    console.log("取引なし");
    
    // signals確認
    console.log(`signals: ${result.signals.length}件`);
    for (const s of result.signals) {
      console.log(`  ${s.time} ${s.type} ${s.price}円 - ${s.reason}`);
    }
  }
}

main().catch(console.error);
