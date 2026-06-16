/**
 * fetch_new_days.ts
 * 6/11・6/12のデータをJ-Quantsから取得してjq_dataに追加する
 * 実行: cd /home/ubuntu/stock-alert-app && JQUANTS_API_KEY=xxx npx tsx analysis/fetch_new_days.ts
 */

import * as fs from "fs";
import * as path from "path";

const SYMBOLS = [
  "285A", "3436", "3778", "4568", "5016", "5803",
  "6526", "6723", "6758", "6857", "6920", "6976",
  "6981", "7011", "7203", "8035", "8306", "8316", "9107", "9984"
];

const NEW_DATES = ["2026-06-11", "2026-06-12"];
const DATA_DIR = path.join(process.cwd(), "analysis", "jq_data");

interface JqBar {
  Date: string;
  Time: string;
  Code: string;
  O: number;
  H: number;
  L: number;
  C: number;
  Vo: number;
  Va: number;
}

async function fetchBarsForDate(symbol: string, dateStr: string, apiKey: string): Promise<JqBar[]> {
  const jqCode = `${symbol}0`;
  const url = `https://api.jquants.com/v2/equities/bars/minute?code=${jqCode}&from=${dateStr}&to=${dateStr}`;
  const resp = await fetch(url, {
    headers: { "x-api-key": apiKey }
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json = await resp.json() as { data?: JqBar[]; pagination_key?: string | null };
  return json.data ?? [];
}

async function main() {
  const apiKey = process.env.JQUANTS_API_KEY;
  if (!apiKey) {
    console.error("JQUANTS_API_KEY が設定されていません");
    process.exit(1);
  }

  for (const symbol of SYMBOLS) {
    const fp = path.join(DATA_DIR, `${symbol}.json`);
    if (!fs.existsSync(fp)) {
      console.log(`  ${symbol}: ファイルなし、スキップ`);
      continue;
    }

    const existing = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
    const existingDates = new Set(existing.map(b => b.Date));
    
    let added = 0;
    for (const dateStr of NEW_DATES) {
      if (existingDates.has(dateStr)) {
        console.log(`  ${symbol} ${dateStr}: 既存データあり、スキップ`);
        continue;
      }
      
      try {
        const bars = await fetchBarsForDate(symbol, dateStr, apiKey);
        if (bars.length === 0) {
          console.log(`  ${symbol} ${dateStr}: データなし（休場日の可能性）`);
          continue;
        }
        existing.push(...bars);
        added += bars.length;
        console.log(`  ${symbol} ${dateStr}: ${bars.length}本追加`);
      } catch (e) {
        console.error(`  ${symbol} ${dateStr}: エラー - ${e}`);
      }
      
      // レート制限対策
      await new Promise(r => setTimeout(r, 200));
    }
    
    if (added > 0) {
      // 日付・時刻順にソート
      existing.sort((a, b) => {
        const da = `${a.Date}T${a.Time}`;
        const db = `${b.Date}T${b.Time}`;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      fs.writeFileSync(fp, JSON.stringify(existing, null, 2));
      console.log(`  ${symbol}: ${added}本追加して保存完了`);
    }
  }
  
  console.log("\n完了！");
}

main().catch(console.error);
