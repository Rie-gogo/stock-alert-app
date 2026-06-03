import { callDataApi } from "../server/_core/dataApi";

async function probe(interval: string, range: string) {
  const raw = await callDataApi("YahooFinance/get_stock_chart", {
    query: { symbol: "9984.T", region: "JP", interval, range },
  }) as { chart?: { result?: Array<{ timestamp: number[] }> } };
  const ts = raw?.chart?.result?.[0]?.timestamp ?? [];
  const days = new Set<string>();
  for (const t of ts) {
    const jst = new Date(t * 1000 + 9 * 3600 * 1000);
    days.add(`${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`);
  }
  console.log(`interval=${interval} range=${range}: bars=${ts.length}, days=${days.size}`);
}

async function main() {
  await probe("1m", "5d");
  await probe("5m", "1mo");
  await probe("5m", "2mo");
}
main().catch(e => { console.error(e); process.exit(1); });
