import React from 'react';
import { CandleData } from '../types';
import { Activity } from 'lucide-react';

interface CandleDetailPanelProps {
  candles: CandleData[];
}

/**
 * ローソク足詳細パネル
 * Yahoo Finance の実OHLCデータのみを使用（架空の歩み値ではない）
 * 直近10本のローソク足を表形式で表示
 */
export default function CandleDetailPanel({ candles }: CandleDetailPanelProps) {
  if (candles.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-muted-foreground text-xs font-mono">
        データ収集中...
      </div>
    );
  }

  const recent = candles.slice(-12).reverse();

  return (
    <div className="h-full flex flex-col">
      {/* テーブルヘッダ */}
      <div className="grid grid-cols-12 gap-1 text-[8.5px] text-muted-foreground font-bold py-1 px-1 border-b border-border/50 sticky top-0 bg-card">
        <span className="col-span-2">時刻</span>
        <span className="col-span-2 text-right">始値</span>
        <span className="col-span-2 text-right">高値</span>
        <span className="col-span-2 text-right">安値</span>
        <span className="col-span-2 text-right">終値</span>
        <span className="col-span-2 text-right">出来高</span>
      </div>

      {/* テーブル本体 */}
      <div className="flex-1 overflow-y-auto">
        {recent.map((c, idx) => {
          const isUp = c.close >= c.open;
          const colorClass = isUp ? 'text-destructive' : 'text-emerald-400';
          const range = c.high - c.low;
          const wickRatio = range > 0 ? Math.abs(c.close - c.open) / range : 0;
          const isLong = wickRatio >= 0.7; // 長い実体（強い動き）

          return (
            <div
              key={`${c.time}-${idx}`}
              className={`grid grid-cols-12 gap-1 text-[9px] font-mono py-0.5 px-1 border-b border-border/20 ${
                isLong ? 'bg-secondary/20' : ''
              }`}
            >
              <span className="col-span-2 text-muted-foreground">{c.time}</span>
              <span className="col-span-2 text-right text-foreground">{c.open.toFixed(0)}</span>
              <span className="col-span-2 text-right text-foreground">{c.high.toFixed(0)}</span>
              <span className="col-span-2 text-right text-foreground">{c.low.toFixed(0)}</span>
              <span className={`col-span-2 text-right font-bold ${colorClass}`}>
                {c.close.toFixed(0)}
              </span>
              <span className="col-span-2 text-right text-yellow-500/80">
                {c.volume >= 10000 ? `${(c.volume / 1000).toFixed(0)}k` : c.volume.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>

      {/* 凡例 */}
      <div className="text-[8.5px] text-muted-foreground font-mono p-1 border-t border-border/30 flex items-center space-x-2">
        <span className="flex items-center"><span className="w-2 h-2 bg-destructive/60 rounded-sm mr-1" />陽線</span>
        <span className="flex items-center"><span className="w-2 h-2 bg-emerald-500/60 rounded-sm mr-1" />陰線</span>
        <span className="flex items-center"><span className="w-2 h-2 bg-secondary/40 rounded-sm mr-1" />強い動き</span>
      </div>
    </div>
  );
}
