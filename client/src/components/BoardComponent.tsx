import React, { useEffect, useState } from 'react';
import { BoardData, BoardItem } from '../types';

interface BoardComponentProps {
  data: BoardData;
  currentPrice: number;
}

export default function BoardComponent({ data, currentPrice }: BoardComponentProps) {
  // ピコピコ動くアニメーション用のステート管理
  const [highlightedPrices, setHighlightedPrices] = useState<Record<number, 'ask' | 'bid'>>({});

  useEffect(() => {
    // 最新の気配値データが来た際、価格の出来高変動を検知して一時的にハイライトする
    const newHighlights: Record<number, 'ask' | 'bid'> = {};
    
    data.asks.forEach((ask) => {
      if (Math.random() < 0.4) {
        newHighlights[ask.price] = 'ask';
      }
    });

    data.bids.forEach((bid) => {
      if (Math.random() < 0.4) {
        newHighlights[bid.price] = 'bid';
      }
    });

    setHighlightedPrices(newHighlights);

    const timer = setTimeout(() => {
      setHighlightedPrices({});
    }, 300);

    return () => clearTimeout(timer);
  }, [data]);

  // 最大出来高を基準に、板のバーの長さを計算
  const maxVolume = Math.max(
    ...data.asks.map((a) => a.volume),
    ...data.bids.map((b) => b.volume),
    1
  );

  return (
    <div className="flex flex-col h-full bg-background border border-border text-xs font-mono select-none">
      {/* 板情報ヘッダー */}
      <div className="grid grid-cols-3 text-center font-bold bg-muted/50 border-b border-border py-1 text-[10px] text-muted-foreground">
        <div>売注文数</div>
        <div>気配値</div>
        <div>買注文数</div>
      </div>

      {/* 板のメインスクロール領域 */}
      <div className="flex-1 flex flex-col justify-between py-1 overflow-y-auto min-h-[300px]">
        {/* 売り気配値 (asks) - 高い順に上から並ぶ */}
        <div className="flex flex-col flex-1 justify-end">
          {data.asks.map((ask) => {
            const widthPercent = (ask.volume / maxVolume) * 100;
            const isHighlighted = highlightedPrices[ask.price] === 'ask';
            
            return (
              <div
                key={`ask-${ask.price}`}
                className={`grid grid-cols-3 py-0.5 relative items-center transition-colors duration-200 ${
                  isHighlighted ? 'bg-emerald-500/10' : 'hover:bg-muted/20'
                }`}
              >
                {/* 売り注文ボリュームバー */}
                <div className="absolute left-0 top-0 bottom-0 bg-emerald-500/10 transition-all duration-300" style={{ width: `${widthPercent / 2}%` }} />
                
                {/* 注文数 */}
                <div className="text-left pl-2 text-emerald-400 z-10 font-bold">
                  {ask.volume.toLocaleString()}
                </div>

                {/* 気配価格 */}
                <div className="text-center text-emerald-400 font-bold z-10">
                  {ask.price.toFixed(1)}
                </div>

                {/* 空白 (買側) */}
                <div />
              </div>
            );
          })}
        </div>

        {/* 現在値表示スプレッド（仕切り線） */}
        <div className="grid grid-cols-3 py-1 bg-muted/30 border-y border-border/50 items-center font-bold">
          <div className="text-[10px] text-muted-foreground pl-2">ASK計: {data.totalAskVolume.toLocaleString()}</div>
          <div className="text-center text-sm text-foreground animate-pulse">
            {currentPrice.toFixed(1)}
          </div>
          <div className="text-[10px] text-muted-foreground text-right pr-2">BID計: {data.totalBidVolume.toLocaleString()}</div>
        </div>

        {/* 買い気配値 (bids) - 安い順に下へ並ぶ */}
        <div className="flex flex-col flex-1 justify-start">
          {data.bids.map((bid) => {
            const widthPercent = (bid.volume / maxVolume) * 100;
            const isHighlighted = highlightedPrices[bid.price] === 'bid';

            return (
              <div
                key={`bid-${bid.price}`}
                className={`grid grid-cols-3 py-0.5 relative items-center transition-colors duration-200 ${
                  isHighlighted ? 'bg-destructive/10' : 'hover:bg-muted/20'
                }`}
              >
                {/* 空白 (売側) */}
                <div />

                {/* 気配価格 */}
                <div className="text-center text-destructive font-bold z-10">
                  {bid.price.toFixed(1)}
                </div>

                {/* 買い注文ボリュームバー */}
                <div className="absolute right-0 top-0 bottom-0 bg-destructive/10 transition-all duration-300" style={{ width: `${widthPercent / 2}%` }} />

                {/* 注文数 */}
                <div className="text-right pr-2 text-destructive z-10 font-bold">
                  {bid.volume.toLocaleString()}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
