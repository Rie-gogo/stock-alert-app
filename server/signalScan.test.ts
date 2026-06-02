import { describe, it, expect } from 'vitest';
import { extractLatestSignal, type CandleWithSignal } from './routers/stockData';

/**
 * シグナル監視ボード（getSignalScan）が使う最新シグナル抽出ロジックの検証。
 * extractLatestSignal は「直近 lookback 本のローソク足」から最新のシグナルを拾う純粋関数。
 */

function makeCandle(
  time: string,
  signal?: { type: 'buy' | 'sell' | 'warn'; reason: string }
): CandleWithSignal {
  return {
    time,
    timestamp: 0,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    ma5: null,
    ma25: null,
    rsi: null,
    bbUpper: null,
    bbLower: null,
    signal,
  } as CandleWithSignal;
}

describe('extractLatestSignal', () => {
  it('空配列なら null を返す', () => {
    const res = extractLatestSignal([], 2);
    expect(res.signal).toBeNull();
    expect(res.time).toBeNull();
  });

  it('シグナルが無い場合は null を返す', () => {
    const candles = [makeCandle('09:00'), makeCandle('09:01'), makeCandle('09:02')];
    const res = extractLatestSignal(candles, 2);
    expect(res.signal).toBeNull();
  });

  it('最新足の買いシグナルを拾う', () => {
    const candles = [
      makeCandle('09:00'),
      makeCandle('09:01'),
      makeCandle('09:02', { type: 'buy', reason: 'ゴールデンクロス' }),
    ];
    const res = extractLatestSignal(candles, 2);
    expect(res.signal?.type).toBe('buy');
    expect(res.time).toBe('09:02');
  });

  it('最新足の売りシグナルを拾う', () => {
    const candles = [
      makeCandle('09:00'),
      makeCandle('09:02', { type: 'sell', reason: 'デッドクロス' }),
    ];
    const res = extractLatestSignal(candles, 2);
    expect(res.signal?.type).toBe('sell');
    expect(res.time).toBe('09:02');
  });

  it('lookback の範囲外（古い）シグナルは拾わない', () => {
    // 直近2本にはシグナルが無く、3本前にだけ buy がある → 拾わない
    const candles = [
      makeCandle('09:00', { type: 'buy', reason: '古いシグナル' }),
      makeCandle('09:01'),
      makeCandle('09:02'),
    ];
    const res = extractLatestSignal(candles, 2);
    expect(res.signal).toBeNull();
  });

  it('lookback 範囲内に複数あるときは、より新しい足のシグナルを優先する', () => {
    const candles = [
      makeCandle('09:00'),
      makeCandle('09:01', { type: 'buy', reason: '1本前の買い' }),
      makeCandle('09:02', { type: 'sell', reason: '最新の売り' }),
    ];
    const res = extractLatestSignal(candles, 2);
    expect(res.signal?.type).toBe('sell');
    expect(res.time).toBe('09:02');
  });

  it('lookback を広げれば古いシグナルも拾える', () => {
    const candles = [
      makeCandle('09:00', { type: 'buy', reason: '古い買い' }),
      makeCandle('09:01'),
      makeCandle('09:02'),
    ];
    const res = extractLatestSignal(candles, 5);
    expect(res.signal?.type).toBe('buy');
    expect(res.time).toBe('09:00');
  });
});
