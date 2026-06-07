/**
 * kabu STATION® API モジュール
 *
 * kabuステーションはWindowsのローカルアプリとして動作し、
 * localhost:18080（本番）または localhost:18081（検証）でAPIを提供します。
 *
 * このモジュールは:
 * 1. Windows中継スクリプトからWebSocket経由で受信した板情報をキャッシュ
 * 2. フロントエンドへtRPC経由で板情報を提供
 * 3. 板読みシグナルを計算
 */

export type OrderBookEntry = {
  price: number;
  qty: number;
};

export type KabuOrderBook = {
  symbol: string;
  symbolName: string;
  currentPrice: number;
  currentPriceTime: string;
  asks: OrderBookEntry[]; // 売気配 (ask1〜ask10)
  bids: OrderBookEntry[]; // 買気配 (bid1〜bid10)
  marketOrderSellQty: number; // 売成行数量
  marketOrderBuyQty: number; // 買成行数量
  overSellQty: number; // OVER気配数量
  underBuyQty: number; // UNDER気配数量
  vwap: number;
  receivedAt: number; // Unix timestamp (ms)
};

export type OrderBookSignal = {
  type: "board_buy_pressure" | "board_sell_pressure" | "large_bid_wall" | "large_ask_wall" | "market_order_surge";
  strength: number; // 0.0〜1.0
  description: string;
};

// メモリキャッシュ（銘柄コード → 最新板情報）
const orderBookCache = new Map<string, KabuOrderBook>();

// キャッシュの最大保持時間（5秒）
const CACHE_TTL_MS = 5_000;

/**
 * 板情報をキャッシュに保存（Windows中継スクリプトから呼ばれる）
 */
export function updateOrderBook(data: KabuOrderBook): void {
  orderBookCache.set(data.symbol, {
    ...data,
    receivedAt: Date.now(),
  });
}

/**
 * 特定銘柄の板情報を取得
 */
export function getOrderBook(symbol: string): KabuOrderBook | null {
  const cached = orderBookCache.get(symbol);
  if (!cached) return null;

  // キャッシュが古すぎる場合はnullを返す
  if (Date.now() - cached.receivedAt > CACHE_TTL_MS) {
    orderBookCache.delete(symbol);
    return null;
  }

  return cached;
}

/**
 * 全銘柄の板情報を取得
 */
export function getAllOrderBooks(): KabuOrderBook[] {
  const now = Date.now();
  const result: KabuOrderBook[] = [];

  for (const [key, book] of Array.from(orderBookCache.entries())) {
    if (now - book.receivedAt <= CACHE_TTL_MS) {
      result.push(book);
    } else {
      orderBookCache.delete(key);
    }
  }

  return result;
}

/**
 * 板情報から売買シグナルを計算
 *
 * シグナル1: 買い板・売り板の厚み比率（板圧力）
 *   - 買い板合計 / 売り板合計 >= 1.5 → 買い優勢
 *   - 買い板合計 / 売り板合計 <= 0.67 → 売り優勢
 *
 * シグナル2: 大口注文の壁検出
 *   - 特定価格帯に平均の3倍以上の注文 → サポート/レジスタンス
 *
 * シグナル3: 成行注文の急増
 *   - 成行注文が板全体の10%超 → 強いトレンド発生中
 */
export function analyzeOrderBook(book: KabuOrderBook): OrderBookSignal[] {
  const signals: OrderBookSignal[] = [];

  // 買い板・売り板の合計数量を計算
  const totalBidQty = book.bids.reduce((sum, b) => sum + b.qty, 0) + book.underBuyQty;
  const totalAskQty = book.asks.reduce((sum, a) => sum + a.qty, 0) + book.overSellQty;

  if (totalBidQty === 0 || totalAskQty === 0) return signals;

  // シグナル1: 板圧力
  const pressureRatio = totalBidQty / totalAskQty;

  if (pressureRatio >= 1.5) {
    signals.push({
      type: "board_buy_pressure",
      strength: Math.min(1.0, (pressureRatio - 1.5) / 1.5 + 0.5),
      description: `買い板が売り板の${pressureRatio.toFixed(1)}倍（買い優勢）`,
    });
  } else if (pressureRatio <= 0.67) {
    signals.push({
      type: "board_sell_pressure",
      strength: Math.min(1.0, (0.67 - pressureRatio) / 0.67 + 0.5),
      description: `売り板が買い板の${(1 / pressureRatio).toFixed(1)}倍（売り優勢）`,
    });
  }

  // シグナル2: 大口注文の壁検出
  if (book.bids.length > 0) {
    const avgBidQty = totalBidQty / book.bids.length;
    const largeBid = book.bids.find((b) => b.qty >= avgBidQty * 3);
    if (largeBid) {
      signals.push({
        type: "large_bid_wall",
        strength: Math.min(1.0, largeBid.qty / (avgBidQty * 5)),
        description: `${largeBid.price.toLocaleString()}円に大口買い注文（${largeBid.qty.toLocaleString()}株）`,
      });
    }
  }

  if (book.asks.length > 0) {
    const avgAskQty = totalAskQty / book.asks.length;
    const largeAsk = book.asks.find((a) => a.qty >= avgAskQty * 3);
    if (largeAsk) {
      signals.push({
        type: "large_ask_wall",
        strength: Math.min(1.0, largeAsk.qty / (avgAskQty * 5)),
        description: `${largeAsk.price.toLocaleString()}円に大口売り注文（${largeAsk.qty.toLocaleString()}株）`,
      });
    }
  }

  // シグナル3: 成行注文の急増
  const totalMarketQty = book.marketOrderBuyQty + book.marketOrderSellQty;
  const totalAllQty = totalBidQty + totalAskQty + totalMarketQty;

  if (totalAllQty > 0) {
    const marketRatio = totalMarketQty / totalAllQty;
    if (marketRatio >= 0.1) {
      const isBuyDominant = book.marketOrderBuyQty > book.marketOrderSellQty;
      signals.push({
        type: "market_order_surge",
        strength: Math.min(1.0, marketRatio * 5),
        description: `成行注文が急増（${(marketRatio * 100).toFixed(0)}%、${isBuyDominant ? "買い" : "売り"}優勢）`,
      });
    }
  }

  return signals;
}

/**
 * kabu STATION APIのWebSocketプッシュデータを板情報に変換
 * （Windows中継スクリプトから送られてくるJSONをパース）
 */
export function parseKabuPushData(raw: Record<string, unknown>): KabuOrderBook | null {
  try {
    const symbol = String(raw.Symbol ?? "");
    const symbolName = String(raw.SymbolName ?? "");
    const currentPrice = Number(raw.CurrentPrice ?? 0);
    const currentPriceTime = String(raw.CurrentPriceTime ?? "");

    const asks: OrderBookEntry[] = [];
    const bids: OrderBookEntry[] = [];

    // 売気配 Sell1〜Sell10
    for (let i = 1; i <= 10; i++) {
      const priceKey = `Sell${i}`;
      const qtyKey = `Sell${i}Qty`;
      const price = Number((raw[priceKey] as Record<string, unknown>)?.Price ?? 0);
      const qty = Number((raw[priceKey] as Record<string, unknown>)?.Qty ?? raw[qtyKey] ?? 0);
      if (price > 0) asks.push({ price, qty });
    }

    // 買気配 Buy1〜Buy10
    for (let i = 1; i <= 10; i++) {
      const priceKey = `Buy${i}`;
      const qtyKey = `Buy${i}Qty`;
      const price = Number((raw[priceKey] as Record<string, unknown>)?.Price ?? 0);
      const qty = Number((raw[priceKey] as Record<string, unknown>)?.Qty ?? raw[qtyKey] ?? 0);
      if (price > 0) bids.push({ price, qty });
    }

    return {
      symbol,
      symbolName,
      currentPrice,
      currentPriceTime,
      asks,
      bids,
      marketOrderSellQty: Number(raw.MarketOrderSellQty ?? 0),
      marketOrderBuyQty: Number(raw.MarketOrderBuyQty ?? 0),
      overSellQty: Number(raw.OverSellQty ?? 0),
      underBuyQty: Number(raw.UnderBuyQty ?? 0),
      vwap: Number(raw.VWAP ?? 0),
      receivedAt: Date.now(),
    };
  } catch {
    return null;
  }
}
