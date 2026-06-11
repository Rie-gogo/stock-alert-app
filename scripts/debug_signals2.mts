/**
 * debug_signals2.mts
 * detectSignals内部の各フィルタ段階でどれだけシグナルが落とされているかを追跡する
 */
import 'dotenv/config';
import { drizzle } from 'drizzle-orm/mysql2';
import mysql from 'mysql2/promise';
import { rtCandles } from '../drizzle/schema';
import { eq, asc } from 'drizzle-orm';

// 内部ロジックを直接再実装して各段階のカウントを取る
import {
  evaluateConfirmation,
  trailingAvgVolume,
  priceMomentum,
} from '../server/signalConfirmation';
import {
  calcVWAP,
  calcDowSwings,
  detectVwapBounce,
  detectDoubleTopBottom,
  detectHeadAndShoulders,
  isLongUpperShadow,
  isLongLowerShadow,
  detectHarami,
  detectRoundLevel,
  ma25Slope,
  dayChangeRatio,
  classifyIntradayRegime,
  isSignalAllowedInRegime,
  calcADX,
  isAdxTrending,
} from '../server/vwap';
import {
  ma25Slope,
  dayChangeRatio,
  classifyIntradayRegime,
  isSignalAllowedInRegime,
  calcADX,
  isAdxTrending,
} from '../server/intradayRegime';
import type { CandleWithSignal } from '../server/routers/stockData';

const TARGET_DATE = '2026-06-11';
const TARGET_SYMBOL = '7203'; // トヨタで代表的に確認

const conn = await mysql.createConnection(process.env.DATABASE_URL!);
const db = drizzle(conn);

const rawCandles = await db.select().from(rtCandles)
  .where(eq(rtCandles.tradeDate, TARGET_DATE))
  .orderBy(asc(rtCandles.candleTime));

// 指定銘柄のみ
const symCandles = rawCandles.filter(c => c.symbol === TARGET_SYMBOL);
console.log(`${TARGET_SYMBOL}: ${symCandles.length}本`);

// CandleWithSignal形式に変換
const buffer: CandleWithSignal[] = symCandles.map(c => ({
  time: `${TARGET_DATE}T${c.candleTime}:00`,
  dayKey: TARGET_DATE,
  timestamp: new Date(`${TARGET_DATE}T${c.candleTime}:00+09:00`).getTime(),
  open: parseFloat(c.open),
  high: parseFloat(c.high),
  low: parseFloat(c.low),
  close: parseFloat(c.close),
  volume: c.volume ?? 0,
  ma5: null, ma25: null, rsi: null,
  bbUpper: null, bbMiddle: null, bbLower: null,
}));

// MA5/MA25/RSI/BBを計算
const closes = buffer.map(c => c.close);
const highs = buffer.map(c => c.high);
const lows = buffer.map(c => c.low);
const volumes = buffer.map(c => c.volume);

// MA計算
function calcMA(arr: number[], period: number, i: number): number | null {
  if (i < period - 1) return null;
  const slice = arr.slice(i - period + 1, i + 1);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// RSI計算
function calcRSI(arr: number[], i: number, period = 14): number | null {
  if (i < period) return null;
  let gains = 0, losses = 0;
  for (let j = i - period + 1; j <= i; j++) {
    const diff = arr[j] - arr[j - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return Math.round(100 - 100 / (1 + rs));
}

// BB計算
function calcBB(arr: number[], i: number, period = 20, mult = 2): { upper: number; middle: number; lower: number } | null {
  if (i < period - 1) return null;
  const slice = arr.slice(i - period + 1, i + 1);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: mean + mult * std, middle: mean, lower: mean - mult * std };
}

for (let i = 0; i < buffer.length; i++) {
  buffer[i].ma5 = calcMA(closes, 5, i);
  buffer[i].ma25 = calcMA(closes, 25, i);
  buffer[i].rsi = calcRSI(closes, i);
  const bb = calcBB(closes, i);
  if (bb) {
    buffer[i].bbUpper = bb.upper;
    buffer[i].bbMiddle = bb.middle;
    buffer[i].bbLower = bb.lower;
  }
}

const adxSeries = calcADX(highs, lows, closes);
const vwapSeries = calcVWAP(buffer);
const dowSwings = calcDowSwings(buffer, 20);
const vwapBounceSeries = detectVwapBounce(buffer, vwapSeries);
const doublePatternSeries = detectDoubleTopBottom(buffer, 40);
const hsSeries = detectHeadAndShoulders(buffer, 60);
const ma25Series = buffer.map(c => c.ma25);

const dayOpenByKey = new Map<string, number>();
for (const c of buffer) {
  const key = c.dayKey ?? '__all__';
  if (!dayOpenByKey.has(key)) dayOpenByKey.set(key, c.open);
}

// カウンター
let cnt_candidate = 0;
let cnt_regime_filtered = 0;
let cnt_adx_filtered = 0;
let cnt_confirm_filtered = 0;
let cnt_passed = 0;

// サンプル出力（最初の10件のcandidateを詳細表示）
let sampleCount = 0;

for (let i = 30; i < buffer.length; i++) {
  const c = buffer[i];
  const prev = buffer[i - 1];
  const { candleTime } = symCandles[i];

  const c5 = c.ma5, c25 = c.ma25, p5 = prev.ma5, p25 = prev.ma25;
  const cRsi = c.rsi, cBbu = c.bbUpper, cBbl = c.bbLower;
  if (c5 === null || c25 === null || p5 === null || p25 === null ||
      cRsi === null || cBbu === null || cBbl === null) continue;

  const dayKey = c.dayKey ?? '__all__';
  const dayOpen = dayOpenByKey.get(dayKey) ?? null;
  const slope = ma25Slope(ma25Series, i);
  const dayChange = dayChangeRatio(c.close, dayOpen);
  const regime = classifyIntradayRegime({ slope, dayChange });

  const isStrongDown = c5 < c25 && c.close < c5;
  const isStrongUp = c5 > c25 && c.close >= c5;

  let gcProtection = false;
  for (let j = Math.max(1, i - 4); j <= i; j++) {
    const rj = buffer[j], rjp = buffer[j - 1];
    if (rj.ma5 !== null && rj.ma25 !== null && rjp.ma5 !== null && rjp.ma25 !== null) {
      if (rjp.ma5 <= rjp.ma25 && rj.ma5 > rj.ma25) { gcProtection = true; break; }
    }
  }

  const vwapCurr = vwapSeries[i], vwapPrev = vwapSeries[i - 1];
  const vwapCrossUp = vwapCurr !== null && vwapPrev !== null && prev.close < vwapPrev && c.close >= vwapCurr;
  const vwapCrossDown = vwapCurr !== null && vwapPrev !== null && prev.close > vwapPrev && c.close <= vwapCurr;
  const { swingHighBreak, swingLowBreak } = dowSwings[i];
  const longUpperShadow = isLongUpperShadow(c);
  const longLowerShadow = isLongLowerShadow(c);
  const { isBullishHarami, isBearishHarami } = detectHarami(prev, c);
  const { crossedBelow: roundLevelBreak, crossedAbove: roundLevelBreakUp, level: roundLevel } = detectRoundLevel(prev.close, c.close);
  const { isBullishBounce: vwapBullishBounce, isBearishBounce: vwapBearishBounce } = vwapBounceSeries[i];
  const { isDoubleTop, isDoubleBottom, neckline: dtNeckline } = doublePatternSeries[i];
  const { isHeadAndShoulders: isHS, isInverseHeadAndShoulders: isIHS, neckline: hsNeckline } = hsSeries[i];

  let candidate: { type: 'buy' | 'sell'; reason: string } | null = null;

  if (!isStrongDown) {
    if (p5 <= p25 && c5 > c25) candidate = { type: 'buy', reason: `GC` };
    else if (cRsi <= 30 && c.close <= cBbl) candidate = { type: 'buy', reason: `RSI売られすぎ+BB下限` };
    else if (vwapCrossUp && regime !== 'down') candidate = { type: 'buy', reason: `VWAPクロス上抜け` };
    else if (swingHighBreak && c5 > c25 && regime !== 'down') candidate = { type: 'buy', reason: `ダウ高値更新` };
    else if (longLowerShadow && cRsi <= 45 && regime !== 'down') candidate = { type: 'buy', reason: `長い下ヒゲ` };
    else if (isBullishHarami && cRsi <= 45) candidate = { type: 'buy', reason: `強気はらみ` };
    else if (roundLevelBreakUp && roundLevel !== null && regime !== 'down') candidate = { type: 'buy', reason: `大台超え` };
    else if (vwapBullishBounce && regime !== 'down') candidate = { type: 'buy', reason: `VWAP反発` };
    else if (isDoubleBottom && dtNeckline !== null && regime !== 'down') candidate = { type: 'buy', reason: `ダブルボトム` };
    else if (isIHS && hsNeckline !== null && regime !== 'down') candidate = { type: 'buy', reason: `逆三尊` };
  }

  if (!candidate) {
    if (p5 >= p25 && c5 < c25) candidate = { type: 'sell', reason: `DC` };
    else if (cRsi >= 70 && c.close >= cBbu && !isStrongUp && !gcProtection) candidate = { type: 'sell', reason: `RSI買われすぎ+BB上限` };
    else if (regime === 'down' && cRsi >= 50 && c.close <= c25) candidate = { type: 'sell', reason: `戻り売り` };
    else if (vwapCrossDown && regime !== 'up') candidate = { type: 'sell', reason: `VWAPクロス下抜け` };
    else if (swingLowBreak && c5 < c25 && regime !== 'up') candidate = { type: 'sell', reason: `ダウ安値更新` };
    else if (longUpperShadow && cRsi >= 55 && !gcProtection) candidate = { type: 'sell', reason: `長い上ヒゲ` };
    else if (isBearishHarami && cRsi >= 55 && !gcProtection) candidate = { type: 'sell', reason: `弱気はらみ` };
    else if (roundLevelBreak && roundLevel !== null && regime !== 'up') candidate = { type: 'sell', reason: `大台割れ` };
    else if (vwapBearishBounce && regime !== 'up') candidate = { type: 'sell', reason: `VWAP反落` };
    else if (isDoubleTop && dtNeckline !== null && regime !== 'up') candidate = { type: 'sell', reason: `ダブルトップ` };
    else if (isHS && hsNeckline !== null && regime !== 'up') candidate = { type: 'sell', reason: `三尊` };
  }

  if (!candidate) continue;
  cnt_candidate++;

  // レジームフィルター
  if (!isSignalAllowedInRegime(candidate.type, regime)) {
    cnt_regime_filtered++;
    if (sampleCount < 5) {
      console.log(`[REGIME_FILTER] ${candleTime} ${candidate.type} ${candidate.reason} → regime=${regime}`);
      sampleCount++;
    }
    continue;
  }

  // ADXフィルター
  const adxVal = adxSeries[i];
  const isGcDcSignal = candidate.reason.includes('GC') || candidate.reason.includes('DC') || candidate.reason.includes('戻り売り');
  if (isGcDcSignal && !isAdxTrending(adxVal)) {
    cnt_adx_filtered++;
    if (sampleCount < 10) {
      console.log(`[ADX_FILTER] ${candleTime} ${candidate.type} ${candidate.reason} → ADX=${adxVal?.toFixed(1)}`);
      sampleCount++;
    }
    continue;
  }

  // 確認バーフィルター
  if (candidate.reason === 'GC' && c.close < c5) continue;
  if (candidate.reason === 'DC' && c.close > c5) continue;

  // evaluateConfirmation
  const conf = evaluateConfirmation({
    type: candidate.type,
    close: c.close,
    volume: c.volume,
    avgVolume: trailingAvgVolume(volumes, i, 10),
    ma5: c5,
    ma25: c25,
    momentum: priceMomentum(closes, i, 3),
    regime,
  });

  if (!conf.shouldNotify) {
    cnt_confirm_filtered++;
    if (sampleCount < 15) {
      console.log(`[CONFIRM_FILTER] ${candleTime} ${candidate.type} ${candidate.reason} → score=${conf.score} (${conf.summary})`);
      sampleCount++;
    }
    continue;
  }

  cnt_passed++;
  console.log(`[PASSED] ${candleTime} ${candidate.type} ${candidate.reason} → ${conf.summary} close=${c.close} MA5=${c5?.toFixed(1)} MA25=${c25?.toFixed(1)} RSI=${cRsi} regime=${regime}`);
}

console.log(`\n=== ${TARGET_SYMBOL} フィルタ段階別集計 ===`);
console.log(`シグナル候補: ${cnt_candidate}`);
console.log(`  レジームフィルターで除去: ${cnt_regime_filtered}`);
console.log(`  ADXフィルターで除去: ${cnt_adx_filtered}`);
console.log(`  確認フィルターで除去(weak): ${cnt_confirm_filtered}`);
console.log(`  通過（実際にシグナル発火）: ${cnt_passed}`);

await conn.end();
