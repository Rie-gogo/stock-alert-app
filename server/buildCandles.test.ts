import { describe, it, expect } from "vitest";
import { buildCandlesFromQuotes } from "./routers/stockData";

// JST 9:00 = UTC 0:00。timestamp は秒単位。
const T9 = Math.floor(Date.UTC(2026, 5, 3, 0, 0, 0) / 1000);
const min = (n: number) => T9 + n * 60;

describe("buildCandlesFromQuotes", () => {
  it("通常データから全ローソク足を構築する", () => {
    const ts = [min(0), min(1), min(2)];
    const candles = buildCandlesFromQuotes(ts, {
      open: [100, 101, 102],
      high: [103, 104, 105],
      low: [99, 100, 101],
      close: [101, 102, 103],
      volume: [1000, 1100, 1200],
    });
    expect(candles).toHaveLength(3);
    expect(candles[0].close).toBe(101);
    expect(candles[0].time).toBe("09:00");
  });

  it("close が null の足を open と前足終値で補完して残す（寄り付き直後）", () => {
    const ts = [min(0), min(1), min(2)];
    const candles = buildCandlesFromQuotes(ts, {
      open: [100, 101, null],
      high: [103, null, null],
      low: [99, null, null],
      close: [101, null, null],
      volume: [1000, null, null],
    });
    // 1本目: 正常 / 2本目: open=101でclose補完 / 3本目: open/closeともnull→スキップ
    expect(candles).toHaveLength(2);
    expect(candles[1].close).toBe(101); // openで補完
    expect(candles[1].open).toBe(101);
  });

  it("open も close も両方 null の足はスキップする", () => {
    const ts = [min(0), min(1)];
    const candles = buildCandlesFromQuotes(ts, {
      open: [null, 100],
      high: [null, 102],
      low: [null, 99],
      close: [null, 101],
      volume: [null, 500],
    });
    expect(candles).toHaveLength(1);
    expect(candles[0].close).toBe(101);
  });

  it("close だけある足は close を open にも使う", () => {
    const ts = [min(0)];
    const candles = buildCandlesFromQuotes(ts, {
      open: [null],
      high: [null],
      low: [null],
      close: [120],
      volume: [300],
    });
    expect(candles).toHaveLength(1);
    expect(candles[0].open).toBe(120);
    expect(candles[0].close).toBe(120);
    expect(candles[0].high).toBe(120);
    expect(candles[0].low).toBe(120);
  });

  it("high/low が欠けていても open/close から補完する", () => {
    const ts = [min(0)];
    const candles = buildCandlesFromQuotes(ts, {
      open: [100],
      high: [null],
      low: [null],
      close: [110],
      volume: [400],
    });
    expect(candles[0].high).toBe(110);
    expect(candles[0].low).toBe(100);
  });

  it("空配列は空を返す（エラーにしない）", () => {
    const candles = buildCandlesFromQuotes([], {
      open: [],
      high: [],
      low: [],
      close: [],
      volume: [],
    });
    expect(candles).toHaveLength(0);
  });
});
