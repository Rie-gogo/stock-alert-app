/**
 * Yahoo Finance API テストスクリプト
 * 実行: npx tsx server/testYahoo.ts
 */
import { callDataApi } from "./_core/dataApi";

async function testYahooFinance(ticker: string) {
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
              open: (number | null)[];
              high: (number | null)[];
              low: (number | null)[];
              close: (number | null)[];
              volume: (number | null)[];
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
      const firstTime = timestamps.length > 0 ? new Date(timestamps[0] * 1000).toISOString() : "N/A";
      const lastTime = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1] * 1000).toISOString() : "N/A";
      const jstFirst = timestamps.length > 0 ? new Date(timestamps[0] * 1000 + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " JST" : "N/A";
      const jstLast = timestamps.length > 0 ? new Date(timestamps[timestamps.length - 1] * 1000 + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19) + " JST" : "N/A";
      console.log(`✅ ${ticker}: ${validCandles} valid candles (total=${timestamps.length})`);
      console.log(`   first=${jstFirst}, last=${jstLast}`);
    } else {
      console.log(`❌ ${ticker}: No data. Error:`, data?.chart?.error);
    }
  } catch (e) {
    console.log(`❌ ${ticker}: Exception:`, e);
  }
}

async function main() {
  console.log("=== Yahoo Finance API テスト ===");
  console.log(`現在時刻: ${new Date().toISOString()} (UTC)`);
  console.log(`JST: ${new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace("T", " ").slice(0, 19)} JST`);
  console.log("");

  await testYahooFinance("9984.T");
  await testYahooFinance("8306.T");
  await testYahooFinance("6920.T");
  await testYahooFinance("7011.T");

  console.log("\n=== テスト完了 ===");
}

main().catch(console.error);
