/**
 * 追加候補10銘柄のデータ取得テスト（出来高重視で選定）
 * 実行: npx tsx server/testCandidates.ts
 */
import { callDataApi } from "./_core/dataApi";

// 出来高・売買代金が大きく、デイトレ適性が高い主力銘柄を業種分散して選定
const CANDIDATES = [
  { symbol: "285A", ticker: "285A.T", name: "キオクシアHD" },        // 半導体メモリ・売買代金トップ
  { symbol: "6981", ticker: "6981.T", name: "村田製作所" },          // 電子部品・売買代金上位
  { symbol: "6976", ticker: "6976.T", name: "太陽誘電" },            // 電子部品・高ボラ
  { symbol: "5803", ticker: "5803.T", name: "フジクラ" },            // 電線・高出来高
  { symbol: "5016", ticker: "5016.T", name: "JX金属" },              // 非鉄金属・高出来高
  { symbol: "3436", ticker: "3436.T", name: "SUMCO" },               // 半導体材料・高出来高
  { symbol: "8316", ticker: "8316.T", name: "三井住友FG" },          // メガバンク・流動性大
  { symbol: "6758", ticker: "6758.T", name: "ソニーグループ" },       // 電機大型・流動性大
  { symbol: "6723", ticker: "6723.T", name: "ルネサスエレクトロニクス" }, // 半導体・最活況
  { symbol: "7203", ticker: "7203.T", name: "トヨタ自動車" },        // 自動車最大手・流動性最大
];

async function testStock(ticker: string, name: string) {
  try {
    const rawData = await callDataApi("YahooFinance/get_stock_chart", {
      query: { symbol: ticker, region: "JP", interval: "1m", range: "1d" },
    });
    const data = rawData as {
      chart?: {
        result?: Array<{
          timestamp: number[];
          indicators: { quote: Array<{ close: (number | null)[] }> };
        }>;
        error?: { description: string };
      };
    };
    const result = data?.chart?.result?.[0];
    if (result) {
      const timestamps: number[] = result.timestamp ?? [];
      const quotes = result.indicators?.quote?.[0];
      const validCandles = timestamps.filter((_, i) => quotes?.close?.[i] != null).length;
      console.log(`OK  ${name}(${ticker}): ${validCandles}本`);
      return true;
    }
    console.log(`NG  ${name}(${ticker}): データなし。Error: ${data?.chart?.error?.description ?? "unknown"}`);
    return false;
  } catch (e) {
    console.log(`NG  ${name}(${ticker}): 例外 - ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

async function main() {
  console.log("=== 追加候補10銘柄 データ取得テスト ===");
  let ok = 0;
  for (const s of CANDIDATES) {
    if (await testStock(s.ticker, s.name)) ok++;
    await new Promise(r => setTimeout(r, 300));
  }
  console.log(`\n結果: ${ok}/${CANDIDATES.length} 銘柄でデータ取得成功`);
}

main().catch(console.error);
