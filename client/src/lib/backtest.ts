import { CandleData } from '../types';

export interface BacktestResult {
  totalTrades: number;
  winTrades: number;
  loseTrades: number;
  winRate: number; // %
  totalProfitPercent: number; // %
  averageProfitPercent: number; // %
  maxDrawdownPercent: number; // %
  trades: {
    entryTime: string;
    entryPrice: number;
    exitTime: string;
    exitPrice: number;
    type: 'long'; // 今回は買い→売り（ロング）のみ
    profitPercent: number;
    result: 'win' | 'lose';
  }[];
}

/**
 * 簡易バックテストエンジン
 * 
 * 戦略:
 * 1. MAクロス: 5MAが25MAを上抜けたら買い、下抜けたら売り
 * 2. RSI逆張り: RSIが下限以下で買い、上限以上で売り
 * 3. ボリンジャーバンド: -2σ下抜けで買い、+2σ上抜けで売り
 */
export function runBacktest(
  candles: CandleData[],
  strategyType: 'ma_cross' | 'rsi' | 'bollinger',
  rsiUpper: number,
  rsiLower: number
): BacktestResult {
  const trades: BacktestResult['trades'] = [];
  let position: { entryTime: string; entryPrice: number } | null = null;
  
  let peakPrice = 0;
  let maxDrawdown = 0;

  // バックテストには十分なデータが必要 (指標が計算されているインデックスから開始)
  const startIndex = 25; 

  for (let i = startIndex; i < candles.length; i++) {
    const prev = candles[i - 1];
    const curr = candles[i];
    const price = curr.close;

    // ドローダウン計算用の最高値追跡
    if (price > peakPrice) {
      peakPrice = price;
    } else if (peakPrice > 0) {
      const dd = ((peakPrice - price) / peakPrice) * 100;
      if (dd > maxDrawdown) {
        maxDrawdown = dd;
      }
    }

    // シグナル判定
    let buySignal = false;
    let sellSignal = false;

    if (strategyType === 'ma_cross') {
      if (prev.ma5 !== undefined && prev.ma25 !== undefined && curr.ma5 !== undefined && curr.ma25 !== undefined) {
        if (prev.ma5 <= prev.ma25 && curr.ma5 > curr.ma25) buySignal = true;
        if (prev.ma5 >= prev.ma25 && curr.ma5 < curr.ma25) sellSignal = true;
      }
    } else if (strategyType === 'rsi') {
      if (prev.rsi !== undefined && curr.rsi !== undefined) {
        if (prev.rsi > rsiLower && curr.rsi <= rsiLower) buySignal = true;
        if (prev.rsi < rsiUpper && curr.rsi >= rsiUpper) sellSignal = true;
      }
    } else if (strategyType === 'bollinger') {
      if (prev.bbLower !== undefined && curr.bbLower !== undefined && prev.bbUpper !== undefined && curr.bbUpper !== undefined) {
        if (prev.close <= prev.bbLower && curr.close > curr.bbLower) buySignal = true;
        if (prev.close >= prev.bbUpper && curr.close < curr.bbUpper) sellSignal = true;
      }
    }

    // ポジション管理
    if (!position && buySignal) {
      // 買いエントリー
      position = {
        entryTime: curr.time,
        entryPrice: price,
      };
    } else if (position && sellSignal) {
      // 売りエグジット
      const profitPercent = ((price - position.entryPrice) / position.entryPrice) * 100;
      trades.push({
        entryTime: position.entryTime,
        entryPrice: position.entryPrice,
        exitTime: curr.time,
        exitPrice: price,
        type: 'long',
        profitPercent: Number(profitPercent.toFixed(2)),
        result: profitPercent > 0 ? 'win' : 'lose',
      });
      position = null; // ポジションクリア
    }
  }

  // もしバックテスト終了時点でポジションを持っていたら、最後のローソク足の終値で強制決済
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1];
    const profitPercent = ((lastCandle.close - position.entryPrice) / position.entryPrice) * 100;
    trades.push({
      entryTime: position.entryTime,
      entryPrice: position.entryPrice,
      exitTime: lastCandle.time,
      exitPrice: lastCandle.close,
      type: 'long',
      profitPercent: Number(profitPercent.toFixed(2)),
      result: profitPercent > 0 ? 'win' : 'lose',
    });
  }

  // 統計値の集計
  const totalTrades = trades.length;
  const winTrades = trades.filter((t) => t.result === 'win').length;
  const loseTrades = totalTrades - winTrades;
  const winRate = totalTrades > 0 ? (winTrades / totalTrades) * 100 : 0;
  const totalProfitPercent = trades.reduce((acc, t) => acc + t.profitPercent, 0);
  const averageProfitPercent = totalTrades > 0 ? totalProfitPercent / totalTrades : 0;

  return {
    totalTrades,
    winTrades,
    loseTrades,
    winRate: Number(winRate.toFixed(1)),
    totalProfitPercent: Number(totalProfitPercent.toFixed(2)),
    averageProfitPercent: Number(averageProfitPercent.toFixed(2)),
    maxDrawdownPercent: Number(maxDrawdown.toFixed(2)),
    trades,
  };
}
