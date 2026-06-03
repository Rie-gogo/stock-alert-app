/**
 * analysis/checkStopReasons.ts
 * signals[].reason の実際の値を確認する
 */
import * as fs from "fs";
import * as path from "path";
import { simulateStockReal, SHORT_STOP_LOSS_PERCENT, LUNCH_EXIT_ALL_MINUTE } from "../server/realSimulation";
import { TARGET_STOCKS } from "../shared/stocks";

interface JqBar { Date: string; Time: string; Code: string; O: number; H: number; L: number; C: number; Vo: number; Va: number; }

const DATA_DIR = path.join(process.cwd(), "analysis", "jq_data");

const s = TARGET_STOCKS[0];
const fp = path.join(DATA_DIR, s.symbol + ".json");
const bars = JSON.parse(fs.readFileSync(fp, "utf8")) as JqBar[];
const byDay = new Map<string, JqBar[]>();
for (const b of bars) { const arr = byDay.get(b.Date) ?? []; arr.push(b); byDay.set(b.Date, arr); }
const days = Array.from(byDay.keys()).sort();

const reasonSet = new Set<string>();

for (const day of days) {
  const dayBars = byDay.get(day);
  if (!dayBars || dayBars.length < 60) continue;
  const candles = dayBars.sort((a, b) => a.Time.localeCompare(b.Time)).map(b => ({
    time: b.Time, timestamp: 0, open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, () => 0, 3_000_000, 70, 30, 2.0, false, 1.0, {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
  });
  if (!res) continue;
  for (const sig of res.signals ?? []) {
    if (sig.reason) reasonSet.add(sig.reason);
  }
}

console.log("=== 全 signal reason の種類 ===");
for (const r of Array.from(reasonSet).sort()) {
  console.log(" ", JSON.stringify(r));
}

// trades の全フィールドを確認
console.log("\n=== trades の全フィールド（最初の取引）===");
const day0 = days[10];
const dayBars0 = byDay.get(day0);
if (dayBars0 && dayBars0.length >= 60) {
  const candles = dayBars0.sort((a, b) => a.Time.localeCompare(b.Time)).map(b => ({
    time: b.Time, timestamp: 0, open: b.O, high: b.H, low: b.L, close: b.C, volume: b.Vo,
    ma5: null, ma25: null, rsi: null, bbUpper: null, bbLower: null, flow: null, slope: null,
  }));
  const res = simulateStockReal(s.symbol, s.ticker, s.name, candles, () => 0, 3_000_000, 70, 30, 2.0, false, 1.0, {
    shortStopLossPercent: SHORT_STOP_LOSS_PERCENT,
    lunchExitAllMinute: LUNCH_EXIT_ALL_MINUTE,
  });
  if (res && res.trades.length > 0) {
    console.log("  trades[0]:", JSON.stringify(res.trades[0], null, 2));
    console.log("  signals[0]:", JSON.stringify(res.signals?.[0], null, 2));
    console.log("  lossCauses:", res.lossCauses);
  }
}
