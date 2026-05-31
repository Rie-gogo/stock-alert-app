import { CandleData } from '../types';

/**
 * 5日・25日移動平均線（MA）の計算
 */
export function calculateMA(candles: CandleData[], period: number): number | undefined {
  if (candles.length < period) return undefined;
  const targetCandles = candles.slice(-period);
  const sum = targetCandles.reduce((acc, c) => sumClose(acc, c.close), 0);
  return Number((sum / period).toFixed(2));
}

function sumClose(acc: number, val: number | undefined): number {
  return acc + (val ?? 0);
}

/**
 * RSI（相対力指数）の計算
 * RSI = 100 - (100 / (1 + RS))
 * RS = (n日間の値上がり幅の平均) / (n日間の値下がり幅の平均)
 */
export function calculateRSI(candles: CandleData[], period: number = 14): number | undefined {
  if (candles.length < period + 1) return undefined;

  let gains = 0;
  let losses = 0;

  // 直近 period 個の差分を計算
  for (let i = candles.length - period; i < candles.length; i++) {
    const prevClose = candles[i - 1].close;
    const currClose = candles[i].close;
    const diff = currClose - prevClose;

    if (diff > 0) {
      gains += diff;
    } else {
      losses += Math.abs(diff);
    }
  }

  if (gains + losses === 0) return 50; // 変化なし

  const rsi = (gains / (gains + losses)) * 100;
  return Number(rsi.toFixed(2));
}

/**
 * ボリンジャーバンドの計算 (±2σ)
 */
export function calculateBollingerBands(
  candles: CandleData[],
  period: number = 20,
  multiplier: number = 2
): { upper: number; middle: number; lower: number } | undefined {
  if (candles.length < period) return undefined;

  const targetCandles = candles.slice(-period);
  const closes = targetCandles.map((c) => c.close);
  
  // 平均値 (ミドルバンド)
  const mean = closes.reduce((acc, val) => acc + val, 0) / period;

  // 分散と標準偏差 (σ)
  const variance = closes.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = mean + multiplier * stdDev;
  const lower = mean - multiplier * stdDev;

  return {
    upper: Number(upper.toFixed(2)),
    middle: Number(mean.toFixed(2)),
    lower: Number(lower.toFixed(2)),
  };
}

/**
 * 全テクニカル指標を一括計算して更新した配列を返す
 */
export function enrichCandlesWithTechnicals(candles: CandleData[]): CandleData[] {
  return candles.map((candle, idx) => {
    const subset = candles.slice(0, idx + 1);
    
    const ma5 = calculateMA(subset, 5);
    const ma25 = calculateMA(subset, 25);
    const rsi = calculateRSI(subset, 14);
    const bb = calculateBollingerBands(subset, 20, 2);

    return {
      ...candle,
      ma5,
      ma25,
      rsi,
      bbUpper: bb?.upper,
      bbMiddle: bb?.middle,
      bbLower: bb?.lower,
    };
  });
}
