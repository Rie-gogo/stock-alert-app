/**
 * useRealMarketData
 * Yahoo Finance から実際の株価データを取得し、MarketState 互換の形に変換するフック。
 * - 1分ごとに自動ポーリング（refetchInterval: 60_000）
 * - 板情報・歩み値はリアルタイム価格を基準にしたシミュレーション（Yahoo Finance では取得不可）
 * - 市場時間外（土日・夜間）は isMarketClosed フラグを返す
 */
import { useState, useEffect, useRef, useMemo } from 'react';
import { trpc } from '@/lib/trpc';
import { CandleData, MarketState, BoardData, BoardItem, TradeTick, AlertLog } from '../types';
import { TARGET_STOCKS, TargetStock } from '@shared/stocks';

// 共有定義から再エクスポート（Home.tsx が直接インポートできるように）
export const REAL_STOCKS = TARGET_STOCKS.map((s) => ({
  symbol: s.ticker,
  name: s.name,
  basePrice: s.basePrice,
}));

export type RealStock = { symbol: string; name: string; basePrice: number };

// ---------- ヘルパー関数 ----------

/** 板情報のシミュレーション生成（現在値を基準に上下10本） */
function generateBoard(price: number): BoardData {
  const asks: BoardItem[] = [];
  const bids: BoardItem[] = [];
  const unit = price > 3000 ? 5 : price > 1000 ? 1 : 0.5;
  for (let i = 10; i >= 1; i--) {
    asks.push({
      price: Number((price + i * unit).toFixed(1)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'ask',
      isBest: i === 1,
    });
  }
  for (let i = 1; i <= 10; i++) {
    bids.push({
      price: Number((price - i * unit).toFixed(1)),
      volume: Math.floor(Math.random() * 4000) + 500,
      type: 'bid',
      isBest: i === 1,
    });
  }
  return {
    asks,
    bids,
    totalAskVolume: asks.reduce((a, x) => a + x.volume, 0),
    totalBidVolume: bids.reduce((a, x) => a + x.volume, 0),
  };
}

/** 歩み値のシミュレーション生成（最新価格を基準に直近15件） */
function generateTrades(price: number): TradeTick[] {
  const trades: TradeTick[] = [];
  const now = new Date();
  for (let i = 0; i < 15; i++) {
    const t = new Date(now.getTime() - i * 2000);
    const timeStr = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`;
    const tPrice = Number((price + (Math.random() - 0.5) * (price * 0.001)).toFixed(1));
    const volume = Math.floor(Math.random() * 1500) + 100;
    const sizeType: 'normal' | 'large' | 'huge' =
      volume >= 10000 ? 'huge' : volume >= 8000 ? 'large' : 'normal';
    trades.push({
      id: Math.random().toString(36).substring(2, 9),
      time: timeStr,
      timestamp: t.getTime(),
      price: tPrice,
      volume,
      changeType: Math.random() > 0.5 ? 'up' : 'down',
      sizeType,
    });
  }
  return trades;
}

/** サーバーから返ってきたローソク足データを CandleData 型に変換 */
function toCandle(c: {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ma5?: number | null;
  ma25?: number | null;
  rsi?: number | null;
  bbUpper?: number | null;
  bbMiddle?: number | null;
  bbLower?: number | null;
  signal?: { type: 'buy' | 'sell' | 'warn'; reason: string } | null;
}): CandleData {
  return {
    time: c.time,
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
    ma5: c.ma5 ?? undefined,
    ma25: c.ma25 ?? undefined,
    rsi: c.rsi ?? undefined,
    bbUpper: c.bbUpper ?? undefined,
    bbMiddle: c.bbMiddle ?? undefined,
    bbLower: c.bbLower ?? undefined,
    signals: c.signal ? [{ type: c.signal.type, reason: c.signal.reason }] : undefined,
  };
}

/** JST での現在時刻が市場時間内かどうかを判定（平日 9:00〜15:30） */
function isJSTMarketOpen(): boolean {
  const now = new Date();
  const jstOffset = 9 * 60; // 分
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const jstMinutes = (utcMinutes + jstOffset) % (24 * 60);
  const jstDay = new Date(now.getTime() + jstOffset * 60 * 1000).getUTCDay(); // 0=日, 6=土
  if (jstDay === 0 || jstDay === 6) return false; // 土日
  const openMin = 9 * 60;        // 9:00
  const closeMin = 15 * 60 + 30; // 15:30
  return jstMinutes >= openMin && jstMinutes < closeMin;
}

/** 寄り付き前後（平日 8:50〜9:15）かどうか。この帯は更新頻度を上げる。 */
function isNearOpenBell(): boolean {
  const now = new Date();
  const jstOffset = 9 * 60;
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const jstMinutes = (utcMinutes + jstOffset) % (24 * 60);
  const jstDay = new Date(now.getTime() + jstOffset * 60 * 1000).getUTCDay();
  if (jstDay === 0 || jstDay === 6) return false;
  // 8:50 = 530分, 9:15 = 555分
  return jstMinutes >= 530 && jstMinutes <= 555;
}

// ---------- フック本体 ----------

interface UseRealMarketDataProps {
  selectedStock: RealStock;
  rsiThresholdUpper: number;
  rsiThresholdLower: number;
  largeTradeVolume: number;
  soundEnabled: boolean;
  onAlert: (alert: AlertLog) => void;
}

export function useRealMarketData({
  selectedStock,
  rsiThresholdUpper,
  rsiThresholdLower,
  largeTradeVolume,
  soundEnabled,
  onAlert,
}: UseRealMarketDataProps) {
  const [isPaused, setIsEnabled] = useState(false);
  const [isMarketClosed, setIsMarketClosed] = useState(!isJSTMarketOpen());
  const prevCandleCountRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);

  // 市場時間チェック（1分ごと）
  useEffect(() => {
    const check = () => setIsMarketClosed(!isJSTMarketOpen());
    check();
    const id = setInterval(check, 60_000);
    return () => clearInterval(id);
  }, []);

  // 音声ビープ
  const playBeep = (type: 'buy' | 'sell' | 'warning') => {
    if (!soundEnabled) return;
    try {
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = type === 'buy' ? 880 : type === 'sell' ? 440 : 660;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.35);
    } catch (e) {
      console.error('Audio beep failed', e);
    }
  };

  // Yahoo Finance からデータ取得
  // - 寄り付き前後（8:50〜9:15）: 20秒ごとに更新し、引け値→寄付への切り替わりを取りこぼさない
  // - 市場時間中（9:00〜15:30）: 1分ごと自動更新（1分足に追従）
  // - 市場時間外（夜間・土日）: 自動更新停止（手動更新のみ）
  const pollingInterval = isPaused || isMarketClosed
    ? false
    : (isNearOpenBell() ? 20_000 : 60_000);
  const { data, isLoading, error, dataUpdatedAt } = trpc.stockData.getStockChart.useQuery(
    {
      symbol: selectedStock.symbol,
      range: '1d',
      interval: '1m',
      rsiUpper: rsiThresholdUpper,
      rsiLower: rsiThresholdLower,
    },
    {
      refetchInterval: pollingInterval,
      staleTime: 15_000, // 古い表示を引きずらないよう短めに
      retry: 2,
      retryDelay: 5_000,
    }
  );

  // データを MarketState に変換
  const marketState = useMemo<MarketState | null>(() => {
    if (!data?.candles || data.candles.length === 0) return null;
    const candles = data.candles.map(toCandle);
    const currentPrice = data.currentPrice;
    const board = generateBoard(currentPrice);
    const trades = generateTrades(currentPrice);
    return {
      currentPrice,
      priceChange: data.priceChange,
      priceChangePercent: data.priceChangePercent,
      volume: data.volume,
      candles,
      board,
      trades,
    };
  }, [data]);

  // 新しいシグナルが来たらアラートを発火（キャンドル数が増えた時）
  useEffect(() => {
    if (!data?.signals || !data.candles) return;
    const currentCount = data.candles.length;
    if (prevCandleCountRef.current === 0) {
      // 初回ロード時はアラートを出さない
      prevCandleCountRef.current = currentCount;
      return;
    }
    if (currentCount <= prevCandleCountRef.current) return;
    prevCandleCountRef.current = currentCount;

    // 最新のシグナルのみアラートとして通知
    const latestSignals = data.signals.filter(
      (s) => s.timestamp > (Date.now() - 120_000) // 直近2分以内
    );
    latestSignals.forEach((sig) => {
      const isBuy = sig.type === 'buy';
      const isSell = sig.type === 'sell';
      const alert: AlertLog = {
        id: Math.random().toString(36).substring(2, 9),
        time: sig.time,
        symbol: selectedStock.symbol,
        type: isBuy ? 'ma_cross' : isSell ? 'ma_cross' : 'bollinger',
        signal: isBuy ? 'B' : isSell ? 'S' : 'W',
        title: isBuy
          ? '🌟 【買いシグナル】' + sig.reason
          : isSell
          ? '📉 【売りシグナル】' + sig.reason
          : '⚠️ 【警告】' + sig.reason,
        message: `${selectedStock.name} (${selectedStock.symbol}) 価格: ${sig.price.toFixed(1)}`,
        price: sig.price,
        timestamp: sig.timestamp,
      };
      playBeep(isBuy ? 'buy' : isSell ? 'sell' : 'warning');
      onAlert(alert);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dataUpdatedAt]);

  return {
    marketState,
    isPaused,
    setIsEnabled,
    isLoading,
    error,
    isMarketClosed,
    lastUpdated: dataUpdatedAt ? new Date(dataUpdatedAt) : null,
  };
}
