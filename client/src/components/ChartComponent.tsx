import React from 'react';
import {
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Area,
  Bar,
  Scatter,
} from 'recharts';
import { CandleData } from '../types';

interface ChartComponentProps {
  data: CandleData[];
  selectedCandle: CandleData | null;
  onSelectCandle: (candle: CandleData | null) => void;
}

// カスタムローソク足のレンダリング
const Candlestick = (props: any) => {
  const { x, y, open, close, high, low, width } = props;
  const isUp = close >= open;
  
  // 色の定義 (SBI証券風: 陽線=赤, 陰線=緑 or 陽線=赤, 陰線=青など。ここでは陽線=赤/ピンク系、陰線=緑/シアン系)
  // 日本の標準: 陽線 = 赤, 陰線 = 緑/青
  const fill = isUp ? 'oklch(0.65 0.18 15)' : 'oklch(0.6 0.18 140)';
  const stroke = fill;

  // 描画用の座標計算
  const candleWidth = Math.max(2, width - 2);
  const xOffset = x + (width - candleWidth) / 2;

  const openY = y + (1 - (open - props.yDomain[0]) / (props.yDomain[1] - props.yDomain[0])) * props.height;
  const closeY = y + (1 - (close - props.yDomain[0]) / (props.yDomain[1] - props.yDomain[0])) * props.height;
  const highY = y + (1 - (high - props.yDomain[0]) / (props.yDomain[1] - props.yDomain[0])) * props.height;
  const lowY = y + (1 - (low - props.yDomain[0]) / (props.yDomain[1] - props.yDomain[0])) * props.height;

  const top = Math.min(openY, closeY);
  const bottom = Math.max(openY, closeY);
  const bodyHeight = Math.max(1, bottom - top);

  return (
    <g>
      {/* 芯 (影) */}
      <line
        x1={xOffset + candleWidth / 2}
        y1={highY}
        x2={xOffset + candleWidth / 2}
        y2={lowY}
        stroke={stroke}
        strokeWidth={1.5}
      />
      {/* 実体 */}
      <rect
        x={xOffset}
        y={top}
        width={candleWidth}
        height={bodyHeight}
        fill={fill}
        stroke={stroke}
        strokeWidth={1}
      />
      
      {/* 売り買いのシグナルマーク表示 */}
      {props.signals && props.signals.map((sig: any, index: number) => {
        const isBuy = sig.type === 'buy';
        const markerY = isBuy ? lowY + 12 : highY - 12;
        const markerColor = isBuy ? 'oklch(0.55 0.18 25)' : 'oklch(0.65 0.18 140)'; // 買い=赤, 売り=緑
        const label = isBuy ? 'B' : 'S';

        return (
          <g key={index} className="animate-bounce">
            {/* 三角矢印 */}
            <path
              d={isBuy ? `M ${xOffset + candleWidth/2} ${lowY + 5} L ${xOffset + candleWidth/2 - 4} ${lowY + 12} L ${xOffset + candleWidth/2 + 4} ${lowY + 12} Z` : `M ${xOffset + candleWidth/2} ${highY - 5} L ${xOffset + candleWidth/2 - 4} ${highY - 12} L ${xOffset + candleWidth/2 + 4} ${highY - 12} Z`}
              fill={markerColor}
            />
            {/* B / S テキスト */}
            <text
              x={xOffset + candleWidth / 2}
              y={isBuy ? lowY + 22 : highY - 16}
              fill={markerColor}
              fontSize="9px"
              fontWeight="bold"
              textAnchor="middle"
              className="font-mono"
            >
              {label}
            </text>
          </g>
        );
      })}
    </g>
  );
};

export default function ChartComponent({ data, selectedCandle, onSelectCandle }: ChartComponentProps) {
  // チャートのY軸表示範囲を自動調整するための最小・最大値計算
  const activeCandles = data.slice(-40); // 直近40本を表示
  
  const minPrice = Math.min(...activeCandles.map((c) => {
    const vals = [c.low, c.ma5, c.ma25, c.bbLower].filter((v) => v !== undefined) as number[];
    return Math.min(...vals);
  }));
  const maxPrice = Math.max(...activeCandles.map((c) => {
    const vals = [c.high, c.ma5, c.ma25, c.bbUpper].filter((v) => v !== undefined) as number[];
    return Math.max(...vals);
  }));

  // マージンを持たせる
  const priceMargin = (maxPrice - minPrice) * 0.1 || 5;
  const yDomain = [
    Number((minPrice - priceMargin).toFixed(1)),
    Number((maxPrice + priceMargin).toFixed(1)),
  ];

  // 出来高の最大値
  const maxVolume = Math.max(...activeCandles.map((c) => c.volume), 1);

  // マウスクリック時のローソク足選択ハンドラー
  const handleMouseMove = (state: any) => {
    if (state && state.activePayload && state.activePayload.length > 0) {
      onSelectCandle(state.activePayload[0].payload);
    }
  };

  const handleMouseLeave = () => {
    onSelectCandle(null);
  };

  // カスタムツールチップ
  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const c: CandleData = payload[0].payload;
      return (
        <div className="bg-card/95 border border-border p-2 text-xs font-mono rounded shadow-lg backdrop-blur-sm z-50">
          <div className="text-muted-foreground border-b border-border pb-1 mb-1 font-bold">{c.time}</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
            <span>始値 (O):</span><span className="text-right font-bold">{c.open.toFixed(1)}</span>
            <span>高値 (H):</span><span className="text-right text-destructive font-bold">{c.high.toFixed(1)}</span>
            <span>安値 (L):</span><span className="text-right text-emerald-500 font-bold">{c.low.toFixed(1)}</span>
            <span>終値 (C):</span><span className="text-right font-bold">{c.close.toFixed(1)}</span>
            <span>出来高 (V):</span><span className="text-right text-yellow-500/90 font-bold">{c.volume.toLocaleString()}</span>
            {c.ma5 !== undefined && (
              <>
                <span className="text-cyan-400">5MA:</span>
                <span className="text-right text-cyan-400 font-bold">{c.ma5.toFixed(1)}</span>
              </>
            )}
            {c.ma25 !== undefined && (
              <>
                <span className="text-yellow-400">25MA:</span>
                <span className="text-right text-yellow-400 font-bold">{c.ma25.toFixed(1)}</span>
              </>
            )}
            {c.rsi !== undefined && (
              <>
                <span className="text-purple-400">RSI:</span>
                <span className="text-right text-purple-400 font-bold">{c.rsi.toFixed(1)}%</span>
              </>
            )}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col h-full space-y-2">
      {/* メインチャート (ローソク足 + MA + ボリンジャーバンド) */}
      <div className="flex-1 min-h-[320px] bg-background border border-border p-2 relative">
        <div className="absolute top-3 left-3 flex items-center space-x-4 text-[10px] font-mono z-10 bg-background/80 px-2 py-1 rounded backdrop-blur-sm">
          <span className="flex items-center"><span className="w-2 h-2 bg-destructive rounded-full mr-1" />陽線</span>
          <span className="flex items-center"><span className="w-2 h-2 bg-emerald-500 rounded-full mr-1" />陰線</span>
          <span className="text-cyan-400">5MA: {selectedCandle?.ma5?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.ma5?.toFixed(1) ?? '-'}</span>
          <span className="text-yellow-400">25MA: {selectedCandle?.ma25?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.ma25?.toFixed(1) ?? '-'}</span>
          <span className="text-purple-400">BB[±2σ]: Upper {selectedCandle?.bbUpper?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.bbUpper?.toFixed(1) ?? '-'} / Lower {selectedCandle?.bbLower?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.bbLower?.toFixed(1) ?? '-'}</span>
        </div>

        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={activeCandles}
            onMouseMove={handleMouseMove}
            onMouseLeave={handleMouseLeave}
            margin={{ top: 10, right: 10, bottom: 5, left: -10 }}
          >
            <XAxis 
              dataKey="time" 
              tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 9 }}
              stroke="oklch(0.25 0.02 240)"
            />
            <YAxis 
              domain={yDomain} 
              orientation="right"
              tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 9 }}
              stroke="oklch(0.25 0.02 240)"
            />
            <Tooltip content={<CustomTooltip />} />

            {/* ボリンジャーバンド (±2σ) の領域描画 */}
            <Area
              type="monotone"
              dataKey="bbUpper"
              stroke="transparent"
              fill="oklch(0.6 0.12 300 / 5%)"
              activeDot={false}
            />
            <Area
              type="monotone"
              dataKey="bbLower"
              stroke="transparent"
              fill="transparent"
              activeDot={false}
            />

            {/* ボリンジャーバンド境界線 */}
            <Line
              type="monotone"
              dataKey="bbUpper"
              stroke="oklch(0.6 0.12 300 / 30%)"
              strokeDasharray="3 3"
              dot={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="bbLower"
              stroke="oklch(0.6 0.12 300 / 30%)"
              strokeDasharray="3 3"
              dot={false}
              activeDot={false}
            />

            {/* 移動平均線 */}
            <Line
              type="monotone"
              dataKey="ma5"
              stroke="oklch(0.7 0.15 200)"
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
            />
            <Line
              type="monotone"
              dataKey="ma25"
              stroke="oklch(0.75 0.15 80)"
              strokeWidth={1.5}
              dot={false}
              activeDot={false}
            />

            {/* ローソク足 (カスタムレンダラー) */}
            <Bar
              dataKey="close"
              shape={(props: any) => {
                const candleData = activeCandles[props.index];
                return (
                  <Candlestick
                    {...props}
                    yDomain={yDomain}
                    signals={candleData?.signals}
                  />
                );
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* サブチャート (出来高 ＋ RSI) */}
      <div className="h-[120px] flex space-x-2">
        {/* 出来高チャート */}
        <div className="w-[30%] bg-background border border-border p-2 relative">
          <div className="absolute top-1 left-2 text-[9px] font-mono text-muted-foreground">出来高</div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={activeCandles}
              margin={{ top: 15, right: 5, bottom: 5, left: -25 }}
            >
              <XAxis dataKey="time" hide />
              <YAxis domain={[0, maxVolume]} hide />
              <Bar
                dataKey="volume"
                fill="oklch(0.7 0.15 200 / 30%)"
                radius={[1, 1, 0, 0]}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>

        {/* RSIチャート */}
        <div className="w-[70%] bg-background border border-border p-2 relative">
          <div className="absolute top-1 left-2 text-[9px] font-mono text-purple-400">
            RSI(14): {selectedCandle?.rsi?.toFixed(1) ?? activeCandles[activeCandles.length - 1]?.rsi?.toFixed(1) ?? '-'}%
          </div>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={activeCandles}
              margin={{ top: 15, right: 10, bottom: 5, left: -25 }}
            >
              <XAxis dataKey="time" hide />
              <YAxis
                domain={[0, 100]}
                orientation="right"
                tick={{ fill: 'oklch(0.65 0.02 240)', fontSize: 8 }}
                stroke="oklch(0.25 0.02 240)"
              />
              {/* RSI基準線 (70% 買われすぎ, 30% 売られすぎ) */}
              <ReferenceLine y={70} stroke="oklch(0.6 0.18 25 / 40%)" strokeDasharray="3 3" />
              <ReferenceLine y={30} stroke="oklch(0.65 0.18 140 / 40%)" strokeDasharray="3 3" />
              
              <Line
                type="monotone"
                dataKey="rsi"
                stroke="oklch(0.6 0.12 300)"
                strokeWidth={1.5}
                dot={false}
                activeDot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
