import React, { useState, useCallback, useRef } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, TrendingUp, TrendingDown, Minus, Brain } from 'lucide-react';
import { trpc } from '@/lib/trpc';
import { MarketState, Stock } from '../types';
import { Streamdown } from 'streamdown';
import { AdvisorDiagnosis } from '../lib/advisor';

interface AIAdvisorPanelProps {
  marketState: MarketState | null;
  selectedStock: Stock;
  rsiUpper: number;
  rsiLower: number;
  // ルールベースの診断（既存）も受け取り、並列表示する
  ruleBasedDiagnosis: AdvisorDiagnosis | null;
}

export default function AIAdvisorPanel({
  marketState,
  selectedStock,
  rsiUpper,
  rsiLower,
  ruleBasedDiagnosis,
}: AIAdvisorPanelProps) {
  const [aiAnalysis, setAiAnalysis] = useState<string | null>(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<number | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastRequestRef = useRef<number>(0);

  const analyzeMarket = trpc.aiAnalysis.analyzeMarket.useMutation({
    onSuccess: (data) => {
      setAiAnalysis(data.analysis);
      setLastAnalyzedAt(data.timestamp);
      setIsAnalyzing(false);
      setError(null);
    },
    onError: (err) => {
      setError('AI分析に失敗しました。しばらくしてから再試行してください。');
      setIsAnalyzing(false);
      console.error('AI analysis error:', err);
    },
  });

  const handleAnalyze = useCallback(() => {
    if (!marketState || isAnalyzing) return;

    // 連続リクエスト防止（10秒以内の再リクエストはブロック）
    const now = Date.now();
    if (now - lastRequestRef.current < 10000) {
      return;
    }
    lastRequestRef.current = now;

    setIsAnalyzing(true);
    setError(null);

    analyzeMarket.mutate({
      symbol: selectedStock.symbol,
      stockName: selectedStock.name,
      currentPrice: marketState.currentPrice,
      priceChange: marketState.priceChange,
      priceChangePercent: marketState.priceChangePercent,
      volume: marketState.volume,
      candles: marketState.candles.map((c) => ({
        time: c.time,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume,
        ma5: c.ma5,
        ma25: c.ma25,
        rsi: c.rsi,
        bbUpper: c.bbUpper,
        bbMiddle: c.bbMiddle,
        bbLower: c.bbLower,
      })),
      board: {
        asks: marketState.board.asks.map((a) => ({ price: a.price, volume: a.volume, type: a.type })),
        bids: marketState.board.bids.map((b) => ({ price: b.price, volume: b.volume, type: b.type })),
        totalAskVolume: marketState.board.totalAskVolume,
        totalBidVolume: marketState.board.totalBidVolume,
      },
      trades: marketState.trades.slice(0, 30).map((t) => ({
        time: t.time,
        price: t.price,
        volume: t.volume,
        changeType: t.changeType,
        sizeType: t.sizeType,
      })),
      rsiUpper,
      rsiLower,
    });
  }, [marketState, isAnalyzing, selectedStock, rsiUpper, rsiLower, analyzeMarket]);

  // ルールベース診断のスコアバー表示
  const ruleScore = ruleBasedDiagnosis?.score ?? 0;
  const rulePercentage = ((ruleScore + 100) / 200) * 100;

  // 警告チェック（AI分析テキストに警告が含まれているか）
  const hasWarning = aiAnalysis?.includes('⚠️') || aiAnalysis?.includes('警告');

  const lastAnalyzedStr = lastAnalyzedAt
    ? new Date(lastAnalyzedAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : null;

  return (
    <div className={`border rounded-lg p-3.5 transition-all duration-300 ${
      hasWarning
        ? 'border-yellow-500/50 bg-yellow-950/20'
        : 'border-border bg-card/60'
    }`}>
      {/* ヘッダー */}
      <div className="flex items-center justify-between mb-3 select-none">
        <div className="flex items-center space-x-2">
          <Brain className="w-4 h-4 text-primary animate-pulse" />
          <h3 className="text-xs font-bold text-foreground">
            AI売買シグナル診断
            <span className="ml-2 text-[9px] bg-primary/20 text-primary px-1.5 py-0.5 rounded border border-primary/30 font-mono">
              LLM搭載
            </span>
          </h3>
        </div>
        <div className="flex items-center space-x-2">
          {lastAnalyzedStr && (
            <span className="text-[10px] text-muted-foreground font-mono">
              最終分析: {lastAnalyzedStr}
            </span>
          )}
          <button
            onClick={handleAnalyze}
            disabled={!marketState || isAnalyzing}
            className={`flex items-center space-x-1 px-2.5 py-1 rounded text-[10px] font-bold border transition-all duration-200 ${
              isAnalyzing
                ? 'bg-primary/10 text-primary border-primary/30 cursor-wait'
                : !marketState
                ? 'bg-muted text-muted-foreground border-border cursor-not-allowed'
                : 'bg-primary/10 text-primary border-primary/30 hover:bg-primary/20 active:scale-95'
            }`}
          >
            {isAnalyzing ? (
              <>
                <RefreshCw className="w-3 h-3 animate-spin" />
                <span>AI分析中...</span>
              </>
            ) : (
              <>
                <Sparkles className="w-3 h-3" />
                <span>AI分析を実行</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* ルールベース診断メーター（常時表示） */}
      {ruleBasedDiagnosis && (
        <div className="mb-3 pb-3 border-b border-border/40">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] text-muted-foreground font-bold">テクニカル指標スコア（自動計算）</span>
            <span className={`text-xs font-extrabold ${ruleBasedDiagnosis.colorClass}`}>
              {ruleBasedDiagnosis.label}
            </span>
          </div>
          <div className="relative h-3 bg-secondary/60 rounded-full overflow-hidden border border-border/50">
            <div className="absolute left-1/2 top-0 bottom-0 w-0.5 bg-border/80 z-10" />
            <div className="absolute inset-0 bg-gradient-to-r from-emerald-500/20 via-transparent to-destructive/20" />
            <div
              className="absolute top-0 bottom-0 w-1 bg-foreground shadow-[0_0_8px_rgba(255,255,255,0.8)] transition-all duration-500 ease-out z-20"
              style={{ left: `${rulePercentage}%` }}
            />
          </div>
          <div className="flex justify-between text-[9px] text-muted-foreground font-mono mt-0.5">
            <span>売り</span>
            <span>様子見</span>
            <span>買い</span>
          </div>
          {/* ルールベースの理由（折りたたみ） */}
          <div className="mt-1.5 space-y-0.5 max-h-[50px] overflow-y-auto">
            {ruleBasedDiagnosis.reason.slice(0, 2).map((r, i) => (
              <p key={i} className="text-[9px] text-muted-foreground leading-relaxed">
                {r}
              </p>
            ))}
          </div>
        </div>
      )}

      {/* AI分析結果エリア */}
      <div className="min-h-[80px]">
        {error && (
          <div className="flex items-center space-x-2 text-yellow-400 text-xs bg-yellow-950/30 border border-yellow-500/30 rounded p-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {isAnalyzing && !aiAnalysis && (
          <div className="flex flex-col items-center justify-center py-4 space-y-2">
            <div className="flex space-x-1">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="w-2 h-2 rounded-full bg-primary animate-bounce"
                  style={{ animationDelay: `${i * 150}ms` }}
                />
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground">
              チャート・板情報・歩み値をAIが読み解いています...
            </p>
          </div>
        )}

        {aiAnalysis && !isAnalyzing && (
          <div className={`rounded p-2.5 text-[11px] leading-relaxed ${
            hasWarning
              ? 'bg-yellow-950/30 border border-yellow-500/30'
              : 'bg-secondary/20 border border-border/40'
          }`}>
            <div className="flex items-center space-x-1.5 mb-1.5">
              <Brain className="w-3 h-3 text-primary shrink-0" />
              <span className="text-[10px] font-bold text-primary">AIアナリストの見解</span>
            </div>
            <div className="text-foreground">
              <Streamdown>{aiAnalysis}</Streamdown>
            </div>
          </div>
        )}

        {!aiAnalysis && !isAnalyzing && !error && (
          <div className="flex flex-col items-center justify-center py-4 space-y-2 text-center">
            <Brain className="w-8 h-8 text-muted-foreground/40" />
            <div>
              <p className="text-[11px] text-muted-foreground font-bold">AI分析が未実行です</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">
                「AI分析を実行」ボタンを押すと、チャート・板情報・歩み値を<br />
                AIが総合的に読み解いて売買判断を提示します
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
