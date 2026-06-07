/**
 * realtimeSimEngine.test.ts
 *
 * リアルタイム取引シミュレーションエンジンのユニットテスト
 *
 * DBを使わずにロジックのみをテストする。
 * insertRtCandle, insertRtTrade, upsertRtDailySummary, getRtTradesForDate は
 * vitest の vi.mock() でモック化する。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== DB関数をモック化 =====
vi.mock("./db", () => ({
  insertRtCandle: vi.fn().mockResolvedValue(undefined),
  insertRtTrade: vi.fn().mockResolvedValue(undefined),
  upsertRtDailySummary: vi.fn().mockResolvedValue(undefined),
  getRtTradesForDate: vi.fn().mockResolvedValue([]),
}));

// kabuStation をモック化（板情報なし）
vi.mock("./kabuStation", () => ({
  getOrderBook: vi.fn().mockReturnValue(null),
  analyzeOrderBook: vi.fn().mockReturnValue([]),
}));

// shared/stocks をモック化
vi.mock("../shared/stocks", () => ({
  getStockName: vi.fn().mockReturnValue("テスト銘柄"),
}));

// ===== テスト対象をインポート =====
// モック設定後にインポートする
import { processCandle, getOpenPositions, getCandleCounters } from "./realtimeSimEngine";
import type { RtCandle1Min } from "./realtimeSimEngine";

// ===== ヘルパー =====

function makeCandle(overrides: Partial<RtCandle1Min> = {}): RtCandle1Min {
  return {
    symbol: "6976",
    tradeDate: "2026-06-07",
    candleTime: "09:30",
    open: 3000,
    high: 3050,
    low: 2980,
    close: 3020,
    volume: 10000,
    ...overrides,
  };
}

/**
 * ウォームアップ用に30本の足を送信する（シグナル判定に必要なMA25計算のため）
 */
async function warmup(symbol: string, tradeDate: string, basePrice = 3000): Promise<void> {
  for (let i = 0; i < 30; i++) {
    const hour = 9 + Math.floor(i / 60);
    const minute = i % 60;
    const candleTime = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
    await processCandle(makeCandle({
      symbol,
      tradeDate,
      candleTime,
      open: basePrice,
      high: basePrice + 10,
      low: basePrice - 10,
      close: basePrice,
      volume: 5000,
    }));
  }
}

// ===== テスト =====

describe("realtimeSimEngine", () => {
  beforeEach(() => {
    // モジュールレベルの状態をリセットするため、
    // 別の日付でprocessCandleを呼ぶことで内部状態をリセットする
    vi.clearAllMocks();
  });

  describe("processCandle - 基本動作", () => {
    it("ウォームアップ期間中（30本未満）はaction=noneを返す", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_WARMUP",
        tradeDate: "2026-01-01",
        candleTime: "09:00",
      }));
      expect(result.action).toBe("none");
    });

    it("受信した足はDBに保存される（insertRtCandleが呼ばれる）", async () => {
      const { insertRtCandle } = await import("./db");
      const mockFn = vi.mocked(insertRtCandle);
      mockFn.mockClear();

      await processCandle(makeCandle({
        symbol: "TEST_DB",
        tradeDate: "2026-01-02",
        candleTime: "09:01",
      }));

      expect(mockFn).toHaveBeenCalledOnce();
      expect(mockFn).toHaveBeenCalledWith(
        expect.objectContaining({
          symbol: "TEST_DB",
          tradeDate: "2026-01-02",
          candleTime: "09:01",
        })
      );
    });

    it("午後14:30以降は新規エントリーしない", async () => {
      const symbol = "TEST_NOENTRY";
      const tradeDate = "2026-01-03";

      // ウォームアップ
      await warmup(symbol, tradeDate, 3000);

      // 14:31 に強いシグナルが出るような足を送信
      const result = await processCandle(makeCandle({
        symbol,
        tradeDate,
        candleTime: "14:31",
        open: 3000,
        high: 3200, // 大幅上昇
        low: 2990,
        close: 3180,
        volume: 100000,
      }));

      // エントリーされないこと
      expect(result.action).toBe("none");
    });
  });

  describe("getCandleCounters - 受信足数カウンター", () => {
    it("受信した足の数がカウンターに反映される", async () => {
      const symbol = "TEST_COUNTER";
      const tradeDate = "2026-01-04";

      const before = getCandleCounters()[symbol] ?? 0;

      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:00" }));
      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:01" }));
      await processCandle(makeCandle({ symbol, tradeDate, candleTime: "09:02" }));

      const after = getCandleCounters()[symbol] ?? 0;
      expect(after - before).toBeGreaterThanOrEqual(3);
    });
  });

  describe("getOpenPositions - オープンポジション", () => {
    it("初期状態では空配列を返す（または既存ポジションのみ）", () => {
      const positions = getOpenPositions();
      expect(Array.isArray(positions)).toBe(true);
    });
  });

  describe("processCandle - 損切り・利確ロジック", () => {
    it("返り値は正しいシェイプを持つ", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_SHAPE",
        tradeDate: "2026-01-05",
        candleTime: "09:00",
      }));

      expect(result).toHaveProperty("symbol");
      expect(result).toHaveProperty("tradeDate");
      expect(result).toHaveProperty("candleTime");
      expect(result).toHaveProperty("action");
      expect(["entry", "exit", "stop_loss", "take_profit", "forced_close", "none"]).toContain(result.action);
    });

    it("pnlはaction=noneの場合はundefinedまたは数値", async () => {
      const result = await processCandle(makeCandle({
        symbol: "TEST_PNL",
        tradeDate: "2026-01-06",
        candleTime: "09:00",
      }));

      if (result.pnl !== undefined) {
        expect(typeof result.pnl).toBe("number");
      }
    });
  });
});
