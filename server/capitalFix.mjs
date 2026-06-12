// 現物300万円で現実的に取引できる条件を計算
const CAPITAL = 3_000_000;
const MARGIN_RATIO = 3.3; // 信用取引レバレッジ上限
const MAX_INVEST = CAPITAL * MARGIN_RATIO; // 最大投資可能額

// 今日の最大同時ポジション数: 18銘柄
// 最大同時投資額: 54,376,500円
// 1銘柄あたり平均投資額: 3,116,102円

console.log("=== 現実的な設定の試算 ===\n");

// 案1: 1銘柄あたりの投資額を下げる（LOT_RATIOを変更）
// 現在: 1銘柄300万円 × 90% = 270万円/銘柄
// 最大18銘柄同時 → 4860万円必要
// 証拠金300万円で信用3.3倍 → 最大990万円
// 990万円 ÷ 18銘柄 = 55万円/銘柄
const maxPerStock_18 = MAX_INVEST / 18;
console.log(`案1: 最大18銘柄同時保有を前提`);
console.log(`  1銘柄あたり最大投資額: ${Math.round(maxPerStock_18).toLocaleString()}円`);
console.log(`  現在の設定(270万円)に対して: ${(maxPerStock_18/2_700_000*100).toFixed(1)}%`);
console.log(`  LOT_RATIO変更: 0.9 → ${(maxPerStock_18/3_000_000).toFixed(3)}`);
console.log();

// 案2: 同時保有銘柄数を制限する（MAX_POSITIONS）
// 1銘柄270万円を維持する場合
const maxPositions = Math.floor(MAX_INVEST / 2_700_000);
console.log(`案2: 1銘柄270万円を維持する場合`);
console.log(`  最大同時保有可能銘柄数: ${maxPositions}銘柄`);
console.log(`  (証拠金300万 × 3.3倍 ÷ 270万円/銘柄)`);
console.log();

// 案3: 証拠金を増やす
const requiredCapital = 54_376_500 / MARGIN_RATIO;
console.log(`案3: 今日の最大同時投資額(5437万円)を賄うために必要な証拠金`);
console.log(`  必要証拠金: ${Math.round(requiredCapital).toLocaleString()}円（約${Math.round(requiredCapital/10000)}万円）`);
console.log();

// 現実的な運用シミュレーション（案2: 最大3銘柄同時）
console.log("=== 現実的な運用（最大3銘柄同時・1銘柄270万円）===");
console.log(`証拠金: 300万円`);
console.log(`信用取引上限: 990万円`);
console.log(`1銘柄投資額: 270万円`);
console.log(`最大同時保有: 3銘柄（270万×3=810万円 < 990万円）`);
console.log(`1日の取引数: 現在78件 → 最大3銘柄制限で大幅減少`);
console.log();

// 高額株の問題
console.log("=== 高額株の問題 ===");
const highPriceStocks = [
  { name: "キオクシアHD", price: 81330, shares: 100, invest: 8133000 },
  { name: "東京エレクトロン", price: 69490, shares: 100, invest: 6949000 },
  { name: "レーザーテック", price: 43600, shares: 100, invest: 4360000 },
];
for (const s of highPriceStocks) {
  console.log(`${s.name}: ${s.shares}株 × ${s.price.toLocaleString()}円 = ${s.invest.toLocaleString()}円`);
  console.log(`  → 証拠金300万円で信用取引: ${s.invest <= MAX_INVEST ? "✓ 可能" : "✗ 不可能（1銘柄だけで証拠金超過）"}`);
}
