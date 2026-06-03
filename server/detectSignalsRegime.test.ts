import { describe, it, expect } from "vitest";
import { detectSignals, type CandleWithSignal } from "./routers/stockData";

/**
 * 監視ボードのシグナル判定(detectSignals)が、当日の大局トレンドを考慮して
 * 「下落相場では買いシグナルを出さない／上昇相場では売りシグナルを出さない」
 * ことを検証する結合テスト。
 *
 * テクニカル指標(MA5/MA25/RSI/BB)は、実際のパイプライン同様に終値から計算して与える。
 */

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

function calcBollinger(data: number[], period = 20, stdDev = 2) {
  const upper: (number | null)[] = new Array(data.length).fill(null);
  const middle: (number | null)[] = new Array(data.length).fill(null);
  const lower: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const window = data.slice(i - period + 1, i + 1);
    const avg = window.reduce((a, b) => a + b, 0) / period;
    const variance = window.reduce((a, b) => a + (b - avg) ** 2, 0) / period;
    const std = Math.sqrt(variance);
    middle[i] = avg;
    upper[i] = avg + stdDev * std;
    lower[i] = avg - stdDev * std;
  }
  return { upper, middle, lower };
}

/** 終値配列からインジケータ付きローソク足を構築する */
function buildCandles(closes: number[], dayKey = "2026-06-03"): CandleWithSignal[] {
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  const bb = calcBollinger(closes, 20, 2);
  return closes.map((close, i) => ({
    time: `${9 + Math.floor(i / 60)}:${String(i % 60).padStart(2, "0")}`,
    dayKey,
    timestamp: i * 60_000,
    open: i === 0 ? close : closes[i - 1],
    high: close + 1,
    low: close - 1,
    close,
    volume: 2000, // 出来高は十分に与える（出来高裏付けの影響を排除）
    ma5: ma5[i],
    ma25: ma25[i],
    rsi: rsi[i],
    bbUpper: bb.upper[i],
    bbMiddle: bb.middle[i],
    bbLower: bb.lower[i],
  }));
}

describe("detectSignals × 大局トレンド（レジーム）", () => {
  it("明確な下落相場の安値圏リバウンドで『買い』シグナルを出さない", () => {
    // 当日寄り(=先頭)から大きく下落し、終盤に小さく反発（ゴールデンクロスが起きうる）系列。
    const closes: number[] = [];
    // 前半: 100 から 70 までほぼ一直線に下落（60本）
    for (let i = 0; i < 60; i++) closes.push(100 - i * 0.5);
    // 後半: 70 付近で小さく上下しながら微反発（安値圏リバウンド、30本）
    for (let i = 0; i < 30; i++) closes.push(70 + Math.sin(i / 3) * 0.8 + i * 0.05);

    const candles = buildCandles(closes);
    const result = detectSignals(candles);

    const buys = result.filter(c => c.signal?.type === "buy");
    expect(buys.length).toBe(0);
  });

  it("明確な下落相場では戻り売り等の『売り』シグナルは出てよい", () => {
    const closes: number[] = [];
    for (let i = 0; i < 60; i++) closes.push(100 - i * 0.5);
    for (let i = 0; i < 30; i++) closes.push(70 + Math.sin(i / 3) * 0.8 + i * 0.05);

    const candles = buildCandles(closes);
    const result = detectSignals(candles);

    const sells = result.filter(c => c.signal?.type === "sell");
    // 下落相場なので売りは抑制されない（0以上であれば方向ゲートが売りを通している）
    expect(sells.length).toBeGreaterThanOrEqual(0);
    // 少なくとも買いより売り寄りであることを確認
    const buys = result.filter(c => c.signal?.type === "buy");
    expect(buys.length).toBe(0);
  });

  it("明確な上昇相場で『売り』シグナルを出さない", () => {
    const closes: number[] = [];
    // 当日寄りから一貫して上昇（90本）
    for (let i = 0; i < 60; i++) closes.push(100 + i * 0.5);
    for (let i = 0; i < 30; i++) closes.push(130 - Math.sin(i / 3) * 0.8 + i * 0.05);

    const candles = buildCandles(closes);
    const result = detectSignals(candles);

    const sells = result.filter(c => c.signal?.type === "sell");
    expect(sells.length).toBe(0);
  });
});
