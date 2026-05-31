import React, { useState } from 'react';
import { CandleData } from '../types';
import { runBacktest, BacktestResult } from '../lib/backtest';
import {
  Play,
  TrendingUp,
  TrendingDown,
  Percent,
  CheckCircle2,
  XCircle,
  BarChart3,
  HelpCircle,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';

interface BacktestModalProps {
  candles: CandleData[];
  rsiUpper: number;
  rsiLower: number;
}

export default function BacktestModal({ candles, rsiUpper, rsiLower }: BacktestModalProps) {
  const [strategy, setStrategy] = useState<'ma_cross' | 'rsi' | 'bollinger'>('ma_cross');
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [isOpen, setIsOpen] = useState(false);

  const handleRunBacktest = () => {
    // 過去ローソク足データを用いてシミュレーション実行
    const backtestResult = runBacktest(candles, strategy, rsiUpper, rsiLower);
    setResult(backtestResult);
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => {
      setIsOpen(open);
      if (!open) setResult(null); // モーダルを閉じたら結果をリセット
    }}>
      <DialogTrigger asChild>
        <button className="flex items-center space-x-1.5 px-3 py-1.5 rounded text-xs font-bold bg-purple-500/10 text-purple-300 border border-purple-500/30 hover:bg-purple-500/20 transition-all duration-200">
          <BarChart3 className="w-3.5 h-3.5" />
          <span>過去検証（バックテスト）</span>
        </button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-[600px] bg-card border border-border text-foreground">
        <DialogHeader>
          <DialogTitle className="text-sm font-bold flex items-center space-x-2">
            <BarChart3 className="w-4 h-4 text-purple-400" />
            <span>簡易バックテストシミュレーター</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2 text-xs">
          {/* 戦略の選択 */}
          <div className="space-y-2">
            <label className="text-[11px] font-bold text-muted-foreground">1. 検証する売買ルール（戦略）を選択</label>
            <div className="grid grid-cols-3 gap-2">
              <button
                onClick={() => setStrategy('ma_cross')}
                className={`py-2 px-3 rounded border text-center font-bold transition-all ${
                  strategy === 'ma_cross'
                    ? 'bg-primary/20 border-primary text-primary-foreground'
                    : 'bg-secondary/40 border-border hover:bg-secondary/60'
                }`}
              >
                MAクロス (5/25)
              </button>
              <button
                onClick={() => setStrategy('rsi')}
                className={`py-2 px-3 rounded border text-center font-bold transition-all ${
                  strategy === 'rsi'
                    ? 'bg-primary/20 border-primary text-primary-foreground'
                    : 'bg-secondary/40 border-border hover:bg-secondary/60'
                }`}
              >
                RSI逆張り ({rsiLower}% / {rsiUpper}%)
              </button>
              <button
                onClick={() => setStrategy('bollinger')}
                className={`py-2 px-3 rounded border text-center font-bold transition-all ${
                  strategy === 'bollinger'
                    ? 'bg-primary/20 border-primary text-primary-foreground'
                    : 'bg-secondary/40 border-border hover:bg-secondary/60'
                }`}
              >
                ボリンジャーバンド (±2σ)
              </button>
            </div>
          </div>

          {/* 説明 */}
          <div className="bg-secondary/20 border border-border/50 rounded p-2.5 text-muted-foreground leading-relaxed text-[11px]">
            {strategy === 'ma_cross' && (
              <p>
                <strong>MAクロス戦略:</strong> 5MA（短期移動平均線）が25MA（長期移動平均線）を上抜けたら<strong>買いエントリー</strong>、下抜けたらポジションを<strong>決済（売り）</strong>します。トレンド追随型の王道ルールです。
              </p>
            )}
            {strategy === 'rsi' && (
              <p>
                <strong>RSI逆張り戦略:</strong> RSIが <strong>{rsiLower}% 以下</strong>に低下したら売られすぎからの反発を狙って<strong>買いエントリー</strong>、RSIが <strong>{rsiUpper}% 以上</strong>に上昇したら買われすぎと判断して<strong>決済（売り）</strong>します。レンジ相場で機能しやすいルールです。
              </p>
            )}
            {strategy === 'bollinger' && (
              <p>
                <strong>ボリンジャーバンド戦略:</strong> 株価がボリンジャーバンドの <strong>下限（-2σ）</strong> を下抜けから復帰した瞬間に<strong>買いエントリー</strong>、 <strong>上限（+2σ）</strong> に到達した瞬間に<strong>決済（売り）</strong>します。ボラティリティを考慮した逆張りルールです。
              </p>
            )}
          </div>

          {/* 実行ボタン */}
          <button
            onClick={handleRunBacktest}
            className="w-full py-2 rounded font-bold bg-primary text-primary-foreground hover:bg-primary/90 flex items-center justify-center space-x-1.5 transition-all text-xs"
          >
            <Play className="w-3.5 h-3.5 fill-current" />
            <span>過去 50 分のデータでバックテストを実行</span>
          </button>

          {/* 結果表示 */}
          {result && (
            <div className="space-y-3 pt-2 border-t border-border/50 animate-in fade-in slide-in-from-bottom-2 duration-200">
              <h4 className="font-bold text-foreground text-[11px]">📊 シミュレーション結果</h4>
              
              {/* パフォーマンスサマリー */}
              <div className="grid grid-cols-4 gap-2 text-center">
                <div className="bg-secondary/30 border border-border/50 rounded p-2">
                  <div className="text-muted-foreground text-[9px]">取引回数</div>
                  <div className="text-sm font-bold font-mono mt-0.5">{result.totalTrades} 回</div>
                </div>
                <div className="bg-secondary/30 border border-border/50 rounded p-2">
                  <div className="text-muted-foreground text-[9px]">勝率</div>
                  <div className="text-sm font-bold font-mono mt-0.5 text-destructive">{result.winRate}%</div>
                </div>
                <div className="bg-secondary/30 border border-border/50 rounded p-2">
                  <div className="text-muted-foreground text-[9px]">合計損益</div>
                  <div className={`text-sm font-bold font-mono mt-0.5 ${result.totalProfitPercent >= 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                    {result.totalProfitPercent >= 0 ? '+' : ''}{result.totalProfitPercent}%
                  </div>
                </div>
                <div className="bg-secondary/30 border border-border/50 rounded p-2">
                  <div className="text-muted-foreground text-[9px]">最大下落率</div>
                  <div className="text-sm font-bold font-mono mt-0.5 text-emerald-500">-{result.maxDrawdownPercent}%</div>
                </div>
              </div>

              {/* 取引履歴 */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-bold text-muted-foreground">詳細取引履歴</div>
                <div className="max-h-[150px] overflow-y-auto border border-border rounded divide-y divide-border/30">
                  {result.trades.length === 0 ? (
                    <div className="text-center py-6 text-muted-foreground">取引シグナルが発生しませんでした。</div>
                  ) : (
                    result.trades.map((trade, idx) => (
                      <div key={idx} className="p-2 flex items-center justify-between hover:bg-muted/10 transition-colors">
                        <div className="space-y-0.5">
                          <div className="flex items-center space-x-2">
                            <span className="font-bold text-foreground">ロング取引 #{idx + 1}</span>
                            <span className={`text-[9px] px-1 py-0.2 rounded font-sans flex items-center ${
                              trade.result === 'win' ? 'bg-destructive/15 text-destructive' : 'bg-emerald-500/15 text-emerald-400'
                            }`}>
                              {trade.result === 'win' ? (
                                <>
                                  <CheckCircle2 className="w-2.5 h-2.5 mr-0.5" />
                                  <span>利益</span>
                                </>
                              ) : (
                                <>
                                  <XCircle className="w-2.5 h-2.5 mr-0.5" />
                                  <span>損失</span>
                                </>
                              )}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground font-mono">
                            買: {trade.entryTime} ({trade.entryPrice.toFixed(1)}) → 売: {trade.exitTime} ({trade.exitPrice.toFixed(1)})
                          </div>
                        </div>
                        <div className={`font-mono font-bold text-right ${trade.profitPercent >= 0 ? 'text-destructive' : 'text-emerald-500'}`}>
                          {trade.profitPercent >= 0 ? '+' : ''}{trade.profitPercent}%
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
