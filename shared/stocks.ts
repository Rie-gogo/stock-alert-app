/**
 * 監視対象銘柄の正規定義（サーバー・クライアント共通）
 * server/realSimulation.ts および client/src/hooks/useRealMarketData.ts の両方から参照する。
 *
 * 選定方針: 出来高（売買代金）が大きく流動性の高い主力銘柄に限定する。
 * デイトレでは約定しやすさ（流動性）が最優先のため、低出来高銘柄は採用しない。
 * 業種が半導体・電子部品に偏らないよう、銀行・自動車・非鉄なども加えて分散する。
 */
export const TARGET_STOCKS = [
  // --- 既存10銘柄 ---
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
  // --- 追加10銘柄（出来高上位・業種分散）---
  { symbol: '285A', ticker: '285A.T', name: 'キオクシアHD',           basePrice: 70000 },
  { symbol: '6981', ticker: '6981.T', name: '村田製作所',             basePrice: 10000 },
  { symbol: '6976', ticker: '6976.T', name: '太陽誘電',               basePrice: 14500 },
  { symbol: '5803', ticker: '5803.T', name: 'フジクラ',               basePrice: 4400 },
  { symbol: '5016', ticker: '5016.T', name: 'JX金属',                 basePrice: 3600 },
  { symbol: '3436', ticker: '3436.T', name: 'SUMCO',                  basePrice: 4100 },
  { symbol: '8316', ticker: '8316.T', name: '三井住友FG',             basePrice: 3900 },
  { symbol: '6758', ticker: '6758.T', name: 'ソニーグループ',          basePrice: 3650 },
  { symbol: '6723', ticker: '6723.T', name: 'ルネサスエレクトロニクス', basePrice: 2200 },
  { symbol: '7203', ticker: '7203.T', name: 'トヨタ自動車',           basePrice: 2800 },
] as const;

export type TargetStock = typeof TARGET_STOCKS[number];
