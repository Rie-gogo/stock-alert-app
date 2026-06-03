/**
 * intradayRegime.ts
 * 「その日の大局トレンド（日中レジーム）」を判定する純粋関数群。
 *
 * 背景: 監視ボードのシグナル判定(detectSignals)は、1分足の超短期MA(5本/25本)の
 * クロスだけで「買い/売り」を貼り替えていたため、当日全体が明確な下落（例: -3.3%）
 * でも、安値圏の小さな反発を「ゴールデンクロス＝買い」と表示してしまっていた。
 *
 * そこで、各足の時点までの情報から「その日の大きな流れ」を up / down / neutral で判定し、
 * 下落相場ではロング（買い）シグナルを抑制、上昇相場ではショート（売り）を抑制する。
 *
 * 判定材料は2つ:
 *   1) MA25 の傾き（直近 slopeWindow 本での変化率）= 中期トレンドの向き
 *   2) 当日始値からの騰落率（その足の終値 vs 当日寄り値）= 当日全体の方向
 * いずれかが明確に下向き／上向きで、かつ反対材料が無いときにレジームを確定する。
 *
 * 副作用を持たない純粋関数で構成し、テスト容易性を確保する。
 */

export type IntradayRegime = "up" | "down" | "neutral";

/** MA25 の傾き（変化率）がトレンドありと見なすしきい値（割合）。例: 0.0015 = 0.15% */
export const REGIME_SLOPE_THRESHOLD = 0.0015;

/** 当日始値からの騰落率がトレンドありと見なすしきい値（割合）。例: 0.006 = 0.6% */
export const REGIME_DAY_CHANGE_THRESHOLD = 0.006;

/** MA25 の傾きを評価する際に遡る本数 */
export const REGIME_SLOPE_WINDOW = 10;

/**
 * MA25 系列上の index 位置における傾き（変化率）を求める。
 * (現在のMA25 - window本前のMA25) / window本前のMA25
 * データ不足や値が無い場合は null。
 */
export function ma25Slope(
  ma25: (number | null)[],
  index: number,
  window: number = REGIME_SLOPE_WINDOW
): number | null {
  if (index - window < 0) return null;
  const cur = ma25[index];
  const past = ma25[index - window];
  if (cur === null || cur === undefined || past === null || past === undefined || past <= 0) {
    return null;
  }
  return (cur - past) / past;
}

/**
 * 当日始値からの騰落率。dayOpen が無効なら null。
 */
export function dayChangeRatio(close: number, dayOpen: number | null): number | null {
  if (dayOpen === null || dayOpen === undefined || dayOpen <= 0) return null;
  return (close - dayOpen) / dayOpen;
}

/**
 * その足の時点での「当日の大局トレンド」を判定する。
 *
 * - down: MA25 が明確に下向き、または当日寄りから明確に下落 のいずれかが成立し、
 *         かつ反対（上向き）材料が無い
 * - up:   その逆
 * - neutral: どちらとも言えない
 *
 * 「いずれか一方が明確で、反対材料が無い」を条件にすることで、
 * 下落相場の安値圏リバウンド（MA傾きはまだ下向き、当日も下落のまま）でも
 * しっかり down と判定できる。
 */
export function classifyIntradayRegime(params: {
  slope: number | null;
  dayChange: number | null;
  slopeThreshold?: number;
  dayChangeThreshold?: number;
}): IntradayRegime {
  const slopeTh = params.slopeThreshold ?? REGIME_SLOPE_THRESHOLD;
  const dayTh = params.dayChangeThreshold ?? REGIME_DAY_CHANGE_THRESHOLD;
  const { slope, dayChange } = params;

  const slopeDown = slope !== null && slope < -slopeTh;
  const slopeUp = slope !== null && slope > slopeTh;
  const dayDown = dayChange !== null && dayChange < -dayTh;
  const dayUp = dayChange !== null && dayChange > dayTh;

  const downSignals = (slopeDown ? 1 : 0) + (dayDown ? 1 : 0);
  const upSignals = (slopeUp ? 1 : 0) + (dayUp ? 1 : 0);

  // 明確な下落: 下落材料があり、上昇材料が無い
  if (downSignals >= 1 && upSignals === 0) return "down";
  // 明確な上昇: 上昇材料があり、下落材料が無い
  if (upSignals >= 1 && downSignals === 0) return "up";
  return "neutral";
}

/**
 * 当該レジーム下で、あるシグナル方向を「許可」してよいかを返す。
 * - down 相場では buy を抑制（false）、sell は許可
 * - up   相場では sell を抑制（false）、buy は許可
 * - neutral では両方許可
 * - warn は常に許可
 */
export function isSignalAllowedInRegime(
  type: "buy" | "sell" | "warn",
  regime: IntradayRegime
): boolean {
  if (type === "warn") return true;
  if (regime === "down") return type !== "buy";
  if (regime === "up") return type !== "sell";
  return true;
}
