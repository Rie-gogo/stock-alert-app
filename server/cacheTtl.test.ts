import { describe, it, expect } from 'vitest';
import { cacheTtlFor, jstMinutesOfDay } from './routers/stockData';

/**
 * cacheTtlFor は時間帯に応じてキャッシュ有効期間を返す純粋関数。
 * 寄り付き前後で古い足を引きずらないことが要点。
 * JST = UTC + 9h なので、JST h:m を UTC で作るには (h-9) 時を使う。
 */
function jst(hour: number, min: number): Date {
  // 平日（2026-06-03は水曜）を使用
  const utcHour = (hour - 9 + 24) % 24;
  return new Date(Date.UTC(2026, 5, 3, utcHour, min, 0));
}

describe('jstMinutesOfDay', () => {
  it('JST 9:00 は 540 分', () => {
    expect(jstMinutesOfDay(jst(9, 0))).toBe(540);
  });
  it('JST 15:30 は 930 分', () => {
    expect(jstMinutesOfDay(jst(15, 30))).toBe(930);
  });
});

describe('cacheTtlFor', () => {
  it('寄り付き前後(8:50)は10秒キャッシュ', () => {
    expect(cacheTtlFor(jst(8, 50))).toBe(10 * 1000);
  });

  it('寄り付き直後(9:00)は10秒キャッシュ（寄り付き帯を優先）', () => {
    expect(cacheTtlFor(jst(9, 0))).toBe(10 * 1000);
  });

  it('寄り付き帯の終わり(9:15)は10秒キャッシュ', () => {
    expect(cacheTtlFor(jst(9, 15))).toBe(10 * 1000);
  });

  it('場中(10:00)は60秒キャッシュ', () => {
    expect(cacheTtlFor(jst(10, 0))).toBe(60 * 1000);
  });

  it('場中(14:00)は60秒キャッシュ', () => {
    expect(cacheTtlFor(jst(14, 0))).toBe(60 * 1000);
  });

  it('引け(15:30)は60秒キャッシュ（市場時間内扱い）', () => {
    expect(cacheTtlFor(jst(15, 30))).toBe(60 * 1000);
  });

  it('市場時間外・早朝(7:00)は15分キャッシュ', () => {
    expect(cacheTtlFor(jst(7, 0))).toBe(15 * 60 * 1000);
  });

  it('市場時間外・夜間(20:00)は15分キャッシュ', () => {
    expect(cacheTtlFor(jst(20, 0))).toBe(15 * 60 * 1000);
  });

  it('寄り付き帯の直前(8:49)はまだ市場時間外=15分', () => {
    expect(cacheTtlFor(jst(8, 49))).toBe(15 * 60 * 1000);
  });

  it('寄り付き帯の直後(9:16)は場中=60秒', () => {
    expect(cacheTtlFor(jst(9, 16))).toBe(60 * 1000);
  });
});
