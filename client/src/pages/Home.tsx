import React, { useState, useCallback, useMemo } from 'react';
import { Link } from 'wouter';
import { useRealMarketData, REAL_STOCKS, RealStock } from '../hooks/useRealMarketData';
import { AlertLog, CandleData } from '../types';
import ChartComponent from '../components/ChartComponent';
import BoardComponent from '../components/BoardComponent';
import TradeHistoryComponent from '../components/TradeHistoryComponent';
import AlertHistoryComponent from '../components/AlertHistoryComponent';
import BacktestModal from '../components/BacktestModal';
import AIAdvisorPanel from '../components/AIAdvisorPanel';
import DailyReportModal from '../components/DailyReportModal';
import { diagnoseMarket } from '../lib/advisor';
import { toast } from 'sonner';
import {
  Volume2,
  VolumeX,
  TrendingUp,
  TrendingDown,
  Sliders,
  Settings2,
  Info,
  LineChart,
  Grid3X3,
  History,
  Activity,
  BarChart2,
  AlertTriangle,
  RefreshCw,
  WifiOff,
  Clock,
  Loader2,
} from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

export default function Home() {
  // ---- ステート ----
  // 実銘柄リストから初期銘柄を選択
  const [selectedStock, setSelectedStock] = useState<RealStock>(REAL_STOCKS[0]);
  const [rsiUpper, setRsiUpper] = useState<number>(70);
  const [rsiLower, setRsiLower] = useState<number>(30);
  const [largeVolume, setLargeVolume] = useState<number>(8000);
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [alerts, setAlerts] = useState<AlertLog[]>([]);
  const [selectedCandle, setSelectedCandle] = useState<CandleData | null>(null);

  // ---- アラートハンドラ ----
  const handleAlert = useCallback((alert: AlertLog) => {
    setAlerts((prev) => [alert, ...prev].slice(0, 100));
    const isWarning = alert.signal === 'W';
    const isBuy = alert.signal === 'B';
    toast(alert.title, {
      description: alert.message,
      duration: 2500,
      className: isWarning
        ? 'border-yellow-500/50 bg-yellow-950/90 text-yellow-200 font-sans'
        : isBuy
        ? 'border-destructive/50 bg-red-950/90 text-red-200 font-sans'
        : 'border-emerald-500/50 bg-emerald-950/90 text-emerald-200 font-sans',
    });
  }, []);

  // ---- Yahoo Finance 実データフック（1分ごと自動更新） ----
  const {
    marketState,
    isPaused,
    setIsEnabled,
    isLoading,
    error,
    isMarketClosed,
    lastUpdated,
  } = useRealMarketData({
    selectedStock,
    rsiThresholdUpper: rsiUpper,
    rsiThresholdLower: rsiLower,
    largeTradeVolume: largeVolume,
    soundEnabled,
    onAlert: handleAlert,
  });

  // ---- 表示スタイル計算 ----
  const isPriceUp = marketState ? marketState.priceChange >= 0 : true;
  const priceColorClass = isPriceUp ? 'text-destructive' : 'text-emerald-500';

  // ---- ルールベース診断 ----
  const marketDiagnosis = useMemo(() => {
    if (!marketState) return null;
    return diagnoseMarket(
      marketState.candles,
      marketState.trades,
      rsiUpper,
      rsiLower,
      marketState.board.totalAskVolume,
      marketState.board.totalBidVolume
    );
  }, [marketState, rsiUpper, rsiLower]);

  // ---- アラートクリック ----
  const handleSelectAlert = (alert: AlertLog) => {
    toast.info(`アラート参照`, {
      description: `${alert.time} [${alert.symbol}] ${alert.title} (価格: ${alert.price.toFixed(1)})`,
    });
  };

  // ---- 最終更新時刻の表示 ----
  const lastUpdatedStr = lastUpdated
    ? `${String(lastUpdated.getHours()).padStart(2, '0')}:${String(lastUpdated.getMinutes()).padStart(2, '0')}:${String(lastUpdated.getSeconds()).padStart(2, '0')}`
    : '--:--:--';

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">

      {/* ===== ヘッダー ===== */}
      <header className="border-b border-border bg-card/50 backdrop-blur-sm sticky top-0 z-40 px-4 py-2 flex flex-wrap items-center justify-between gap-4">

        {/* 左側：ロゴ ＆ 銘柄選択 */}
        <div className="flex items-center space-x-4">
          <div className="flex items-center space-x-2">
            <div className="w-7 h-7 bg-destructive rounded flex items-center justify-center font-bold text-white text-sm tracking-wider animate-pulse">
              SBI
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-tight text-foreground flex items-center">
                リアルタイム株価アラート ＆ 分析
                <span className="text-[9px] bg-primary/20 text-primary px-1.5 py-0.2 rounded ml-2 font-mono border border-primary/30">PRO</span>
              </h1>
              <p className="text-[10px] text-muted-foreground">
                Yahoo Finance 実データ ＆ AI シグナル検知
              </p>
            </div>
          </div>

          {/* 銘柄セレクター（実銘柄リスト） */}
          <div className="flex items-center space-x-1.5">
            <span className="text-[10px] text-muted-foreground font-bold">監視銘柄:</span>
            <select
              value={selectedStock.symbol}
              onChange={(e) => {
                const stock = REAL_STOCKS.find((s) => s.symbol === e.target.value);
                if (stock) {
                  setSelectedStock(stock);
                  setAlerts([]);
                  setSelectedCandle(null);
                }
              }}
              className="bg-secondary/80 border border-border text-xs rounded px-2.5 py-1 font-bold text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {REAL_STOCKS.map((stock) => (
                <option key={stock.symbol} value={stock.symbol}>
                  {stock.symbol.replace('.T', '')} - {stock.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 中央：現在値ボード */}
        <div className="flex items-center space-x-4">
          {/* 市場時間外バッジ */}
          {isMarketClosed && (
            <div className="flex items-center space-x-1 bg-yellow-500/10 border border-yellow-500/30 text-yellow-400 text-[10px] font-bold px-2 py-1 rounded">
              <Clock className="w-3 h-3" />
              <span>市場時間外</span>
            </div>
          )}

          {/* ローディング中 */}
          {isLoading && !marketState && (
            <div className="flex items-center space-x-1.5 text-muted-foreground text-xs font-mono">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>データ取得中...</span>
            </div>
          )}

          {/* エラー */}
          {error && !marketState && (
            <div className="flex items-center space-x-1.5 text-destructive text-xs font-mono">
              <WifiOff className="w-3.5 h-3.5" />
              <span>データ取得失敗</span>
            </div>
          )}

          {/* 現在値表示 */}
          {marketState && (
            <div className="flex items-center space-x-5 bg-secondary/30 border border-border/50 px-4 py-1 rounded font-mono">
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground font-bold">現在値</span>
                <span className={`text-base font-extrabold tracking-tight ${priceColorClass}`}>
                  {marketState.currentPrice.toFixed(1)}
                </span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground font-bold">前日比</span>
                <span className={`text-xs font-bold ${priceColorClass}`}>
                  {isPriceUp ? '+' : ''}{marketState.priceChange.toFixed(1)}{' '}
                  ({isPriceUp ? '+' : ''}{marketState.priceChangePercent}%)
                </span>
              </div>
              <div className="flex-col hidden sm:flex">
                <span className="text-[9px] text-muted-foreground font-bold">累計出来高</span>
                <span className="text-xs font-bold text-yellow-500/90">
                  {marketState.volume.toLocaleString()} 株
                </span>
              </div>
              <div className="flex-col hidden md:flex">
                <span className="text-[9px] text-muted-foreground font-bold">最終更新</span>
                <span className="text-[10px] text-emerald-400 font-bold flex items-center">
                  {isLoading
                    ? <><Loader2 className="w-2.5 h-2.5 animate-spin mr-1" />更新中</>
                    : <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />{lastUpdatedStr}</>
                  }
                </span>
              </div>
            </div>
          )}
        </div>

        {/* 右側：コントロール */}
        <div className="flex items-center space-x-3">
          <DailyReportModal rsiUpper={rsiUpper} rsiLower={rsiLower} />

          <Link href="/reports">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-secondary/50 text-muted-foreground border-border/50 hover:bg-secondary hover:text-foreground">
              <History className="w-3.5 h-3.5" />
              <span>レポート履歴</span>
            </button>
          </Link>

          <Link href="/algorithm">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-secondary/50 text-muted-foreground border-border/50 hover:bg-secondary hover:text-foreground">
              <Settings2 className="w-3.5 h-3.5" />
              <span>アルゴリズム</span>
            </button>
          </Link>

          <Link href="/chart">
            <button className="flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">
              <BarChart2 className="w-3.5 h-3.5" />
              <span>詳細チャート</span>
            </button>
          </Link>

          {/* バックテスト */}
          {marketState && (
            <BacktestModal
              candles={marketState.candles}
              rsiUpper={rsiUpper}
              rsiLower={rsiLower}
            />
          )}

          {/* 一時停止/再開 */}
          <button
            onClick={() => setIsEnabled(!isPaused)}
            className={`flex items-center space-x-1 px-3 py-1 rounded text-xs font-bold transition-all duration-200 border ${
              isPaused
                ? 'bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20'
                : 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
            }`}
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isPaused ? '' : 'animate-spin'} [animation-duration:3s]`} />
            <span>{isPaused ? '更新再開' : '自動更新中'}</span>
          </button>

          {/* 音声 ON/OFF */}
          <button
            onClick={() => setSoundEnabled(!soundEnabled)}
            className={`p-1.5 rounded border transition-colors ${
              soundEnabled
                ? 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20'
                : 'bg-muted text-muted-foreground border-border hover:bg-muted/80'
            }`}
            title={soundEnabled ? 'アラート音: ON' : 'アラート音: OFF'}
          >
            {soundEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* ===== メインダッシュボード ===== */}
      <main className="flex-1 p-4 grid grid-cols-1 xl:grid-cols-12 gap-4">

        {/* 左側＆中央：チャート・板情報・歩み値 (9カラム) */}
        <div className="xl:col-span-9 flex flex-col space-y-4">

          {/* AI アドバイザーパネル */}
          <div className="w-full">
            <AIAdvisorPanel
              marketState={marketState}
              selectedStock={{ symbol: selectedStock.symbol, name: selectedStock.name, basePrice: selectedStock.basePrice }}
              rsiUpper={rsiUpper}
              rsiLower={rsiLower}
              ruleBasedDiagnosis={marketDiagnosis}
            />
          </div>

          {/* チャート(6) ＋ 板情報(3) ＋ 歩み値(3) */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">

            {/* チャート */}
            <div className="lg:col-span-6 flex flex-col bg-card border border-border rounded-lg p-3 relative overflow-hidden">
              <div className="flex items-center justify-between mb-2 select-none">
                <div className="flex items-center space-x-2">
                  <LineChart className="w-4 h-4 text-primary" />
                  <h2 className="text-xs font-bold text-foreground">
                    リアルタイムチャート (1分足)
                    <span className="ml-2 text-[9px] text-emerald-400 font-mono">
                      Yahoo Finance 実データ
                    </span>
                  </h2>
                </div>
                {selectedCandle && (
                  <div className="text-[10px] font-mono text-muted-foreground bg-secondary/50 px-2 py-0.5 rounded">
                    選択中: <span className="text-foreground font-bold">{selectedCandle.time}</span>{' '}
                    | 終値: <span className="text-foreground font-bold">{selectedCandle.close.toFixed(1)}</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-h-[400px]">
                {isLoading && !marketState ? (
                  <div className="h-full flex flex-col items-center justify-center text-muted-foreground text-xs font-mono space-y-2">
                    <Loader2 className="w-6 h-6 animate-spin text-primary" />
                    <span>Yahoo Finance からデータ取得中...</span>
                  </div>
                ) : error && !marketState ? (
                  <div className="h-full flex flex-col items-center justify-center text-destructive text-xs font-mono space-y-2">
                    <WifiOff className="w-6 h-6" />
                    <span>データ取得に失敗しました</span>
                    <span className="text-muted-foreground text-[10px]">市場時間外または通信エラーの可能性があります</span>
                  </div>
                ) : marketState ? (
                  <ChartComponent
                    data={marketState.candles}
                    selectedCandle={selectedCandle}
                    onSelectCandle={setSelectedCandle}
                  />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    チャート初期化中...
                  </div>
                )}
              </div>
            </div>

            {/* 板情報 */}
            <div className="lg:col-span-3 flex flex-col bg-card border border-border rounded-lg p-3 overflow-hidden">
              <div className="flex items-center space-x-2 mb-2 select-none">
                <Grid3X3 className="w-4 h-4 text-emerald-400" />
                <h2 className="text-xs font-bold text-foreground">板情報 (シミュレーション)</h2>
              </div>
              <div className="flex-1">
                {marketState ? (
                  <BoardComponent data={marketState.board} currentPrice={marketState.currentPrice} />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    板情報ロード中...
                  </div>
                )}
              </div>
            </div>

            {/* 歩み値 */}
            <div className="lg:col-span-3 flex flex-col bg-card border border-border rounded-lg p-3 overflow-hidden">
              <div className="flex items-center space-x-2 mb-2 select-none">
                <Activity className="w-4 h-4 text-destructive" />
                <h2 className="text-xs font-bold text-foreground">歩み値 (シミュレーション)</h2>
              </div>
              <div className="flex-1">
                {marketState ? (
                  <TradeHistoryComponent trades={marketState.trades} />
                ) : (
                  <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
                    歩み値ロード中...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* アラートログ */}
          <div className="flex-1">
            <AlertHistoryComponent alerts={alerts} onSelectAlert={handleSelectAlert} />
          </div>
        </div>

        {/* 右側：パラメータ設定 (3カラム) */}
        <div className="xl:col-span-3 flex flex-col space-y-4">
          <Card className="border-border bg-card/60 backdrop-blur-sm h-full">
            <CardHeader className="py-3 border-b border-border/50">
              <CardTitle className="text-xs font-extrabold flex items-center space-x-2">
                <Sliders className="w-4 h-4 text-primary" />
                <span>アラート感度 ＆ パラメータ設定</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="py-4 space-y-6">

              {/* RSI 買われすぎ */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingUp className="w-3.5 h-3.5 text-purple-400" />
                    <span>RSI 買われすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-purple-400">{rsiUpper}% 以上</span>
                </div>
                <Slider
                  defaultValue={[rsiUpper]}
                  max={90}
                  min={65}
                  step={1}
                  onValueChange={(val) => setRsiUpper(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの数値を超えると、高値警戒として売り(S)シグナルを検知します。
                </p>
              </div>

              {/* RSI 売られすぎ */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <TrendingDown className="w-3.5 h-3.5 text-emerald-400" />
                    <span>RSI 売られすぎ閾値</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-emerald-400">{rsiLower}% 以下</span>
                </div>
                <Slider
                  defaultValue={[rsiLower]}
                  max={35}
                  min={10}
                  step={1}
                  onValueChange={(val) => setRsiLower(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  RSIがこの数値を下回ると、底値反発狙いとして買い(B)シグナルを検知します。
                </p>
              </div>

              <hr className="border-border/50" />

              {/* 大口監視 */}
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[11px] font-bold text-muted-foreground flex items-center space-x-1.5">
                    <AlertTriangle className="w-3.5 h-3.5 text-pink-400" />
                    <span>大口判定の基準出来高</span>
                  </label>
                  <span className="text-xs font-mono font-bold text-pink-400">
                    {largeVolume.toLocaleString()} 株以上
                  </span>
                </div>
                <Slider
                  defaultValue={[largeVolume]}
                  max={15000}
                  min={5000}
                  step={500}
                  onValueChange={(val) => setLargeVolume(val[0])}
                  className="py-1"
                />
                <p className="text-[10px] text-muted-foreground">
                  1取引あたりの出来高がこの基準を超えると、歩み値上で大口(ピンク)としてマークされます。
                </p>
              </div>

              <hr className="border-border/50" />

              {/* データソース説明 */}
              <div className="bg-secondary/20 border border-border/50 rounded p-3 space-y-2">
                <h4 className="text-[10px] font-bold text-foreground flex items-center">
                  <Info className="w-3.5 h-3.5 mr-1.5 text-primary" />
                  データソースについて
                </h4>
                <ul className="text-[9px] text-muted-foreground space-y-1.5 list-disc pl-3">
                  <li>
                    <strong className="text-foreground">チャート</strong>: Yahoo Finance から1分足の実データを取得。1分ごとに自動更新。
                  </li>
                  <li>
                    <strong className="text-foreground">板情報・歩み値</strong>: 現在値を基準にしたシミュレーション（Yahoo Finance では取得不可）。
                  </li>
                  <li>
                    <strong className="text-foreground">シグナル検知</strong>: MA5/MA25クロス、RSI、ボリンジャーバンドを実データで計算。
                  </li>
                  <li>
                    <strong className="text-foreground">架空取引</strong>: 毎平日 JST 15:30 に自動シミュレーション実行。実際の注文は行いません。
                  </li>
                </ul>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>

      {/* ===== フッター ===== */}
      <footer className="border-t border-border bg-card/30 px-4 py-2 flex items-center justify-between text-[10px] text-muted-foreground font-mono select-none">
        <div>
          <span>PRO-TERMINAL v2.0.0</span>
          <span className="mx-2">|</span>
          <span className="text-emerald-400">データソース: Yahoo Finance 実データ (1分足)</span>
          <span className="mx-2">|</span>
          <span>板情報・歩み値: シミュレーション</span>
        </div>
        <div className="flex items-center space-x-4">
          <span className="flex items-center">
            {isMarketClosed
              ? <><Clock className="w-2.5 h-2.5 mr-1 text-yellow-400" /><span className="text-yellow-400">市場時間外</span></>
              : <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 mr-1.5 animate-pulse" />市場接続中</>
            }
          </span>
          <span>最終更新: {lastUpdatedStr}</span>
        </div>
      </footer>
    </div>
  );
}
