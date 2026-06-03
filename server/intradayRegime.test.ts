import { describe, it, expect } from "vitest";
import {
  ma25Slope,
  dayChangeRatio,
  classifyIntradayRegime,
  isSignalAllowedInRegime,
  REGIME_SLOPE_THRESHOLD,
  REGIME_DAY_CHANGE_THRESHOLD,
} from "./intradayRegime";

describe("ma25Slope", () => {
  it("データ不足ならnullを返す", () => {
    expect(ma25Slope([100, 101], 1, 10)).toBeNull();
  });

  it("nullを含む位置はnullを返す", () => {
    const series = [null, null, 100, 101, 102, 103, 104, 105, 106, 107, 108];
    // index 10 から 10本前 = index 0 が null
    expect(ma25Slope(series, 10, 10)).toBeNull();
  });

  it("上昇系列では正の傾き", () => {
    const series = Array.from({ length: 20 }, (_, i) => 100 + i);
    const slope = ma25Slope(series, 19, 10);
    expect(slope).not.toBeNull();
    expect(slope! > 0).toBe(true);
  });

  it("下降系列では負の傾き", () => {
    const series = Array.from({ length: 20 }, (_, i) => 200 - i);
    const slope = ma25Slope(series, 19, 10);
    expect(slope).not.toBeNull();
    expect(slope! < 0).toBe(true);
  });
});

describe("dayChangeRatio", () => {
  it("寄り値が無効ならnull", () => {
    expect(dayChangeRatio(100, null)).toBeNull();
    expect(dayChangeRatio(100, 0)).toBeNull();
  });

  it("下落時は負の比率", () => {
    expect(dayChangeRatio(96.7, 100)).toBeCloseTo(-0.033, 3);
  });

  it("上昇時は正の比率", () => {
    expect(dayChangeRatio(106, 100)).toBeCloseTo(0.06, 3);
  });
});

describe("classifyIntradayRegime", () => {
  it("MA25が下向きで当日も下落ならdown", () => {
    const regime = classifyIntradayRegime({ slope: -0.01, dayChange: -0.03 });
    expect(regime).toBe("down");
  });

  it("当日下落のみ（傾きは中立）でもdown", () => {
    const regime = classifyIntradayRegime({ slope: 0, dayChange: -0.03 });
    expect(regime).toBe("down");
  });

  it("MA25が下向きのみ（当日横ばい）でもdown", () => {
    const regime = classifyIntradayRegime({ slope: -0.01, dayChange: 0 });
    expect(regime).toBe("down");
  });

  it("MA25上向き・当日上昇ならup", () => {
    const regime = classifyIntradayRegime({ slope: 0.01, dayChange: 0.03 });
    expect(regime).toBe("up");
  });

  it("傾き下向き・当日上昇など材料が衝突したらneutral", () => {
    const regime = classifyIntradayRegime({ slope: -0.01, dayChange: 0.03 });
    expect(regime).toBe("neutral");
  });

  it("どちらもしきい値未満ならneutral", () => {
    const regime = classifyIntradayRegime({
      slope: REGIME_SLOPE_THRESHOLD / 2,
      dayChange: REGIME_DAY_CHANGE_THRESHOLD / 2,
    });
    expect(regime).toBe("neutral");
  });

  it("ソフトバンクG -3.3%のような下落日はdown（安値圏でMA傾きがまだ下向き）", () => {
    // 当日-3.3%、MA25もまだ下向き → down と判定され、買いは抑制されるべき
    const regime = classifyIntradayRegime({ slope: -0.005, dayChange: -0.033 });
    expect(regime).toBe("down");
  });
});

describe("isSignalAllowedInRegime", () => {
  it("下落相場では買いを禁止、売りは許可", () => {
    expect(isSignalAllowedInRegime("buy", "down")).toBe(false);
    expect(isSignalAllowedInRegime("sell", "down")).toBe(true);
  });

  it("上昇相場では売りを禁止、買いは許可", () => {
    expect(isSignalAllowedInRegime("sell", "up")).toBe(false);
    expect(isSignalAllowedInRegime("buy", "up")).toBe(true);
  });

  it("中立相場では両方許可", () => {
    expect(isSignalAllowedInRegime("buy", "neutral")).toBe(true);
    expect(isSignalAllowedInRegime("sell", "neutral")).toBe(true);
  });

  it("warnはどのレジームでも許可", () => {
    expect(isSignalAllowedInRegime("warn", "down")).toBe(true);
    expect(isSignalAllowedInRegime("warn", "up")).toBe(true);
  });
});
