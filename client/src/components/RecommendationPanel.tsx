import React from 'react';
import { trpc } from '@/lib/trpc';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Target, TrendingUp, Loader2, Info, Crown } from 'lucide-react';

interface RecommendationPanelProps {
  /** 推奨銘柄をクリックしたときに監視銘柄を切り替えるコールバック（symbolは ".T" なしのコード） */
  onPickSymbol?: (symbol: string) => void;
  /** 現在監視中の銘柄コード（".T" なし）。ハイライト用 */
  activeSymbol?: string;
}

const RANK_STYLES = [
  { ring: 'border-yellow-500/50 bg-yellow-500/5', badge: 'bg-yellow-500 text-black', label: '1' },
  { ring: 'border-slate-400/40 bg-slate-400/5', badge: 'bg-slate-300 text-black', label: '2' },
  { ring: 'border-amber-700/40 bg-amber-700/5', badge: 'bg-amber-700 text-white', label: '3' },
];

export default function RecommendationPanel({ onPickSymbol, activeSymbol }: RecommendationPanelProps) {
  // 過去レポート（直近10営業日の調子）から本日の推奨銘柄トップ3を取得
  const { data, isLoading, error } = trpc.trading.getRecommendations.useQuery(
    { days: 10, topN: 3 },
    { staleTime: 5 * 60 * 1000 }
  );

  const recs = data?.recommendations ?? [];

  return (
    <Card className="border-border bg-card/60 backdrop-blur-sm">
      <CardHeader className="py-3 border-b border-border/50">
        <CardTitle className="text-xs font-extrabold flex items-center space-x-2">
          <Target className="w-4 h-4 text-primary" />
          <span>本日の推奨銘柄トップ3</span>
          <span className="text-[8px] bg-primary/20 text-primary px-1.5 py-0.5 rounded font-mono border border-primary/30">
            過去実績ベース
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="py-3 space-y-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground text-xs font-mono space-x-2">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>調子スコアを集計中...</span>
          </div>
        ) : error ? (
          <div className="text-[10px] text-destructive font-mono py-4 text-center">
            推奨の取得に失敗しました
          </div>
        ) : recs.length === 0 ? (
          <div className="text-[10px] text-muted-foreground py-4 text-center leading-relaxed">
            まだ十分な実績データがありません。
            <br />
            シミュレーションを数日分ためると、
            <br />
            調子の良い銘柄が表示されます。
          </div>
        ) : (
          <>
            {recs.map((r, i) => {
              const style = RANK_STYLES[i] ?? RANK_STYLES[2];
              const isActive = activeSymbol === r.symbol;
              return (
                <button
                  key={r.symbol}
                  onClick={() => onPickSymbol?.(r.symbol)}
                  className={`w-full text-left rounded-lg border p-2.5 transition-all duration-200 active:scale-[0.98] hover:brightness-110 ${style.ring} ${
                    isActive ? 'ring-1 ring-primary' : ''
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center space-x-2">
                      <span className={`w-5 h-5 rounded-full text-[10px] font-extrabold flex items-center justify-center ${style.badge}`}>
                        {style.label}
                      </span>
                      <div className="flex flex-col">
                        <span className="text-xs font-bold text-foreground leading-tight">
                          {r.name}
                        </span>
                        <span className="text-[9px] text-muted-foreground font-mono">
                          {r.symbol} ・ {r.sector}
                        </span>
                      </div>
                    </div>
                    {i === 0 && <Crown className="w-3.5 h-3.5 text-yellow-500" />}
                  </div>
                  <div className="flex items-center justify-between mt-1.5 pl-7">
                    <span className="text-[10px] text-emerald-400 font-mono font-bold flex items-center">
                      <TrendingUp className="w-3 h-3 mr-1" />
                      日平均 +{Math.round(r.avgDailyProfit).toLocaleString()}円
                    </span>
                    <span className="text-[10px] text-muted-foreground font-mono">
                      勝率 {(r.avgWinRate * 100).toFixed(0)}%
                    </span>
                  </div>
                </button>
              );
            })}
            <div className="bg-secondary/20 border border-border/50 rounded p-2 mt-1">
              <p className="text-[9px] text-muted-foreground leading-relaxed flex items-start">
                <Info className="w-3 h-3 mr-1 mt-0.5 flex-shrink-0 text-primary" />
                <span>
                  直近{data?.basedOnDays ?? 10}営業日のレポートから、調子が良く勝率の高い銘柄を業種分散しつつ選定しています。
                  <strong className="text-foreground">同時保有は最大3銘柄</strong>を推奨します（クリックで監視銘柄を切替）。
                </span>
              </p>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
