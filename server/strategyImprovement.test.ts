import { describe, it, expect } from "vitest";
import {
  simulateStockReal,
  REGIME_CONSTANTS,
} from "./realSimulation";

/**
 * 戦略改善（押し目買い・損切りタイト化→2.0%最適化・トレイリング利確・建値ストップ・
 * デッドクロス即決済の廃止）の回帰テスト。
 *
 * simulateStockReal は RealCandle 配列を受け取り、指標は呼び出し側で計算済みである前提。
 * ここでは合成データで「トレイリング利確が損切りより先に利益を確定する」ことなどを検証する。
 */

interface RealCandle {
  time: string; timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null;
}

/** ローソク足を簡易生成するヘルパー */
function mkCandle(i: number, close: number, opts: Partial<RealCandle> = {}): RealCandle {
  return {
    time: `${String(9 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
    timestamp: 1_700_000_000_000 + i * 60_000,
    open: close, high: close, low: close, close, volume: 100_000,
    ma5: close, ma25: close, rsi: 50, bbUpper: close * 1.02, bbLower: close * 0.98,
    flow: 1000, slope: 0.001,
    ...opts,
  };
}

describe("新しい戦略定数の妥当性", () => {
  it("トレイリング発動(+1%) > 建値発動(+0.5%) の順序になっている", () => {
    expect(REGIME_CONSTANTS.TRAIL_TRIGGER).toBeGreaterThan(REGIME_CONSTANTS.BREAKEVEN_TRIGGER);
  });
  it("トレイリング幅は発動条件より小さい（利を残せる）", () => {
    expect(REGIME_CONSTANTS.TRAIL_GAP).toBeLessThanOrEqual(REGIME_CONSTANTS.TRAIL_TRIGGER);
  });
  it("押し目買いRSI閾値は中立(50)未満（押した場面で拾う）", () => {
    expect(REGIME_CONSTANTS.PULLBACK_RSI).toBeLessThan(50);
  });
  it("最大取引回数は機会を増やす方向（>=4）", () => {
    expect(REGIME_CONSTANTS.MAX_TRADES_PER_DAY).toBeGreaterThanOrEqual(4);
  });
  it("ウォームアップは短縮（<=10）で機会を増やす", () => {
    expect(REGIME_CONSTANTS.WARMUP_BARS).toBeLessThanOrEqual(10);
  });
});

describe("トレイリング利確（利を伸ばし、ピークから落ちたら確定）", () => {
  it("上昇後にピークから下落するとトレイリング利確で利益を確定する", () => {
    const candles: RealCandle[] = [];
    // ウォームアップ確保のため序盤は横ばい
    for (let i = 0; i < 12; i++) candles.push(mkCandle(i, 1000));
    // ゴールデンクロスで買い: prev ma5<=ma25, curr ma5>ma25
    candles[11] = mkCandle(11, 1000, { ma5: 999, ma25: 1000 });
    candles.push(mkCandle(12, 1001, { ma5: 1001, ma25: 1000, slope: 0.002, flow: 5000, volume: 300_000 })); // buy entry
    // 上昇して含み益+1.5%（トレイリング発動）
    candles.push(mkCandle(13, 1015, { ma5: 1010, ma25: 1000 }));
    candles.push(mkCandle(14, 1016, { ma5: 1012, ma25: 1001 })); // ピーク
    // ピークから0.6%下落 → トレイリング利確（TRAIL_GAP=0.5%）
    candles.push(mkCandle(15, 1009, { ma5: 1011, ma25: 1002 }));
    // 残りは横ばい
    for (let i = 16; i < 20; i++) candles.push(mkCandle(i, 1009));

    const res = simulateStockReal("6981", "村田製作所", "6981.T", candles, () => 0.0, 3_000_000, 70, 30, 2.0, false);
    expect(res).not.toBeNull();
    const sells = res!.trades.filter(t => t.type === "sell");
    expect(sells.length).toBeGreaterThanOrEqual(1);
    // 利益が出ている（ピーク付近で利確できている）
    expect(res!.profitAmount).toBeGreaterThan(0);
    // トレイリング利確の理由が記録されている
    const trailSig = (res!.signals ?? []).find(s => s.reason?.includes("トレイリング"));
    expect(trailSig).toBeTruthy();
  });
});

describe("デッドクロス即決済の廃止", () => {
  it("含み損のデッドクロスでは即決済せず、損切りライン(2%)まで保有する", () => {
    const candles: RealCandle[] = [];
    for (let i = 0; i < 12; i++) candles.push(mkCandle(i, 1000));
    candles[11] = mkCandle(11, 1000, { ma5: 999, ma25: 1000 });
    // 買いエントリー
    candles.push(mkCandle(12, 1001, { ma5: 1001, ma25: 1000, slope: 0.002, flow: 5000, volume: 300_000 }));
    // すぐに微下落＋デッドクロス（prev ma5>=ma25, curr ma5<ma25）→ 旧ロジックなら即売り
    candles.push(mkCandle(13, 999, { ma5: 999, ma25: 1000 }));
    candles.push(mkCandle(14, 999, { ma5: 998, ma25: 1000 }));
    // 戻して引け
    for (let i = 15; i < 20; i++) candles.push(mkCandle(i, 1002, { ma5: 1001, ma25: 1000 }));

    const res = simulateStockReal("3436", "SUMCO", "3436.T", candles, () => 0.0, 3_000_000, 70, 30, 2.0, false);
    expect(res).not.toBeNull();
    // デッドクロスを理由とする決済が存在しないこと
    const deadCrossExit = (res!.signals ?? []).find(s => (s.type === "sell") && s.reason?.includes("デッドクロス"));
    expect(deadCrossExit).toBeFalsy();
  });
});
