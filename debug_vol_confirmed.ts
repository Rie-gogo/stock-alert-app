/**
 * debug_vol_confirmed.ts
 * 10:41のGCシグナル時のvolConfirmedを確認する
 */

import { ENV } from "./server/_core/env";
import { isVolumeConfirmed, trailingAvgVolume, VOLUME_SURGE_MULT } from "./server/signalConfirmation";

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
  console.log(`\n=== SUMCO volConfirmed デバッグ (${dateStr}) ===`);
  console.log(`VOLUME_SURGE_MULT: ${VOLUME_SURGE_MULT}`);
  
  const candles = await fetchCandles("3436.T", dateStr);
  if (!candles) { console.log("データ取得失敗"); return; }
  
  const volumes = candles.map((c: any) => c.volume);
  
  // 10:41のGCシグナル時の出来高確認
  const idx1041 = candles.findIndex((c: any) => c.time === "10:41");
  if (idx1041 >= 0) {
    const c1041 = candles[idx1041];
    const avgVol = trailingAvgVolume(volumes, idx1041, 10);
    const volConf = isVolumeConfirmed(c1041.volume, avgVol);
    console.log(`\n10:41 GCシグナル時:`);
    console.log(`  出来高: ${c1041.volume.toLocaleString()}`);
    console.log(`  直近10本平均: ${avgVol?.toLocaleString() ?? "null"}`);
    console.log(`  必要出来高(1.2倍): ${avgVol ? (avgVol * VOLUME_SURGE_MULT).toLocaleString() : "null"}`);
    console.log(`  volConfirmed: ${volConf}`);
  }
  
  // 11:04のGCシグナル時の出来高確認
  const idx1104 = candles.findIndex((c: any) => c.time === "11:04");
  if (idx1104 >= 0) {
    const c1104 = candles[idx1104];
    const avgVol = trailingAvgVolume(volumes, idx1104, 10);
    const volConf = isVolumeConfirmed(c1104.volume, avgVol);
    console.log(`\n11:04 GCシグナル時:`);
    console.log(`  出来高: ${c1104.volume.toLocaleString()}`);
    console.log(`  直近10本平均: ${avgVol?.toLocaleString() ?? "null"}`);
    console.log(`  必要出来高(1.2倍): ${avgVol ? (avgVol * VOLUME_SURGE_MULT).toLocaleString() : "null"}`);
    console.log(`  volConfirmed: ${volConf}`);
  }
  
  // 全シグナル発生時のvolConfirmedを確認
  console.log("\n=== 全GCシグナル時のvolConfirmed ===");
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    if (curr.ma5 === null || curr.ma25 === null || prev.ma5 === null || prev.ma25 === null) continue;
    const isGC = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    if (!isGC) continue;
    
    const avgVol = trailingAvgVolume(volumes, i, 10);
    const volConf = isVolumeConfirmed(curr.volume, avgVol);
    console.log(`${curr.time}: GC! vol=${curr.volume.toLocaleString()}, avg=${avgVol?.toLocaleString() ?? "null"}, volConf=${volConf}`);
  }
  
  // 全RSI+BBシグナル時のvolConfirmedを確認
  console.log("\n=== 全RSI+BBシグナル時のvolConfirmed ===");
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    if (curr.rsi === null || curr.bbLower === null) continue;
    const isRsiBb = curr.rsi <= 30 && curr.close <= curr.bbLower;
    if (!isRsiBb) continue;
    
    const avgVol = trailingAvgVolume(volumes, i, 10);
    const volConf = isVolumeConfirmed(curr.volume, avgVol);
    console.log(`${curr.time}: RSI+BB! vol=${curr.volume.toLocaleString()}, avg=${avgVol?.toLocaleString() ?? "null"}, volConf=${volConf}`);
  }
}

main().catch(console.error);
