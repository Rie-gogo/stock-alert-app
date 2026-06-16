/**
 * debug_candle_indicators.ts
 * fetchRealCandlesOnceが返すキャンドルの指標値を直接確認する
 * (realSimulation.tsの内部関数をモンキーパッチして確認)
 */

// ENV.jquantsApiKeyが正しく取得できているか確認
import { ENV } from "./server/_core/env";

console.log("ENV.jquantsApiKey:", ENV.jquantsApiKey ? `${ENV.jquantsApiKey.slice(0, 10)}...` : "未設定");
console.log("process.env.JQUANTS_API_KEY:", process.env.JQUANTS_API_KEY ? `${process.env.JQUANTS_API_KEY.slice(0, 10)}...` : "未設定");

// J-Quantsから直接データを取得して指標計算を確認
const JQUANTS_API_KEY = ENV.jquantsApiKey || process.env.JQUANTS_API_KEY || "";

function calcMA(data: number[], period: number): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  for (let i = period - 1; i < data.length; i++) {
    const sum = data.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    result[i] = sum / period;
  }
  return result;
}

function calcRSI(data: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = new Array(data.length).fill(null);
  if (data.length < period + 1) return result;
  const gains: number[] = [];
  const losses: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const diff = data[i] - data[i - 1];
    gains.push(Math.max(diff, 0));
    losses.push(Math.max(-diff, 0));
  }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < data.length; i++) {
    if (avgLoss === 0) {
      result[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      result[i] = 100 - 100 / (1 + rs);
    }
    if (i < data.length - 1) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    }
  }
  return result;
}

async function main() {
  const dateStr = "2026-06-11";
  const ticker = "3436.T";
  const symbol = ticker.replace(/\.T$/, "");
  const jqCode = `${symbol}0`;
  
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${dateStr}&to=${dateStr}`;
  console.log(`\nAPI URL: ${url}`);
  
  const resp = await fetch(url, { headers: { "x-api-key": JQUANTS_API_KEY } });
  console.log(`HTTP Status: ${resp.status}`);
  
  if (!resp.ok) {
    const body = await resp.text();
    console.log(`Error: ${body}`);
    return;
  }
  
  const json = await resp.json() as { data?: any[] };
  const bars = json.data ?? [];
  console.log(`取得バー数: ${bars.length}`);
  
  if (bars.length > 0) {
    console.log(`最初のバー:`, JSON.stringify(bars[0]));
    console.log(`最後のバー:`, JSON.stringify(bars[bars.length - 1]));
  }
  
  // 9:00〜15:30でフィルタ
  const filtered = bars.filter((b: any) => {
    const [hh, mm] = b.Time.split(":").map(Number);
    const t = hh * 60 + mm;
    return t >= 9 * 60 && t <= 15 * 60 + 30;
  });
  console.log(`フィルタ後: ${filtered.length}本`);
  
  if (filtered.length === 0) {
    console.log("データなし");
    return;
  }
  
  const closes = filtered.map((b: any) => b.C);
  const ma5 = calcMA(closes, 5);
  const ma25 = calcMA(closes, 25);
  const rsi = calcRSI(closes, 14);
  
  // 最初の30本の指標値を確認
  console.log("\n=== 最初の30本の指標値 ===");
  for (let i = 0; i < Math.min(30, filtered.length); i++) {
    const b = filtered[i];
    console.log(`${b.Time}: close=${b.C}, ma5=${ma5[i]?.toFixed(1) ?? "null"}, ma25=${ma25[i]?.toFixed(1) ?? "null"}, rsi=${rsi[i]?.toFixed(1) ?? "null"}`);
  }
  
  // null以外の最初の指標値
  const firstValidRsi = rsi.findIndex(v => v !== null);
  const firstValidMa25 = ma25.findIndex(v => v !== null);
  console.log(`\nRSI最初の有効値: インデックス${firstValidRsi} (${filtered[firstValidRsi]?.Time})`);
  console.log(`MA25最初の有効値: インデックス${firstValidMa25} (${filtered[firstValidMa25]?.Time})`);
  
  // 全体の有効率
  const validCount = rsi.filter(v => v !== null).length;
  console.log(`RSI有効本数: ${validCount}/${filtered.length}`);
}

main().catch(console.error);
