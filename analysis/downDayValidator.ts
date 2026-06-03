/**
 * downDayValidator.ts
 * 検証専用シミュレータ（本番ロジックを5分足スケールに圧縮して再現）。
 *
 * 目的: 1分足では取得できない過去の「日中ずっと下げた下落日」(5/14,5/15,5/19,5/27)に対して、
 *   - 空売り（下落トレンド中の戻り売り）が発火するか
 *   - 損切り/建値ストップ/トレイリングで損失が抑えられるか
 *   - デイリーストップ（口座-15,000円で新規停止）が機能するか
 * を観察する。
 *
 * 本番(realSimulation.ts)との対応:
 *   MA25 → MA10、SLOPE_LOOKBACK 25 → 8、WARMUP 10 → 4、FLOW_LOOKBACK 10 → 5、MA5 → MA3。
 *   ロジック（GC/DC, 押し目買い, 戻り売り厳選 RSI>=55+MA近辺, トレイリング, 建値ストップ, 12時台抑制,
 *   レジームゲート, 損切り2.0%）はすべて本番と同一の判定式を踏襲する。
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/downDayValidator.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";
import { applyPortfolioRules, DEFAULT_PORTFOLIO_CONFIG, type PerStockTrades } from "../server/portfolio";

// ---- 圧縮スケール定数（5分足用） ----
const MA_FAST = 3;
const MA_SLOW = 10;
const RSI_PERIOD = 9;
const BB_PERIOD = 10;
const SLOPE_LOOKBACK = 8;
const FLOW_LOOKBACK = 5;
const WARMUP_BARS = 4;
const SLOPE_THRESHOLD = 0.0006;     // 5分足なので1分足(0.0003)より大きめ
const SHORT_RSI_MIN = 55;
const SHORT_NEAR_MA = 0.006;
const SHORT_BREAKDOWN_RSI_MIN = 35;
const PULLBACK_RSI = 45;
const PULLBACK_NEAR_MA = 0.006;
const MARKET_REGIME_THRESHOLD = 0.004;
const BREAKEVEN_TRIGGER = 0.005;
const TRAIL_TRIGGER = 0.01;
const TRAIL_GAP = 0.005;
const MAX_TRADES_PER_DAY = 4;
const CIRCUIT_BREAKER = 20000;
const HIGH_VOL_DAY_THRESHOLD = 0.08;
const STOP_LOSS = 0.02;
const SUPPRESS_ENTRY_HOURS = new Set([12]);
const HIGH_VOL_SYMBOLS = new Set(["9984", "4568", "6526", "9107", "6723", "5803", "8316", "7203", "5016"]);
const LOT_NORMAL = 0.49;
const LOT_SMALL = 0.05;
const INITIAL_CAPITAL = 3_000_000;

interface Candle { time: string; hour: number; open: number; high: number; low: number; close: number; volume: number; ma5: number | null; ma25: number | null; rsi: number | null; bbUpper: number | null; bbLower: number | null; flow: number | null; slope: number | null; }

function calcMA(d: number[], p: number) { const r: (number|null)[] = new Array(d.length).fill(null); for (let i=p-1;i<d.length;i++){ r[i]=d.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p; } return r; }
function calcRSI(d: number[], p=14) { const r: (number|null)[] = new Array(d.length).fill(null); if(d.length<p+1)return r; const g:number[]=[],l:number[]=[]; for(let i=1;i<d.length;i++){const x=d[i]-d[i-1];g.push(Math.max(x,0));l.push(Math.max(-x,0));} let ag=g.slice(0,p).reduce((a,b)=>a+b,0)/p, al=l.slice(0,p).reduce((a,b)=>a+b,0)/p; for(let i=p;i<d.length;i++){ r[i]= al===0?100:100-100/(1+ag/al); if(i<d.length-1){ag=(ag*(p-1)+g[i])/p;al=(al*(p-1)+l[i])/p;} } return r; }
function calcBB(d: number[], p=20, m=2) { const u:(number|null)[]=new Array(d.length).fill(null), lo:(number|null)[]=new Array(d.length).fill(null); for(let i=p-1;i<d.length;i++){const w=d.slice(i-p+1,i+1);const a=w.reduce((x,y)=>x+y,0)/p;const v=w.reduce((x,y)=>x+(y-a)**2,0)/p;const s=Math.sqrt(v);u[i]=a+m*s;lo[i]=a-m*s;} return {upper:u,lower:lo}; }

async function fetchByDay(ticker: string): Promise<Map<string, Candle[]>> {
  const raw = await callDataApi("YahooFinance/get_stock_chart", { query: { symbol: ticker, region: "JP", interval: "5m", range: "1mo" } }) as { chart?: { result?: Array<{ timestamp: number[]; indicators: { quote: Array<{ open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[] }> } }> } };
  const result = raw?.chart?.result?.[0];
  const byDay = new Map<string, Candle[]>();
  if (!result) return byDay;
  const ts = result.timestamp ?? [];
  const q = result.indicators.quote[0];
  for (let i=0;i<ts.length;i++){
    const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i];
    if(o==null||c==null)continue;
    const jst=new Date(ts[i]*1000+9*3600*1000);
    const day=`${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`;
    const hh=jst.getUTCHours(), mm=jst.getUTCMinutes();
    const arr=byDay.get(day)??[];
    arr.push({time:`${String(hh).padStart(2,"0")}:${String(mm).padStart(2,"0")}`,hour:hh,open:o,high:h??o,low:l??o,close:c,volume:v??0,ma5:null,ma25:null,rsi:null,bbUpper:null,bbLower:null,flow:null,slope:null});
    byDay.set(day,arr);
  }
  return byDay;
}

function enrich(bars: Candle[]) {
  const closes = bars.map(b=>b.close);
  const ma5=calcMA(closes,MA_FAST), ma25=calcMA(closes,MA_SLOW), rsi=calcRSI(closes,RSI_PERIOD), bb=calcBB(closes,BB_PERIOD,2);
  bars.forEach((c,i)=>{c.ma5=ma5[i];c.ma25=ma25[i];c.rsi=rsi[i];c.bbUpper=bb.upper[i];c.bbLower=bb.lower[i];});
  const signed=bars.map(c=>{const r=(c.high-c.low)||1;const clv=((c.close-c.low)-(c.high-c.close))/r;return clv*c.volume;});
  bars.forEach((c,i)=>{ if(i>=FLOW_LOOKBACK-1){let s=0;for(let k=i-FLOW_LOOKBACK+1;k<=i;k++)s+=signed[k];c.flow=s;} if(i>=SLOPE_LOOKBACK&&c.ma25!=null){const pm=bars[i-SLOPE_LOOKBACK].ma25;if(pm!=null&&pm!==0)c.slope=(c.ma25-pm)/pm;} });
}

interface Trade { time: string; type: "buy"|"sell"|"short"|"cover"; price: number; profit?: number; }

// 本番ロジックを圧縮スケールで再現した1銘柄シミュレーション
function simulate(symbol: string, bars: Candle[], mktBias: number): { trades: Trade[]; longP: number; shortP: number; shortEntries: number } {
  const trades: Trade[] = [];
  let longShares=0,longEntry=0,longHigh=0, shortShares=0,shortEntry=0,shortLow=0;
  let realized=0,tradeCount=0,halted=false,longP=0,shortP=0,shortEntries=0;
  const lot = HIGH_VOL_SYMBOLS.has(symbol)?LOT_SMALL:LOT_NORMAL;
  const capital = INITIAL_CAPITAL*lot;
  const dayOpen=bars[0]?.open??0, dayHigh=Math.max(...bars.map(b=>b.high)), dayLow=Math.min(...bars.map(b=>b.low));
  const dayRange=dayOpen>0?(dayHigh-dayLow)/dayOpen:0;
  const isHighVolDay=dayRange>=HIGH_VOL_DAY_THRESHOLD;
  const mktUp=mktBias>MARKET_REGIME_THRESHOLD, mktDown=mktBias<-MARKET_REGIME_THRESHOLD;

  for(let i=1;i<bars.length;i++){
    const curr=bars[i],prev=bars[i-1];
    if(curr.rsi==null||curr.ma5==null||curr.ma25==null||curr.bbLower==null||curr.bbUpper==null||prev.ma5==null||prev.ma25==null)continue;
    const slope=curr.slope??0, flow=curr.flow??0;
    const trendUp=slope>SLOPE_THRESHOLD, trendDown=slope<-SLOPE_THRESHOLD;
    const flowUp=flow>0, flowDown=flow<0;
    const inWarmup=i<WARMUP_BARS;
    const suppressByHour=SUPPRESS_ENTRY_HOURS.has(curr.hour);
    const allowLong = trendUp&&flowUp&&!mktDown&&!inWarmup&&!halted&&!suppressByHour;
    const allowShort = trendDown&&flowDown&&!mktUp&&!inWarmup&&!halted&&!isHighVolDay&&!suppressByHour;
    const isGC=prev.ma5<=prev.ma25&&curr.ma5>curr.ma25;
    const isDC=prev.ma5>=prev.ma25&&curr.ma5<curr.ma25;
    const isBbLower=curr.close<=curr.bbLower, isBbUpper=curr.close>=curr.bbUpper;
    const isRsiOversold=curr.rsi<=30, isRsiOverbought=curr.rsi>=70;

    // ---- ロング決済（トレイリング/建値/損切り/反転） ----
    if(longShares>0){
      if(curr.close>longHigh)longHigh=curr.close;
      const gain=(curr.close-longEntry)/longEntry;
      let stopLine=longEntry*(1-STOP_LOSS);
      if(gain>BREAKEVEN_TRIGGER)stopLine=Math.max(stopLine,longEntry);
      let exit=false,reason="";
      if(curr.close<=stopLine){exit=true;reason="stop";}
      else if(gain>TRAIL_TRIGGER&&curr.close<=longHigh*(1-TRAIL_GAP)){exit=true;reason="trail";}
      else if(isGC===false&&(isRsiOverbought&&isBbUpper)){exit=true;reason="reversal";}
      if(exit){const profit=(curr.close-longEntry)*longShares;realized+=profit;longP+=profit;tradeCount++;if(realized<=-CIRCUIT_BREAKER)halted=true;trades.push({time:curr.time,type:"sell",price:curr.close,profit});longShares=0;void reason;}
    }
    // ---- ショート決済（トレイリング/建値/損切り/反転） ----
    if(shortShares>0){
      if(curr.close<shortLow)shortLow=curr.close;
      const gain=(shortEntry-curr.close)/shortEntry;
      let stopLine=shortEntry*(1+STOP_LOSS);
      if(gain>BREAKEVEN_TRIGGER)stopLine=Math.min(stopLine,shortEntry);
      let exit=false;
      if(curr.close>=stopLine)exit=true;
      else if(gain>TRAIL_TRIGGER&&curr.close>=shortLow*(1+TRAIL_GAP))exit=true;
      else if(isGC||(isRsiOversold&&isBbLower))exit=true;
      if(exit){const profit=(shortEntry-curr.close)*shortShares;realized+=profit;shortP+=profit;tradeCount++;if(realized<=-CIRCUIT_BREAKER)halted=true;trades.push({time:curr.time,type:"cover",price:curr.close,profit});shortShares=0;}
    }

    // ---- ロングエントリー ----
    const nearMA=curr.ma25>0&&Math.abs(curr.close-curr.ma25)/curr.ma25<=PULLBACK_NEAR_MA;
    const isPullbackBuy=slope>SLOPE_THRESHOLD&&curr.rsi<=PULLBACK_RSI&&nearMA&&curr.close>=curr.ma25;
    if(longShares===0&&shortShares===0&&allowLong&&tradeCount<MAX_TRADES_PER_DAY&&(isGC||isPullbackBuy||(isRsiOversold&&isBbLower))){
      const shares=Math.floor(capital/curr.close);
      if(shares>0){longShares=shares;longEntry=curr.close;longHigh=curr.close;trades.push({time:curr.time,type:"buy",price:curr.close});}
    }
    // ---- ショートエントリー（戻り売り厳選） ----
    const nearMAShort=curr.ma25>0&&Math.abs(curr.close-curr.ma25)/curr.ma25<=SHORT_NEAR_MA;
    const isPullbackShort=trendDown&&curr.rsi>=SHORT_RSI_MIN&&nearMAShort&&curr.close<=curr.ma25;
    const isStrongDownForShort=curr.ma5<curr.ma25&&curr.close<curr.ma25;
    const isBreakdownShort=mktDown&&trendDown&&isStrongDownForShort&&flowDown&&curr.rsi>SHORT_BREAKDOWN_RSI_MIN&&curr.rsi<70;
    if(longShares===0&&shortShares===0&&allowShort&&tradeCount<MAX_TRADES_PER_DAY&&(isPullbackShort||isBreakdownShort||(isRsiOverbought&&isBbUpper))){
      const shares=Math.floor(capital/curr.close);
      if(shares>0){shortShares=shares;shortEntry=curr.close;shortLow=curr.close;shortEntries++;trades.push({time:curr.time,type:"short",price:curr.close});}
    }
  }
  // 引け強制決済
  const last=bars[bars.length-1];
  if(longShares>0){const profit=(last.close-longEntry)*longShares;longP+=profit;trades.push({time:last.time,type:"sell",price:last.close,profit});}
  if(shortShares>0){const profit=(shortEntry-last.close)*shortShares;shortP+=profit;trades.push({time:last.time,type:"cover",price:last.close,profit});}
  return {trades,longP,shortP,shortEntries};
}

async function main(){
  const TARGET_DAYS=["2026-05-14","2026-05-15","2026-05-19","2026-05-27"];
  console.log("[validator] Fetching 5m data...");
  const byTicker=new Map<string,Map<string,Candle[]>>();
  for(const s of TARGET_STOCKS){ try{byTicker.set(s.symbol,await fetchByDay(s.ticker));}catch{} await new Promise(r=>setTimeout(r,300)); }

  console.log("\n===== 下落日 検証（5分足スケール・本番ロジック圧縮版） =====");
  console.log("day\tbias%\tlong損益\tshort件\tshort損益\t全銘柄合計\tポートフォリオ\tデイリーストップ");
  for(const day of TARGET_DAYS){
    const perStock: PerStockTrades[]=[];
    let longP=0,shortP=0,shortEntries=0,biasSum=0,cnt=0;
    for(const s of TARGET_STOCKS){
      const bars=byTicker.get(s.symbol)?.get(day);
      if(!bars||bars.length<20)continue;
      enrich(bars);
      const chg=bars[0].open>0?(bars[bars.length-1].close-bars[0].open)/bars[0].open:0;
      biasSum+=chg;cnt++;
    }
    const mktBias=cnt>0?biasSum/cnt:0;
    for(const s of TARGET_STOCKS){
      const bars=byTicker.get(s.symbol)?.get(day);
      if(!bars||bars.length<20)continue;
      const r=simulate(s.symbol,bars,mktBias);
      longP+=r.longP;shortP+=r.shortP;shortEntries+=r.shortEntries;
      perStock.push({symbol:s.symbol,trades:r.trades.map(t=>({time:t.time,type:t.type,price:t.price,shares:0,totalAmount:0,profit:t.profit}))} as PerStockTrades);
    }
    const port=applyPortfolioRules(perStock,{...DEFAULT_PORTFOLIO_CONFIG,dailyLossLimit:15000,dailyProfitTarget:0,momentumAllocation:true});
    const total=longP+shortP;
    console.log(`${day}\t${(mktBias*100).toFixed(2)}\t${Math.round(longP)}\t${shortEntries}\t${Math.round(shortP)}\t${Math.round(total)}\t${Math.round(port.acceptedProfit)}\t${port.dailyStopTriggered?port.dailyStopReason:"-"}`);
  }
  console.log("\n注: long損益=買いの合計損益, short損益=空売りの合計損益, ポートフォリオ=同時3銘柄制限+デイリーストップ適用後の採用損益。");
}
main().catch(e=>{console.error(e);process.exit(1);});
