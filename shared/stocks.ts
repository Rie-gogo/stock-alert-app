/**
 * 監視対象銘柄の正規定義（サーバー・クライアント共通）
 * server/realSimulation.ts および client/src/hooks/useRealMarketData.ts の両方から参照する。
 */
export const TARGET_STOCKS = [
  { symbol: '6526', ticker: '6526.T', name: 'ソシオネクスト',         basePrice: 3250 },
  { symbol: '6920', ticker: '6920.T', name: 'レーザーテック',          basePrice: 22400 },
  { symbol: '6857', ticker: '6857.T', name: 'アドバンテスト',          basePrice: 8800 },
  { symbol: '9107', ticker: '9107.T', name: '川崎汽船',               basePrice: 2100 },
  { symbol: '8306', ticker: '8306.T', name: '三菱UFJ FG',             basePrice: 1650 },
  { symbol: '9984', ticker: '9984.T', name: 'ソフトバンクグループ',    basePrice: 8420 },
  { symbol: '8035', ticker: '8035.T', name: '東京エレクトロン',        basePrice: 24800 },
  { symbol: '7011', ticker: '7011.T', name: '三菱重工業',              basePrice: 2900 },
  { symbol: '4568', ticker: '4568.T', name: '第一三共',               basePrice: 4500 },
  { symbol: '3778', ticker: '3778.T', name: 'さくらインターネット',    basePrice: 4100 },
] as const;

export type TargetStock = typeof TARGET_STOCKS[number];
