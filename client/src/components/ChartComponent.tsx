import React, { useRef, useEffect, useState, useCallback } from 'react';
import { CandleData } from '../types';

interface ChartComponentProps {
  data: CandleData[];
  selectedCandle: CandleData | null;
  onSelectCandle: (candle: CandleData | null) => void;
}

interface TooltipState {
  x: number;
  y: number;
  candle: CandleData;
}

export default function ChartComponent({ data, selectedCandle, onSelectCandle }: ChartComponentProps) {
  const mainCanvasRef = useRef<HTMLCanvasElement>(null);
  const volumeCanvasRef = useRef<HTMLCanvasElement>(null);
  const rsiCanvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [signalTooltip, setSignalTooltip] = useState<{ x: number; y: number; signal: { type: string; reason: string }; price: number; time: string } | null>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 400 });

  // 最新40本に絞る
  const activeCandles = data.slice(-120);

  // シグナル数カウント
  const buyCount = activeCandles.reduce((acc, c) => acc + (c.signals?.filter(s => s.type === 'buy').length ?? 0), 0);
  const sellCount = activeCandles.reduce((acc, c) => acc + (c.signals?.filter(s => s.type === 'sell').length ?? 0), 0);

  // ResizeObserver でコンテナサイズを監視
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        if (width > 0 && height > 0) {
          setDimensions({ width, height });
        }
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, []);

  // メインチャート描画
  const drawMain = useCallback(() => {
    const canvas = mainCanvasRef.current;
    if (!canvas || activeCandles.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    // パディング
    const padLeft = 8;
    const padRight = 52;
    const padTop = 30;
    const padBottom = 20;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    // 価格レンジ計算
    const allPrices: number[] = [];
    activeCandles.forEach(c => {
      allPrices.push(c.high, c.low);
      if (c.ma5 != null) allPrices.push(c.ma5);
      if (c.ma25 != null) allPrices.push(c.ma25);
      if (c.bbUpper != null) allPrices.push(c.bbUpper);
      if (c.bbLower != null) allPrices.push(c.bbLower);
    });
    const rawMin = Math.min(...allPrices);
    const rawMax = Math.max(...allPrices);
    const margin = (rawMax - rawMin) * 0.12 || 5;
    const priceMin = rawMin - margin;
    const priceMax = rawMax + margin;

    const toY = (price: number) => padTop + chartH * (1 - (price - priceMin) / (priceMax - priceMin));
    const toX = (i: number) => padLeft + (i + 0.5) * (chartW / activeCandles.length);
    const candleW = Math.max(2, (chartW / activeCandles.length) * 0.7);

    // 背景
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, W, H);

    // グリッド線
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 5; i++) {
      const y = padTop + (chartH / 5) * i;
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
    }

    // Y軸ラベル
    ctx.fillStyle = 'rgba(150,160,180,0.8)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const price = priceMax - (priceMax - priceMin) * (i / 5);
      const y = padTop + (chartH / 5) * i;
      ctx.fillText(price.toFixed(0), W - padRight + 4, y + 3);
    }

    // ボリンジャーバンド
    const hasBB = activeCandles.some(c => c.bbUpper != null && c.bbLower != null);
    if (hasBB) {
      ctx.strokeStyle = 'rgba(160,100,220,0.25)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      // Upper
      ctx.beginPath();
      activeCandles.forEach((c, i) => {
        if (c.bbUpper == null) return;
        const x = toX(i);
        const y = toY(c.bbUpper);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      // Lower
      ctx.beginPath();
      activeCandles.forEach((c, i) => {
        if (c.bbLower == null) return;
        const x = toX(i);
        const y = toY(c.bbLower);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // MA5
    ctx.strokeStyle = 'rgba(100,200,220,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let firstMA5 = true;
    activeCandles.forEach((c, i) => {
      if (c.ma5 == null) return;
      const x = toX(i);
      const y = toY(c.ma5);
      if (firstMA5) { ctx.moveTo(x, y); firstMA5 = false; } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // MA25
    ctx.strokeStyle = 'rgba(220,180,80,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let firstMA25 = true;
    activeCandles.forEach((c, i) => {
      if (c.ma25 == null) return;
      const x = toX(i);
      const y = toY(c.ma25);
      if (firstMA25) { ctx.moveTo(x, y); firstMA25 = false; } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // ローソク足
    activeCandles.forEach((c, i) => {
      const x = toX(i);
      const openY = toY(c.open);
      const closeY = toY(c.close);
      const highY = toY(c.high);
      const lowY = toY(c.low);
      const isUp = c.close >= c.open;

      const color = isUp ? 'rgba(220,60,60,0.9)' : 'rgba(60,190,100,0.9)';
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 1;

      // 芯
      ctx.beginPath();
      ctx.moveTo(x, highY);
      ctx.lineTo(x, lowY);
      ctx.stroke();

      // 実体
      const bodyTop = Math.min(openY, closeY);
      const bodyH = Math.max(1, Math.abs(closeY - openY));
      ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
    });

    // シグナルマーカー
    activeCandles.forEach((c, i) => {
      if (!c.signals || c.signals.length === 0) return;
      const x = toX(i);
      const highY = toY(c.high);
      const lowY = toY(c.low);

      c.signals.forEach(sig => {
        const isBuy = sig.type === 'buy';
        const isWarn = sig.type === 'warn';
        const color = isBuy ? '#ef4444' : isWarn ? '#eab308' : '#22c55e';
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;

        if (isWarn) {
          // ひし形
          const cy = highY - 18;
          ctx.beginPath();
          ctx.moveTo(x, cy - 7);
          ctx.lineTo(x + 5, cy);
          ctx.lineTo(x, cy + 7);
          ctx.lineTo(x - 5, cy);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = color;
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('W', x, cy - 12);
        } else if (isBuy) {
          // 上向き三角（下に表示）
          const ty = lowY + 14;
          ctx.beginPath();
          ctx.moveTo(x, ty - 8);
          ctx.lineTo(x - 5, ty + 2);
          ctx.lineTo(x + 5, ty + 2);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = color;
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('B', x, ty + 14);
        } else {
          // 下向き三角（上に表示）
          const ty = highY - 14;
          ctx.beginPath();
          ctx.moveTo(x, ty + 8);
          ctx.lineTo(x - 5, ty - 2);
          ctx.lineTo(x + 5, ty - 2);
          ctx.closePath();
          ctx.fill();
          ctx.fillStyle = color;
          ctx.font = 'bold 9px monospace';
          ctx.textAlign = 'center';
          ctx.fillText('S', x, ty - 10);
        }
      });
    });

    // X軸ラベル（間引き）
    ctx.fillStyle = 'rgba(150,160,180,0.7)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'center';
    const labelStep = Math.max(1, Math.floor(activeCandles.length / 8));
    activeCandles.forEach((c, i) => {
      if (i % labelStep !== 0) return;
      const x = toX(i);
      ctx.fillText(c.time.slice(-5), x, H - 5);
    });
  }, [activeCandles, dimensions]);

  // 出来高チャート描画
  const drawVolume = useCallback(() => {
    const canvas = volumeCanvasRef.current;
    if (!canvas || activeCandles.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    const padLeft = 8;
    const padRight = 52;
    const padTop = 10;
    const padBottom = 5;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    const maxVol = Math.max(...activeCandles.map(c => c.volume), 1);
    const barW = Math.max(1, (chartW / activeCandles.length) * 0.7);

    activeCandles.forEach((c, i) => {
      const x = padLeft + (i + 0.5) * (chartW / activeCandles.length);
      const barH = (c.volume / maxVol) * chartH;
      const isUp = c.close >= c.open;
      ctx.fillStyle = isUp ? 'rgba(220,60,60,0.35)' : 'rgba(60,190,100,0.35)';
      ctx.fillRect(x - barW / 2, padTop + chartH - barH, barW, barH);
    });

    // ラベル
    ctx.fillStyle = 'rgba(150,160,180,0.7)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText('出来高', 4, 12);
  }, [activeCandles]);

  // RSIチャート描画
  const drawRSI = useCallback(() => {
    const canvas = rsiCanvasRef.current;
    if (!canvas || activeCandles.length === 0) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, W, H);

    const padLeft = 8;
    const padRight = 52;
    const padTop = 14;
    const padBottom = 5;
    const chartW = W - padLeft - padRight;
    const chartH = H - padTop - padBottom;

    const toX = (i: number) => padLeft + (i + 0.5) * (chartW / activeCandles.length);
    const toY = (v: number) => padTop + chartH * (1 - v / 100);

    // グリッド
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 1;
    [30, 50, 70].forEach(v => {
      const y = toY(v);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(W - padRight, y);
      ctx.stroke();
    });

    // 70/30ライン
    ctx.strokeStyle = 'rgba(220,60,60,0.3)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, toY(70));
    ctx.lineTo(W - padRight, toY(70));
    ctx.stroke();
    ctx.strokeStyle = 'rgba(60,190,100,0.3)';
    ctx.beginPath();
    ctx.moveTo(padLeft, toY(30));
    ctx.lineTo(W - padRight, toY(30));
    ctx.stroke();
    ctx.setLineDash([]);

    // RSI線
    ctx.strokeStyle = 'rgba(160,100,220,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    let first = true;
    activeCandles.forEach((c, i) => {
      if (c.rsi == null) return;
      const x = toX(i);
      const y = toY(c.rsi);
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    });
    ctx.stroke();

    // ラベル
    const lastRsi = [...activeCandles].reverse().find(c => c.rsi != null)?.rsi;
    ctx.fillStyle = 'rgba(160,100,220,0.9)';
    ctx.font = '9px monospace';
    ctx.textAlign = 'left';
    ctx.fillText(`RSI(14): ${lastRsi?.toFixed(1) ?? '-'}%`, 4, 12);

    // Y軸ラベル
    ctx.fillStyle = 'rgba(150,160,180,0.6)';
    ctx.textAlign = 'left';
    [30, 70].forEach(v => {
      ctx.fillText(String(v), W - padRight + 4, toY(v) + 3);
    });
  }, [activeCandles]);

  useEffect(() => {
    drawMain();
    drawVolume();
    drawRSI();
  }, [drawMain, drawVolume, drawRSI]);

  // マウスムーブ（ツールチップ）
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = mainCanvasRef.current;
    if (!canvas || activeCandles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;

    const padLeft = 8;
    const padRight = 52;
    const chartW = rect.width - padLeft - padRight;
    const idx = Math.round((mouseX - padLeft) / (chartW / activeCandles.length) - 0.5);
    const clampedIdx = Math.max(0, Math.min(activeCandles.length - 1, idx));
    const candle = activeCandles[clampedIdx];

    if (candle) {
      setTooltip({ x: e.clientX - rect.left, y: e.clientY - rect.top, candle });
      onSelectCandle(candle);
    }
  }, [activeCandles, onSelectCandle]);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
    onSelectCandle(null);
  }, [onSelectCandle]);

  // 現在のMA値
  const lastCandle = activeCandles[activeCandles.length - 1];
  const displayCandle = selectedCandle ?? lastCandle;

  return (
    <div className="flex flex-col h-full space-y-2 relative">
      {/* メインチャート */}
      <div className="flex-1 min-h-[320px] bg-background border border-border relative overflow-hidden" ref={containerRef}>
        {/* 凡例 */}
        <div className="absolute top-2 left-3 flex items-center flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono z-10 bg-background/90 px-2 py-1 rounded backdrop-blur-sm border border-border/30">
          <span className="flex items-center"><span className="w-2 h-2 bg-red-500 rounded-full mr-1" />陽線</span>
          <span className="flex items-center"><span className="w-2 h-2 bg-emerald-500 rounded-full mr-1" />陰線</span>
          <span className="text-cyan-400">5MA: {displayCandle?.ma5?.toFixed(1) ?? '-'}</span>
          <span className="text-yellow-400">25MA: {displayCandle?.ma25?.toFixed(1) ?? '-'}</span>
          {(buyCount > 0 || sellCount > 0) && (
            <span className="flex items-center gap-1 ml-1">
              {buyCount > 0 && <span className="bg-red-500/20 text-red-400 border border-red-500/40 px-1.5 py-0 rounded font-bold">▲B×{buyCount}</span>}
              {sellCount > 0 && <span className="bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 px-1.5 py-0 rounded font-bold">▼S×{sellCount}</span>}
            </span>
          )}
        </div>

        <canvas
          ref={mainCanvasRef}
          className="w-full h-full"
          onMouseMove={handleMouseMove}
          onMouseLeave={handleMouseLeave}
          style={{ cursor: 'crosshair' }}
        />

        {/* ツールチップ */}
        {tooltip && (
          <div
            className="absolute z-50 pointer-events-none"
            style={{
              left: Math.min(tooltip.x + 12, dimensions.width - 180),
              top: Math.max(tooltip.y - 80, 8),
            }}
          >
            <div className="bg-card/98 border border-border p-2.5 text-xs font-mono rounded shadow-xl backdrop-blur-sm min-w-[160px]">
              <div className="text-muted-foreground border-b border-border pb-1 mb-1.5 font-bold text-[11px]">{tooltip.candle.time}</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span className="text-muted-foreground">始値:</span><span className="text-right font-bold">{tooltip.candle.open.toFixed(1)}</span>
                <span className="text-red-400">高値:</span><span className="text-right text-red-400 font-bold">{tooltip.candle.high.toFixed(1)}</span>
                <span className="text-emerald-500">安値:</span><span className="text-right text-emerald-500 font-bold">{tooltip.candle.low.toFixed(1)}</span>
                <span className="text-muted-foreground">終値:</span><span className="text-right font-bold">{tooltip.candle.close.toFixed(1)}</span>
                <span className="text-yellow-500">出来高:</span><span className="text-right text-yellow-500 font-bold">{tooltip.candle.volume.toLocaleString()}</span>
                {tooltip.candle.rsi != null && (
                  <><span className="text-purple-400">RSI:</span><span className="text-right text-purple-400 font-bold">{tooltip.candle.rsi.toFixed(1)}%</span></>
                )}
              </div>
              {tooltip.candle.signals && tooltip.candle.signals.length > 0 && (
                <div className="mt-1.5 pt-1.5 border-t border-border/50 space-y-0.5">
                  {tooltip.candle.signals.map((sig, i) => (
                    <div key={i} className={`text-[10px] font-bold flex items-center gap-1 ${sig.type === 'buy' ? 'text-red-400' : sig.type === 'warn' ? 'text-yellow-400' : 'text-emerald-400'}`}>
                      <span className="font-mono">{sig.type === 'buy' ? '▲BUY' : sig.type === 'warn' ? '◆WARN' : '▼SELL'}</span>
                      <span className="font-normal text-muted-foreground truncate max-w-[120px]">{sig.reason}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* サブチャート（出来高 + RSI） */}
      <div className="h-[120px] flex space-x-2">
        {/* 出来高 */}
        <div className="w-[30%] bg-background border border-border relative overflow-hidden">
          <canvas ref={volumeCanvasRef} className="w-full h-full" />
        </div>

        {/* RSI */}
        <div className="w-[70%] bg-background border border-border relative overflow-hidden">
          <canvas ref={rsiCanvasRef} className="w-full h-full" />
        </div>
      </div>
    </div>
  );
}
