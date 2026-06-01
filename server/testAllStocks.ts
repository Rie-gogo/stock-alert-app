/**
 * 全10銘柄のデータ取得テスト
 * 実行: npx tsx server/testAllStocks.ts
 */
import { callDataApi } from "./_core/dataApi";

const STOCKS = [
  { symbol: "6526", ticker: "6526.T", name: "ソシオネクスト" },
  { symbol: "6920", ticker: "6920.T", name: "レーザーテック" },
  { symbol: "6857", ticker: "6857.T", name: "アドバンテスト" },
  { symbol: "9107", ticker: "9107.T", name: "川崎汽船" },
  { symbol: "8306", ticker: "8306.T", name: "三菱UFJ FG" },
  { symbol: "9984", ticker: "9984.T", name: "ソフトバンクグループ" },
  { symbol: "8035", ticker: "8035.T", name: "東京エレクトロン" },
  { symbol: "7011", ticker: "7011.T", name: "三菱重工業" },
  { symbol: "4568", ticker: "4568.T", name: "第一三共" },
  { symbol: "3778", ticker: "3778.T", name: "さくらインターネット" },
];

async function testStock(ticker: string, name: string) {
  try {
    const rawData = await callDataApi("YahooFinance/get_stock_chart", {
      query: {
        symbol: ticker,
        region: "JP",
        interval: "1m",
        range: "1d",
      },
    });

    const data = rawData as {
      chart?: {
        result?: Array<{
          timestamp: number[];
          indicators: {
            quote: Array<{
              close: (number | null)[];
            }>;
          };
        }>;
        error?: { description: string };
      };
    };

    const result = data?.chart?.result?.[0];
    if (result) {
      const timestamps: number[] = result.timestamp ?? [];
      const quotes = result.indicators?.quote?.[0];
      const validCandles = timestamps.filter((_, i) => quotes?.close?.[i] != null).length;
      const jstFirst = timestamps.length > 0
        ? new Date(timestamps[0] * 1000 + 9 * 3600 * 1000).toISOString().slice(11, 16) + " JST"
        : "N/A";
      const jstLast = timestamps.length > 0
        ? new Date(timestamps[timestamps.length - 1] * 1000 + 9 * 3600 * 1000).toISOString().slice(11, 16) + " JST"
        : "N/A";
      console.log(`✅ ${name}(${ticker}): ${validCandles}本 (${jstFirst}〜${jstLast})`);
      return true;
    } else {
      console.log(`❌ ${name}(${ticker}): データなし。Error: ${data?.chart?.error?.description ?? "unknown"}`);
      return false;
    }
  } catch (e) {
    console.log(`❌ ${name}(${ticker}): 例外 - ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log("=== 全10銘柄データ取得テスト ===");
  console.log(`現在時刻: ${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 19)} JST`);
  console.log("");

  let successCount = 0;
  for (const stock of STOCKS) {
    const ok = await testStock(stock.ticker, stock.name);
    if (ok) successCount++;
  }

  console.log(`\n結果: ${successCount}/${STOCKS.length} 銘柄でデータ取得成功`);
}

main().catch(console.error);
