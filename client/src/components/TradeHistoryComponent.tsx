import React from 'react';
import { TradeTick } from '../types';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';

interface TradeHistoryComponentProps {
  trades: TradeTick[];
}

export default function TradeHistoryComponent({ trades }: TradeHistoryComponentProps) {
  // 歩み値の出来高サイズ（一般、大口、超大口）に応じたテキスト・背景色のスタイルを決定
  const getTradeStyle = (tick: TradeTick) => {
    switch (tick.sizeType) {
      case 'huge':
        // 超大口: ゴールド
        return {
          bg: 'bg-yellow-500/20 border border-yellow-500/40 animate-pulse',
          text: 'text-yellow-400 font-extrabold',
          badge: 'bg-yellow-500/30 text-yellow-300 border border-yellow-500/50',
          label: '超大口',
        };
      case 'large':
        // 大口: ピンク
        return {
          bg: 'bg-pink-500/10 border border-pink-500/20',
          text: 'text-pink-400 font-bold',
          badge: 'bg-pink-500/20 text-pink-300 border border-pink-500/30',
          label: '大口',
        };
      default:
        // 一般: 白・グレー
        return {
          bg: 'hover:bg-muted/10',
          text: 'text-foreground',
          badge: 'bg-muted/30 text-muted-foreground',
          label: '一般',
        };
    }
  };

  return (
    <div className="flex flex-col h-full bg-background border border-border text-xs font-mono">
      {/* ヘッダー */}
      <div className="grid grid-cols-4 text-center font-bold bg-muted/50 border-b border-border py-1 text-[10px] text-muted-foreground select-none">
        <div>時刻</div>
        <div>価格</div>
        <div>数量 (株)</div>
        <div>属性</div>
      </div>

      {/* 歩み値のリスト（最新が上） */}
      <div className="flex-1 overflow-y-auto min-h-[300px] divide-y divide-border/30">
        {trades.length === 0 ? (
          <div className="h-full flex items-center justify-center text-muted-foreground text-[11px] py-10">
            約定データ受信中...
          </div>
        ) : (
          trades.map((tick) => {
            const style = getTradeStyle(tick);
            const isUp = tick.changeType === 'up';
            const isDown = tick.changeType === 'down';

            return (
              <div
                key={tick.id}
                className={`grid grid-cols-4 py-1 text-center items-center transition-colors duration-150 ${style.bg}`}
              >
                {/* 時刻 */}
                <div className="text-muted-foreground text-[10px]">{tick.time}</div>

                {/* 価格 */}
                <div className="flex items-center justify-center font-bold">
                  <span className={isUp ? 'text-destructive' : isDown ? 'text-emerald-500' : 'text-foreground'}>
                    {tick.price.toFixed(1)}
                  </span>
                  {isUp && <ArrowUp className="w-2.5 h-2.5 ml-0.5 text-destructive" />}
                  {isDown && <ArrowDown className="w-2.5 h-2.5 ml-0.5 text-emerald-500" />}
                  {!isUp && !isDown && <Minus className="w-2.5 h-2.5 ml-0.5 text-muted-foreground" />}
                </div>

                {/* 数量 */}
                <div className={`text-right pr-4 font-bold ${style.text}`}>
                  {tick.volume.toLocaleString()}
                </div>

                {/* 属性バッジ */}
                <div className="flex justify-center">
                  <span className={`text-[9px] px-1 py-0.2 rounded font-sans scale-90 ${style.badge}`}>
                    {style.label}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
