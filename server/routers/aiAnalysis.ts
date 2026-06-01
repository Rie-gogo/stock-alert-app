import { z } from "zod";
import { publicProcedure, router } from "../_core/trpc";
import { invokeLLM } from "../_core/llm";
import { getRecentStats, getDailyReportList } from "../db";
import { ENV } from "../_core/env";

// ローソク足データのスキーマ
const CandleSchema = z.object({
  time: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
  ma5: z.number().optional(),
  ma25: z.number().optional(),
  rsi: z.number().optional(),
  bbUpper: z.number().optional(),
  bbMiddle: z.number().optional(),
  bbLower: z.number().optional(),
});

// 板情報のスキーマ
const BoardItemSchema = z.object({
  price: z.number(),
  volume: z.number(),
  type: z.enum(["ask", "bid"]),
});

const BoardDataSchema = z.object({
  asks: z.array(BoardItemSchema),
  bids: z.array(BoardItemSchema),
  totalAskVolume: z.number(),
  totalBidVolume: z.number(),
});

// 歩み値のスキーマ
const TradeTickSchema = z.object({
  time: z.string(),
  price: z.number(),
  volume: z.number(),
  changeType: z.enum(["up", "down", "flat"]),
  sizeType: z.enum(["normal", "large", "huge"]),
});

/**
 * ローソク足データをテキスト形式に変換（LLMへの入力用）
 */
function formatCandlesForLLM(candles: z.infer<typeof CandleSchema>[]): string {
  const recent = candles.slice(-20); // 直近20本のみ
  const lines = recent.map((c) => {
    const rsiStr = c.rsi !== undefined ? ` RSI:${c.rsi.toFixed(1)}` : "";
    const maStr =
      c.ma5 !== undefined && c.ma25 !== undefined
        ? ` 5MA:${c.ma5.toFixed(1)} 25MA:${c.ma25.toFixed(1)}`
        : "";
    const bbStr =
      c.bbUpper !== undefined && c.bbLower !== undefined
        ? ` BB上:${c.bbUpper.toFixed(1)} BB下:${c.bbLower.toFixed(1)}`
        : "";
    const candleType = c.close > c.open ? "陽線" : c.close < c.open ? "陰線" : "同値";
    return `${c.time} [${candleType}] 始:${c.open.toFixed(1)} 高:${c.high.toFixed(1)} 安:${c.low.toFixed(1)} 終:${c.close.toFixed(1)} 出来高:${c.volume.toLocaleString()}${maStr}${rsiStr}${bbStr}`;
  });
  return lines.join("\n");
}

/**
 * 板情報をテキスト形式に変換
 */
function formatBoardForLLM(board: z.infer<typeof BoardDataSchema>): string {
  const topAsks = board.asks.slice(0, 5);
  const topBids = board.bids.slice(0, 5);
  const askRatio = board.totalAskVolume / (board.totalAskVolume + board.totalBidVolume);

  const askLines = topAsks
    .map((a) => `  売 ${a.price.toFixed(1)}: ${a.volume.toLocaleString()}株`)
    .join("\n");
  const bidLines = topBids
    .map((b) => `  買 ${b.price.toFixed(1)}: ${b.volume.toLocaleString()}株`)
    .join("\n");

  return `【売り板（上位5本）】\n${askLines}\n【買い板（上位5本）】\n${bidLines}\n売り板合計: ${board.totalAskVolume.toLocaleString()}株 / 買い板合計: ${board.totalBidVolume.toLocaleString()}株\n売り板比率: ${(askRatio * 100).toFixed(1)}%`;
}

/**
 * 歩み値をテキスト形式に変換
 */
function formatTradesForLLM(trades: z.infer<typeof TradeTickSchema>[]): string {
  const recent = trades.slice(0, 20);
  const largeTrades = recent.filter((t) => t.sizeType !== "normal");

  let netLargeVolume = 0;
  largeTrades.forEach((t) => {
    if (t.changeType === "up") netLargeVolume += t.volume;
    else if (t.changeType === "down") netLargeVolume -= t.volume;
  });

  const lines = recent
    .slice(0, 10)
    .map((t) => {
      const sizeLabel = t.sizeType === "huge" ? "【超大口】" : t.sizeType === "large" ? "[大口]" : "";
      const dirLabel = t.changeType === "up" ? "↑" : t.changeType === "down" ? "↓" : "→";
      return `  ${t.time} ${dirLabel} ${t.price.toFixed(1)} ${t.volume.toLocaleString()}株 ${sizeLabel}`;
    })
    .join("\n");

  const netLabel = netLargeVolume > 0 ? `大口純買い +${netLargeVolume.toLocaleString()}株` : `大口純売り ${netLargeVolume.toLocaleString()}株`;

  return `【直近10件の歩み値】\n${lines}\n${netLabel}`;
}

export const aiAnalysisRouter = router({
  /**
   * リアルタイム市場データをLLMに送り、AI分析を取得する
   * （ストリーミングなし・通常のtRPC mutation）
   */
  analyzeMarket: publicProcedure
    .input(
      z.object({
        symbol: z.string(),
        stockName: z.string(),
        currentPrice: z.number(),
        priceChange: z.number(),
        priceChangePercent: z.number(),
        volume: z.number(),
        candles: z.array(CandleSchema),
        board: BoardDataSchema,
        trades: z.array(TradeTickSchema),
        rsiUpper: z.number().default(70),
        rsiLower: z.number().default(30),
      })
    )
    .mutation(async ({ input }) => {
      // 過去の成績データを取得（失敗パターンの参照用）
      let pastPerformanceContext = "";
      try {
        const stats = await getRecentStats(14);
        const recentReports = await getDailyReportList(5);

        if (stats.totalDays > 0) {
          pastPerformanceContext = `
【過去${stats.totalDays}日間のシミュレーション成績】
- 平均勝率: ${(stats.avgWinRate * 100).toFixed(1)}%
- 平均損益率: ${(stats.avgProfitRate * 100).toFixed(2)}%
- 目標勝率: 80〜90%（現在${stats.avgWinRate >= 0.8 ? "達成中" : "未達成"}）
`;
        }

        if (recentReports.length > 0) {
          const latestReport = recentReports[0];
          if (latestReport.aiSummary) {
            pastPerformanceContext += `\n【直近のAI改善提案】\n${latestReport.aiSummary}`;
          }
        }
      } catch {
        // 過去データ取得失敗は無視（初回実行時など）
      }

      const candlesText = formatCandlesForLLM(input.candles);
      const boardText = formatBoardForLLM(input.board);
      const tradesText = formatTradesForLLM(input.trades);

      const latestCandle = input.candles[input.candles.length - 1];
      const currentRsi = latestCandle?.rsi;
      const currentMa5 = latestCandle?.ma5;
      const currentMa25 = latestCandle?.ma25;

      const systemPrompt = `あなたは日本株デイトレードの専門AIアナリストです。
リアルタイムの市場データ（チャート・板情報・歩み値）を分析し、以下の観点で深く読み解いてください：

1. **チャートの読み方**: ローソク足のパターン、移動平均線のトレンド、RSIの過熱感、ボリンジャーバンドの収縮・拡大
2. **板情報の意味**: 売り板・買い板の厚さから機関投資家や大口の意図を推測
3. **歩み値の解釈**: 大口取引の方向性から「誰が何をしているか」を推測
4. **複合判断**: 上記3つを統合して「今何が起きているか」「なぜこの動きか」を説明
5. **具体的なアクション提案**: エントリー・見送り・損切りの根拠を明確に

回答は日本語で、専門的だが分かりやすく、400文字以内にまとめてください。
重要な警告がある場合は冒頭に「⚠️【警告】」と明記してください。`;

      const userPrompt = `【銘柄】${input.stockName}（${input.symbol}）
【現在値】${input.currentPrice.toFixed(1)}円 (前日比: ${input.priceChange >= 0 ? "+" : ""}${input.priceChange.toFixed(1)}円 / ${input.priceChange >= 0 ? "+" : ""}${input.priceChangePercent.toFixed(2)}%)
【累計出来高】${input.volume.toLocaleString()}株
【RSI設定】買われすぎ閾値: ${input.rsiUpper} / 売られすぎ閾値: ${input.rsiLower}
【現在のテクニカル】RSI: ${currentRsi?.toFixed(1) ?? "計算中"} / 5MA: ${currentMa5?.toFixed(1) ?? "計算中"} / 25MA: ${currentMa25?.toFixed(1) ?? "計算中"}

=== 1分足チャート（直近20本）===
${candlesText}

=== 板情報 ===
${boardText}

=== 歩み値 ===
${tradesText}
${pastPerformanceContext}

上記のデータを総合的に分析し、現在の市場状況と推奨アクションを教えてください。`;

      const response = await invokeLLM({
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
      });

      const rawContent = response.choices[0]?.message?.content;
      const analysisText = typeof rawContent === "string" ? rawContent : "分析結果を取得できませんでした。";

      return {
        analysis: analysisText,
        timestamp: Date.now(),
        symbol: input.symbol,
        currentPrice: input.currentPrice,
      };
    }),

  /**
   * ストリーミングAI分析（SSE経由）
   * このエンドポイントはtRPCではなくExpressで直接実装するため、
   * フロントエンドはfetchで /api/ai/stream-analysis を呼ぶ
   */
  getStreamEndpointInfo: publicProcedure.query(() => {
    return { endpoint: "/api/ai/stream-analysis" };
  }),
});
