/**
 * debug_sim_trace.ts
 * realSimulation.tsのsimulateStockRealの内部条件を詳細追跡する
 * fetchRealCandlesOnceが返すキャンドルを使い、各足の条件を確認
 */

import { ENV } from "./server/_core/env";

const JQUANTS_API_KEY = ENV.jquantsApiKey || process.env.JQUANTS_API_KEY || "";

// realSimulation.tsと同じ定数
const SLOPE_THRESHOLD = 0.0003;
const SLOPE_LOOKBACK = 25;
const FLOW_LOOKBACK = 10;
const WARMUP_BARS = 10;
const MARKET_REGIME_THRESHOLD = 0.005;
const SUPPRESS_ENTRY_HOURS = new Set([12]);
const SUPPRESS_AFTERNOON_ENTRY = true;
const LUNCH_EXIT_ALL_MINUTE = "11:20";
const NO_ENTRY_AFTER = "14:30";

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result[i] = sum / period;
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
      time: b.Time, open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
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
  const signedVol = candles.map((c: any) => {
    const range = (c.high - c.low) || 1;
    const clv = ((c.close - c.low) - (c.high - c.close)) / range;
    return clv * c.volume;
  });
  
  candles.forEach((c: any, i: number) => {
    c.ma5 = ma5[i]; c.ma25 = ma25[i]; c.rsi = rsi[i];
    c.bbUpper = bb.upper[i]; c.bbLower = bb.lower[i];
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
  console.log(`\n=== SUMCO (3436) ${dateStr} 詳細シミュレーション追跡 ===`);
  
  const candles = await fetchCandles("3436.T", dateStr);
  if (!candles) { console.log("データ取得失敗"); return; }
  
  console.log(`総本数: ${candles.length}`);
  
  // 各足の条件を追跡
  let entryBlockedCount = 0;
  const blockReasons: Record<string, number> = {};
  
  console.log("\n=== エントリー条件追跡（9:30〜11:20の範囲） ===");
  
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    
    if (curr.time < "09:30" || curr.time > "11:20") continue;
    
    if (curr.rsi === null || curr.ma5 === null || curr.ma25 === null ||
        curr.bbLower === null || curr.bbUpper === null ||
        prev.ma5 === null || prev.ma25 === null) {
      blockReasons["null_indicators"] = (blockReasons["null_indicators"] ?? 0) + 1;
      continue;
    }
    
    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    const isRsiOversold = curr.rsi <= 30;
    const isBbLower = curr.close <= curr.bbLower;
    const slope = curr.slope ?? 0;
    const flow = curr.flow ?? 0;
    const inWarmup = i < WARMUP_BARS;
    const stockTrendUp = slope > SLOPE_THRESHOLD;
    const flowUp = flow > 0;
    const isHighVolDay = false;
    const entryHour = parseInt(curr.time.split(":")[0], 10);
    const suppressEntryByHour = SUPPRESS_ENTRY_HOURS.has(entryHour);
    const isAfternoonSession = curr.time >= "12:30";
    const suppressAfternoon = isAfternoonSession && SUPPRESS_AFTERNOON_ENTRY;
    const isStrongDown = curr.ma5 < curr.ma25 && curr.close < curr.ma5;
    
    // allowLong（evaluateRegimeGates相当）
    const allowLong = stockTrendUp && flowUp && !inWarmup && !isHighVolDay;
    const regimeAllowLong = allowLong;
    
    // shouldBuyLong
    const hasSignal = isGoldenCross || (isRsiOversold && isBbLower);
    const shouldBuyLong = regimeAllowLong && !isStrongDown && !suppressEntryByHour && !suppressAfternoon && hasSignal;
    
    if (hasSignal || isGoldenCross) {
      console.log(`\n${curr.time}: シグナル発生！`);
      console.log(`  close=${curr.close}, ma5=${curr.ma5?.toFixed(1)}, ma25=${curr.ma25?.toFixed(1)}, rsi=${curr.rsi?.toFixed(1)}`);
      console.log(`  slope=${slope.toFixed(6)}, flow=${flow.toFixed(0)}`);
      console.log(`  GC=${isGoldenCross}, RSI+BB=${isRsiOversold && isBbLower}`);
      console.log(`  allowLong=${allowLong} (stockTrendUp=${stockTrendUp}, flowUp=${flowUp}, inWarmup=${inWarmup})`);
      console.log(`  suppressHour=${suppressEntryByHour}, suppressAfternoon=${suppressAfternoon}, isStrongDown=${isStrongDown}`);
      console.log(`  shouldBuyLong=${shouldBuyLong}`);
    }
    
    if (!shouldBuyLong && hasSignal) {
      if (!allowLong) blockReasons["no_regime"] = (blockReasons["no_regime"] ?? 0) + 1;
      if (isStrongDown) blockReasons["strong_down"] = (blockReasons["strong_down"] ?? 0) + 1;
      if (suppressEntryByHour) blockReasons["suppress_hour"] = (blockReasons["suppress_hour"] ?? 0) + 1;
      if (suppressAfternoon) blockReasons["suppress_afternoon"] = (blockReasons["suppress_afternoon"] ?? 0) + 1;
    }
    
    if (!hasSignal) {
      entryBlockedCount++;
    }
  }
  
  console.log(`\n=== ブロック理由集計 ===`);
  console.log(`シグナルなし: ${entryBlockedCount}本`);
  for (const [reason, count] of Object.entries(blockReasons)) {
    console.log(`${reason}: ${count}本`);
  }
  
  // 9:30〜11:20の全足でのGCとRSI+BBの発生状況
  console.log("\n=== 9:30〜11:20のシグナル発生状況 ===");
  let gcCount = 0, rsiBbCount = 0, totalBars = 0;
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (curr.time < "09:30" || curr.time > "11:20") continue;
    if (curr.rsi === null || curr.ma5 === null || curr.ma25 === null ||
        curr.bbLower === null || prev.ma5 === null || prev.ma25 === null) continue;
    totalBars++;
    if (prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25) gcCount++;
    if (curr.rsi <= 30 && curr.close <= curr.bbLower) rsiBbCount++;
  }
  console.log(`対象本数: ${totalBars}`);
  console.log(`GC発生: ${gcCount}回`);
  console.log(`RSI+BB発生: ${rsiBbCount}回`);
  
  // 9:30〜11:20のMA5とMA25の関係
  console.log("\n=== 9:30〜11:20のMA5/MA25関係 ===");
  let ma5AboveMa25 = 0, ma5BelowMa25 = 0;
  for (let i = 0; i < candles.length; i++) {
    const curr = candles[i];
    if (curr.time < "09:30" || curr.time > "11:20") continue;
    if (curr.ma5 === null || curr.ma25 === null) continue;
    if (curr.ma5 > curr.ma25) ma5AboveMa25++;
    else ma5BelowMa25++;
  }
  console.log(`MA5>MA25: ${ma5AboveMa25}本 (上昇トレンド)`);
  console.log(`MA5<=MA25: ${ma5BelowMa25}本 (下落/横ばい)`);
  
  // GCが発生するためにはMA5<=MA25→MA5>MA25の転換が必要
  // 9:30時点のMA5/MA25の状態を確認
  const bar930 = candles.find((c: any) => c.time >= "09:30" && c.ma5 !== null && c.ma25 !== null);
  if (bar930) {
    console.log(`\n9:30時点: MA5=${bar930.ma5?.toFixed(1)}, MA25=${bar930.ma25?.toFixed(1)} → ${bar930.ma5! > bar930.ma25! ? "MA5>MA25(上昇)" : "MA5<=MA25(下落)"}`);
  }
}

main().catch(console.error);
