import React, { useMemo } from 'react';
import { CandleData } from '../types';
import { BarChart2, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface VolumeAnalysisPanelProps {
  candles: CandleData[];
}

/**
 * 出来高分析パネル
 * Yahoo Finance の実出来高データのみを使用（架空データなし）
 * 直近5本平均 vs 前5本平均で出来高の急増/減少を可視化
 */
export default function VolumeAnalysisPanel({ candles }: VolumeAnalysisPanelProps) {
  const analysis = useMemo(() => {
    if (candles.length < 10) return null;
    const recent5 = candles.slice(-5);
    const prev5 = candles.slice(-10, -5);
    const recentAvg = recent5.reduce((s, c) => s + c.volume, 0) / 5;
    const prevAvg = prev5.reduce((s, c) => s + c.volume, 0) / 5;
    const ratio = prevAvg > 0 ? recentAvg / prevAvg : 1;
    const maxVol = Math.max(...candles.slice(-15).map(c => c.volume), 1);

    // トレンド判定
    let trend: 'surge' | 'rise' | 'flat' | 'decline' = 'flat';
    if (ratio >= 1.5) trend = 'surge';
    else if (ratio >= 1.15) trend = 'rise';
    else if (ratio < 0.7) trend = 'decline';

    return { recentAvg, prevAvg, ratio, maxVol, trend };
  }, [candles]);

  const trendInfo = useMemo(() => {
    if (!analysis) return { label: '計算中', color: 'text-muted-foreground', icon: Minus };
    switch (analysis.trend) {
      case 'surge':
        return { label: '出来高急増', color: 'text-destructive', icon: TrendingUp };
      case 'rise':
        return { label: '出来高増加', color: 'text-yellow-400', icon: TrendingUp };
      case 'decline':
        return { label: '出来高減少', color: 'text-emerald-400', icon: TrendingDown };
      default:
        return { label: '横ばい', color: 'text-muted-foreground', icon: Minus };
    }
  }, [analysis]);

  if (!analysis) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
        出来高データ収集中...
      </div>
    );
  }

  const TrendIcon = trendInfo.icon;
  const recent15 = candles.slice(-15);

  return (
    <div className="h-full flex flex-col space-y-2">
      {/* トレンドサマリー */}
      <div className="bg-secondary/30 border border-border/50 rounded p-2 space-y-1">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-muted-foreground font-bold">出来高トレンド</span>
          <span className={`text-[10px] font-bold flex items-center ${trendInfo.color}`}>
            <TrendIcon className="w-3 h-3 mr-1" />
            {trendInfo.label}
          </span>
        </div>
        <div className="flex items-center justify-between font-mono">
          <span className="text-[9px] text-muted-foreground">直近5本/前5本</span>
          <span className={`text-xs font-bold ${analysis.ratio >= 1 ? 'text-destructive' : 'text-emerald-400'}`}>
            {analysis.ratio.toFixed(2)}倍
          </span>
        </div>
        <div className="flex items-center justify-between font-mono">
          <span className="text-[9px] text-muted-foreground">直近平均</span>
          <span className="text-[10px] text-foreground">{Math.round(analysis.recentAvg).toLocaleString()}株</span>
        </div>
        <div className="flex items-center justify-between font-mono">
          <span className="text-[9px] text-muted-foreground">前期間平均</span>
          <span className="text-[10px] text-foreground">{Math.round(analysis.prevAvg).toLocaleString()}株</span>
        </div>
      </div>

      {/* 直近15本の出来高バー */}
      <div className="flex-1 bg-card border border-border/50 rounded p-2 overflow-hidden">
        <div className="text-[9px] text-muted-foreground font-bold mb-1.5 flex items-center">
          <BarChart2 className="w-3 h-3 mr-1" />
          直近15本の出来高（実データ）
        </div>
        <div className="space-y-0.5 max-h-[280px] overflow-y-auto pr-1">
          {recent15.slice().reverse().map((c, idx) => {
            const widthPct = (c.volume / analysis.maxVol) * 100;
            const isUp = c.close >= c.open;
            return (
              <div key={`${c.time}-${idx}`} className="flex items-center text-[9px] font-mono space-x-1.5">
                <span className="w-9 text-muted-foreground shrink-0">{c.time}</span>
                <div className="flex-1 h-3 bg-secondary/20 rounded-sm relative overflow-hidden">
                  <div
                    className={`h-full ${isUp ? 'bg-destructive/60' : 'bg-emerald-500/60'} rounded-sm transition-all`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span className={`w-14 text-right shrink-0 ${isUp ? 'text-destructive' : 'text-emerald-400'}`}>
                  {c.volume.toLocaleString()}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
