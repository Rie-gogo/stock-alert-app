/**
 * サーバーサイド シミュレーションエンジン
 * ロング（買い）とショート（空売り）の両方向取引をサポート
 */

export interface CandleData {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number;
  ma25?: number;
  rsi?: number;
  bbUpper?: number;
  bbMiddle?: number;
  bbLower?: number;
}

export interface TradeRecord {
  time: string;
  type: "buy" | "sell" | "short" | "cover"; // short=空売りエントリー, cover=買い戻し
  price: number;
  shares: number;
  totalAmount: number;
  profit?: number;
  profitRate?: number;
}

export interface SignalRecord {
  time: string;
  type: "buy" | "sell" | "warn" | "short" | "cover";
  price: number;
  ma5: number | null;
  ma25: number | null;
  rsi: number | null;
  reason: string;
}

export interface StockSimResult {
  symbol: string;
  name: string;
  initialCapital: number;
  finalBalance: number;
  profitAmount: number;
  profitRate: number;
  tradesCount: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  trades: TradeRecord[];
  lossCauses: string[];
  countermeasures: string[];
  signals?: SignalRecord[];
}

export interface DailySimReport {
  date: string;
  totalInitialCapital: number;
  totalFinalBalance: number;
  totalProfitAmount: number;
  totalProfitRate: number;
  totalWinCount: number;
  totalLossCount: number;
  overallWinRate: number;
  rsiUpper: number;
  rsiLower: number;
  stopLossPercent: number;
  stockReports: StockSimResult[];
}

export const TARGET_STOCKS = [
  { symbol: "6526", name: "ソシオネクスト" },
  { symbol: "6920", name: "レーザーテック" },
  { symbol: "6857", name: "アドバンテスト" },
  { symbol: "9107", name: "川崎汽船" },
  { symbol: "8306", name: "三菱UFJ FG" },
  { symbol: "9984", name: "ソフトバンクグループ" },
  { symbol: "8035", name: "東京エレクトロン" },
  { symbol: "7011", name: "三菱重工業" },
  { symbol: "4568", name: "第一三共" },
  { symbol: "3778", name: "さくらインターネット" },
];

// ============================================================
// Technical Indicator Calculations
// ============================================================
function calculateMA(candles: CandleData[], period: number, index: number): number | undefined {
  if (index < period - 1) return undefined;
  const slice = candles.slice(index - period + 1, index + 1);
  return slice.reduce((sum, c) => sum + c.close, 0) / period;
}

function calculateRSI(candles: CandleData[], period: number, index: number): number | undefined {
  if (index < period) return undefined;
  let gains = 0;
  let losses = 0;
  for (let i = index - period + 1; i <= index; i++) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gains += change;
    else losses += Math.abs(change);
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}

function calculateBollingerBands(
  candles: CandleData[],
  period: number,
  index: number
): { upper: number; middle: number; lower: number } | undefined {
  if (index < period - 1) return undefined;
  const slice = candles.slice(index - period + 1, index + 1);
  const mean = slice.reduce((sum, c) => sum + c.close, 0) / period;
  const variance = slice.reduce((sum, c) => sum + Math.pow(c.close - mean, 2), 0) / period;
  const stdDev = Math.sqrt(variance);
  return { upper: mean + 2 * stdDev, middle: mean, lower: mean - 2 * stdDev };
}

function enrichCandles(candles: CandleData[]): CandleData[] {
  return candles.map((candle, i) => {
    const ma5 = calculateMA(candles, 5, i);
    const ma25 = calculateMA(candles, 25, i);
    const rsi = calculateRSI(candles, 14, i);
    const bb = calculateBollingerBands(candles, 20, i);
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

// ============================================================
// Historical Candle Generator
// ============================================================
function generateHistoricalCandles(
  symbol: string,
  seedPrice: number,
  count = 100,
  dateSeed: number = 0
): CandleData[] {
  const candles: CandleData[] = [];
  let currentPrice = seedPrice;
  const now = new Date();

  let seed = dateSeed + symbol.split("").reduce((s, c) => s + c.charCodeAt(0), 0);
  const seededRandom = () => {
    seed = (seed * 1664525 + 1013904223) & 0xffffffff;
    return (seed >>> 0) / 0xffffffff;
  };

  for (let i = count; i >= 0; i--) {
    const timeStr = new Date(now.getTime() - i * 60 * 1000).toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });

    let volatility = 0.003;
    if (["6920", "3778", "8035"].includes(symbol)) volatility = 0.006;
    if (["8306", "4568"].includes(symbol)) volatility = 0.0015;

    const change = currentPrice * volatility * (seededRandom() - 0.49);
    const open = currentPrice;
    const close = currentPrice + change;
    const high = Math.max(open, close) + currentPrice * volatility * 0.3 * seededRandom();
    const low = Math.min(open, close) - currentPrice * volatility * 0.3 * seededRandom();
    const volume = Math.floor(10000 + seededRandom() * 90000);

    candles.push({
      time: timeStr,
      timestamp: now.getTime() - i * 60 * 1000,
      open,
      high,
      low,
      close,
      volume,
    });

    currentPrice = close;
  }

  return enrichCandles(candles);
}

// ============================================================
// Single Stock Simulation（ロング＋ショート両方向）
// ============================================================
export function simulateStock(
  symbol: string,
  name: string,
  initialCapital = 3000000,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 1.5,
  dateSeed = 0
): StockSimResult {
  let basePrice = 3000;
  if (symbol === "6920") basePrice = 25000;
  if (symbol === "8035") basePrice = 35000;
  if (symbol === "8306") basePrice = 1500;
  if (symbol === "9107") basePrice = 2200;
  if (symbol === "9984") basePrice = 12000;
  if (symbol === "6857") basePrice = 8000;
  if (symbol === "7011") basePrice = 9000;
  if (symbol === "4568") basePrice = 4500;
  if (symbol === "3778") basePrice = 3500;

  const candles = generateHistoricalCandles(symbol, basePrice, 80, dateSeed);
  const trades: TradeRecord[] = [];
  const signals: SignalRecord[] = [];

  let capital = initialCapital;
  // ロングポジション
  let longShares = 0;
  let longEntryPrice = 0;
  // ショートポジション（空売り）
  let shortShares = 0;
  let shortEntryPrice = 0;

  let winCount = 0;
  let lossCount = 0;

  const stopLossRatio = stopLossPercent / 100;

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    if (
      curr.rsi === undefined ||
      curr.ma5 === undefined ||
      curr.ma25 === undefined ||
      curr.bbLower === undefined ||
      curr.bbUpper === undefined ||
      prev.ma5 === undefined ||
      prev.ma25 === undefined
    ) {
      continue;
    }

    // ============================================================
    // シグナル判定
    // ============================================================
    const isGoldenCross = prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25;
    const isDeadCross = prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25;
    const isRsiOversold = curr.rsi <= rsiLower;
    const isRsiOverbought = curr.rsi >= rsiUpper;
    const isBbLower = curr.close <= curr.bbLower;
    const isBbUpper = curr.close >= curr.bbUpper;
    const isDownTrend = curr.ma5 < curr.ma25;
    const isUpTrend = curr.ma5 > curr.ma25;
    const isStrongDownTrend = isDownTrend && curr.close < curr.ma5;
    const isStrongUpTrend = curr.ma5 > curr.ma25 * 1.003 && curr.close >= curr.ma5;

    // ============================================================
    // ロング（買い）ポジション管理
    // ============================================================

    // ロングエントリー：ゴールデンクロス or RSI売られすぎ+BB下限（強い下落トレンド中は見送り）
    const shouldBuyLong =
      !isStrongDownTrend && (isGoldenCross || (isRsiOversold && isBbLower));

    if (longShares === 0 && shortShares === 0 && shouldBuyLong) {
      const maxSpend = capital * 0.49; // 資金の半分でロング（残り半分はショート用）
      const shares = Math.floor(maxSpend / curr.close);
      if (shares > 0) {
        const totalAmount = shares * curr.close;
        longShares = shares;
        longEntryPrice = curr.close;
        capital -= totalAmount;
        trades.push({ time: curr.time, type: "buy", price: curr.close, shares, totalAmount });
        signals.push({
          time: curr.time,
          type: "buy",
          price: curr.close,
          ma5: curr.ma5,
          ma25: curr.ma25,
          rsi: curr.rsi,
          reason: isGoldenCross
            ? `ゴールデンクロス (MA5:${curr.ma5.toFixed(1)} > MA25:${curr.ma25.toFixed(1)})`
            : `RSI売られすぎ+BB下限 (RSI:${curr.rsi.toFixed(1)})`,
        });
      }
    }

    // ロング損切り：エントリー価格からstopLossPercent%下落
    if (longShares > 0 && curr.close <= longEntryPrice * (1 - stopLossRatio)) {
      const totalAmount = longShares * curr.close;
      const profit = totalAmount - longShares * longEntryPrice;
      capital += totalAmount;
      lossCount++;
      trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
      signals.push({ time: curr.time, type: "sell", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `損切り (エントリー:${longEntryPrice.toFixed(1)} → ${curr.close.toFixed(1)})` });
      longShares = 0;
      longEntryPrice = 0;
    }

    // ロング利確・手仕舞い：デッドクロス or RSI買われすぎ+BB上限
    const shouldSellLong =
      isDeadCross ||
      (isRsiOverbought && isBbUpper && !isStrongUpTrend);

    if (longShares > 0 && shouldSellLong) {
      const totalAmount = longShares * curr.close;
      const profit = totalAmount - longShares * longEntryPrice;
      capital += totalAmount;
      if (profit > 0) winCount++; else lossCount++;
      trades.push({ time: curr.time, type: "sell", price: curr.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
      signals.push({
        time: curr.time,
        type: "sell",
        price: curr.close,
        ma5: curr.ma5,
        ma25: curr.ma25,
        rsi: curr.rsi,
        reason: isDeadCross
          ? `デッドクロス (MA5:${curr.ma5.toFixed(1)} < MA25:${curr.ma25.toFixed(1)})`
          : `RSI買われすぎ+BB上限 (RSI:${curr.rsi.toFixed(1)})`,
      });
      longShares = 0;
      longEntryPrice = 0;
    }

    // ============================================================
    // ショート（空売り）ポジション管理
    // ============================================================

    // ショートエントリー：デッドクロス or RSI買われすぎ+BB上限（強い上昇トレンド中は見送り）
    const shouldEnterShort =
      !isStrongUpTrend && (isDeadCross || (isRsiOverbought && isBbUpper));

    if (shortShares === 0 && longShares === 0 && shouldEnterShort) {
      const maxSpend = capital * 0.49;
      const shares = Math.floor(maxSpend / curr.close);
      if (shares > 0) {
        // 空売り：株を借りて売る（証拠金として同額を確保）
        const marginRequired = shares * curr.close;
        shortShares = shares;
        shortEntryPrice = curr.close;
        capital -= marginRequired; // 証拠金を確保
        trades.push({ time: curr.time, type: "short", price: curr.close, shares, totalAmount: marginRequired });
        signals.push({
          time: curr.time,
          type: "short",
          price: curr.close,
          ma5: curr.ma5,
          ma25: curr.ma25,
          rsi: curr.rsi,
          reason: isDeadCross
            ? `空売りエントリー: デッドクロス (MA5:${curr.ma5.toFixed(1)} < MA25:${curr.ma25.toFixed(1)})`
            : `空売りエントリー: RSI買われすぎ+BB上限 (RSI:${curr.rsi.toFixed(1)})`,
        });
      }
    }

    // ショート損切り：エントリー価格からstopLossPercent%上昇
    if (shortShares > 0 && curr.close >= shortEntryPrice * (1 + stopLossRatio)) {
      const profit = (shortEntryPrice - curr.close) * shortShares;
      const marginReturn = shortShares * shortEntryPrice;
      capital += marginReturn + profit; // 証拠金返還 + 損益
      lossCount++;
      trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
      signals.push({ time: curr.time, type: "cover", price: curr.close, ma5: curr.ma5, ma25: curr.ma25, rsi: curr.rsi, reason: `空売り損切り (エントリー:${shortEntryPrice.toFixed(1)} → ${curr.close.toFixed(1)})` });
      shortShares = 0;
      shortEntryPrice = 0;
    }

    // ショート利確・買い戻し：ゴールデンクロス or RSI売られすぎ+BB下限
    const shouldCoverShort =
      isGoldenCross ||
      (isRsiOversold && isBbLower && !isStrongDownTrend);

    if (shortShares > 0 && shouldCoverShort) {
      const profit = (shortEntryPrice - curr.close) * shortShares;
      const marginReturn = shortShares * shortEntryPrice;
      capital += marginReturn + profit;
      if (profit > 0) winCount++; else lossCount++;
      trades.push({ time: curr.time, type: "cover", price: curr.close, shares: shortShares, totalAmount: shortShares * curr.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
      signals.push({
        time: curr.time,
        type: "cover",
        price: curr.close,
        ma5: curr.ma5,
        ma25: curr.ma25,
        rsi: curr.rsi,
        reason: isGoldenCross
          ? `空売り買い戻し: ゴールデンクロス (MA5:${curr.ma5.toFixed(1)} > MA25:${curr.ma25.toFixed(1)})`
          : `空売り買い戻し: RSI売られすぎ+BB下限 (RSI:${curr.rsi.toFixed(1)})`,
      });
      shortShares = 0;
      shortEntryPrice = 0;
    }
  }

  // 残ロングポジションを強制決済
  if (longShares > 0) {
    const lastCandle = candles[candles.length - 1];
    const totalAmount = longShares * lastCandle.close;
    const profit = totalAmount - longShares * longEntryPrice;
    capital += totalAmount;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "sell", price: lastCandle.close, shares: longShares, totalAmount, profit, profitRate: profit / (longShares * longEntryPrice) });
  }

  // 残ショートポジションを強制決済
  if (shortShares > 0) {
    const lastCandle = candles[candles.length - 1];
    const profit = (shortEntryPrice - lastCandle.close) * shortShares;
    const marginReturn = shortShares * shortEntryPrice;
    capital += marginReturn + profit;
    if (profit > 0) winCount++; else lossCount++;
    trades.push({ time: lastCandle.time, type: "cover", price: lastCandle.close, shares: shortShares, totalAmount: shortShares * lastCandle.close, profit, profitRate: profit / (shortShares * shortEntryPrice) });
  }

  const finalBalance = capital;
  const profitAmount = finalBalance - initialCapital;
  const profitRate = profitAmount / initialCapital;
  const tradesCount = trades.filter((t) => t.type === "sell" || t.type === "cover").length;
  const winRate = tradesCount > 0 ? winCount / tradesCount : 0;

  // 損失原因と対策の動的生成
  const lossCauses: string[] = [];
  const countermeasures: string[] = [];

  if (profitAmount < 0) {
    if (lossCount > winCount) {
      lossCauses.push("📉 レンジ相場（もみ合い）での細かな損切りの連続（往復ビンタ）。");
      countermeasures.push("🛡️ レンジ相場を検知した場合は、MAクロスによるトレンドフォロー取引を一時停止し、RSI逆張りに切り替える。");
    }
    if (["6920", "3778", "8035"].includes(symbol)) {
      lossCauses.push("⚡ 値動き（ボラティリティ）が非常に激しく、エントリー直後に逆行して強制損切りにかかった。");
      countermeasures.push(`📏 激しい銘柄については、損切り幅を通常の${stopLossPercent}%から${(stopLossPercent * 1.5).toFixed(1)}%〜${(stopLossPercent * 2).toFixed(1)}%に広げ、ノイズによる損切りを回避する。`);
    } else {
      lossCauses.push("💤 トレンドが弱く、エントリー後に価格が動かず、手数料や微減のまま時間切れ決済となった。");
      countermeasures.push("⏱️ ボラティリティ（値幅）が一定以下の時はエントリーを見送るフィルター（ADX等の導入）を検討する。");
    }
    lossCauses.push("📈 急激なトレンド転換に対して、1分足の移動平均線の反応が遅れ、高値掴み・安値売りとなった。");
    countermeasures.push("⚙️ 移動平均線の期間を5MAから3MAなど、より短期に設定して反応速度を上げる。");
  } else {
    lossCauses.push("✅ 本日は利益を確保できましたが、トレンドの終盤でエントリーする微小な高値掴みが発生していました。");
    countermeasures.push("🎯 トレンド発生から時間が経過している場合は、エントリーのロット数を半分にするなどの資金管理を徹底する。");
  }

  return {
    symbol,
    name,
    initialCapital,
    finalBalance,
    profitAmount,
    profitRate,
    tradesCount,
    winCount,
    lossCount,
    winRate,
    trades,
    lossCauses,
    countermeasures,
    signals,
  };
}

// ============================================================
// Full Daily Report Generation
// ============================================================
export function generateDailySimReport(
  dateStr: string,
  rsiUpper = 70,
  rsiLower = 30,
  stopLossPercent = 1.5
): DailySimReport {
  const dateSeed = dateStr
    .split("-")
    .map(Number)
    .reduce((s, n) => s * 100 + n, 0);

  const stockReports = TARGET_STOCKS.map((stock) =>
    simulateStock(stock.symbol, stock.name, 3000000, rsiUpper, rsiLower, stopLossPercent, dateSeed)
  );

  const totalInitialCapital = 3000000 * TARGET_STOCKS.length;
  const totalFinalBalance = stockReports.reduce((sum, r) => sum + r.finalBalance, 0);
  const totalProfitAmount = totalFinalBalance - totalInitialCapital;
  const totalProfitRate = totalProfitAmount / totalInitialCapital;
  const totalWinCount = stockReports.reduce((sum, r) => sum + r.winCount, 0);
  const totalLossCount = stockReports.reduce((sum, r) => sum + r.lossCount, 0);
  const totalTrades = totalWinCount + totalLossCount;
  const overallWinRate = totalTrades > 0 ? totalWinCount / totalTrades : 0;

  return {
    date: dateStr,
    totalInitialCapital,
    totalFinalBalance,
    totalProfitAmount,
    totalProfitRate,
    totalWinCount,
    totalLossCount,
    overallWinRate,
    rsiUpper,
    rsiLower,
    stopLossPercent,
    stockReports,
  };
}
