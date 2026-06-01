import { describe, it, expect } from "vitest";
import { simulateStock, generateDailySimReport, TARGET_STOCKS } from "./simulation";

describe("simulateStock", () => {
  it("should return a valid result for a known stock", () => {
    const result = simulateStock("6526", "ソシオネクスト", 3000000, 70, 30, 1.5, 20260601);
    expect(result.symbol).toBe("6526");
    expect(result.name).toBe("ソシオネクスト");
    expect(result.initialCapital).toBe(3000000);
    expect(result.finalBalance).toBeGreaterThan(0);
    expect(result.winRate).toBeGreaterThanOrEqual(0);
    expect(result.winRate).toBeLessThanOrEqual(1);
    expect(result.tradesCount).toBeGreaterThanOrEqual(0);
    expect(result.lossCauses.length).toBeGreaterThan(0);
    expect(result.countermeasures.length).toBeGreaterThan(0);
  });

  it("should produce deterministic results with the same seed", () => {
    const result1 = simulateStock("6920", "レーザーテック", 3000000, 70, 30, 1.5, 12345);
    const result2 = simulateStock("6920", "レーザーテック", 3000000, 70, 30, 1.5, 12345);
    expect(result1.finalBalance).toBe(result2.finalBalance);
    expect(result1.tradesCount).toBe(result2.tradesCount);
    expect(result1.winCount).toBe(result2.winCount);
  });

  it("should produce different results with different seeds", () => {
    const result1 = simulateStock("8035", "東京エレクトロン", 3000000, 70, 30, 1.5, 1);
    const result2 = simulateStock("8035", "東京エレクトロン", 3000000, 70, 30, 1.5, 2);
    // 異なるシードなら少なくとも何かが違う
    const isDifferent =
      result1.finalBalance !== result2.finalBalance ||
      result1.tradesCount !== result2.tradesCount;
    expect(isDifferent).toBe(true);
  });

  it("should respect RSI parameters", () => {
    // 狭いRSI範囲（シグナルが出にくい）
    const resultNarrow = simulateStock("8306", "三菱UFJ FG", 3000000, 60, 40, 1.5, 20260601);
    // 広いRSI範囲（シグナルが出やすい）
    const resultWide = simulateStock("8306", "三菱UFJ FG", 3000000, 80, 20, 1.5, 20260601);
    // 両方とも有効な結果を返すことを確認
    expect(resultNarrow.finalBalance).toBeGreaterThan(0);
    expect(resultWide.finalBalance).toBeGreaterThan(0);
  });

  it("should have winCount + lossCount equal to tradesCount", () => {
    const result = simulateStock("9984", "ソフトバンクグループ", 3000000, 70, 30, 1.5, 20260601);
    expect(result.winCount + result.lossCount).toBe(result.tradesCount);
  });
});

describe("generateDailySimReport", () => {
  it("should generate a report for all target stocks", () => {
    const report = generateDailySimReport("2026-06-01", 70, 30, 1.5);
    expect(report.date).toBe("2026-06-01");
    expect(report.stockReports.length).toBe(TARGET_STOCKS.length);
  });

  it("should calculate correct totals", () => {
    const report = generateDailySimReport("2026-06-01", 70, 30, 1.5);
    const expectedTotal = report.stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
    expect(report.totalFinalBalance).toBeCloseTo(expectedTotal, 0);
  });

  it("should have consistent win rate calculation", () => {
    const report = generateDailySimReport("2026-06-01", 70, 30, 1.5);
    const totalWin = report.stockReports.reduce((sum, r) => sum + r.winCount, 0);
    const totalLoss = report.stockReports.reduce((sum, r) => sum + r.lossCount, 0);
    expect(report.totalWinCount).toBe(totalWin);
    expect(report.totalLossCount).toBe(totalLoss);
    const expectedWinRate = (totalWin + totalLoss) > 0 ? totalWin / (totalWin + totalLoss) : 0;
    expect(report.overallWinRate).toBeCloseTo(expectedWinRate, 5);
  });

  it("should produce deterministic results for the same date", () => {
    const report1 = generateDailySimReport("2026-05-15", 70, 30, 1.5);
    const report2 = generateDailySimReport("2026-05-15", 70, 30, 1.5);
    expect(report1.totalProfitAmount).toBe(report2.totalProfitAmount);
    expect(report1.overallWinRate).toBe(report2.overallWinRate);
  });

  it("should produce different results for different dates", () => {
    const report1 = generateDailySimReport("2026-06-01", 70, 30, 1.5);
    const report2 = generateDailySimReport("2026-06-02", 70, 30, 1.5);
    const isDifferent = report1.totalProfitAmount !== report2.totalProfitAmount;
    expect(isDifferent).toBe(true);
  });
});
