/**
 * downDayDiag.ts
 * 下落日に空売りが発火しない原因を、条件別の成立カウントで切り分ける診断スクリプト。
 * 5/15 の代表銘柄数本について、各バーで以下のどこで弾かれているかを集計する。
 *   trendDown(slope<閾値) / flowDown / RSI>=55 / MA近辺 / close<=ma25
 *
 * 実行: cd /home/ubuntu/stock-alert-app && npx tsx analysis/downDayDiag.ts
 */
import { callDataApi } from "../server/_core/dataApi";
import { TARGET_STOCKS } from "../shared/stocks";

const MA_FAST=3, MA_SLOW=10, RSI_PERIOD=9, SLOPE_LOOKBACK=8, FLOW_LOOKBACK=5, WARMUP=4;
const SLOPE_THRESHOLD=0.0006, SHORT_RSI_MIN=55, SHORT_NEAR_MA=0.006;

function calcMA(d:number[],p:number){const r:(number|null)[]=new Array(d.length).fill(null);for(let i=p-1;i<d.length;i++)r[i]=d.slice(i-p+1,i+1).reduce((a,b)=>a+b,0)/p;return r;}
function calcRSI(d:number[],p:number){const r:(number|null)[]=new Array(d.length).fill(null);if(d.length<p+1)return r;const g:number[]=[],l:number[]=[];for(let i=1;i<d.length;i++){const x=d[i]-d[i-1];g.push(Math.max(x,0));l.push(Math.max(-x,0));}let ag=g.slice(0,p).reduce((a,b)=>a+b,0)/p,al=l.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<d.length;i++){r[i]=al===0?100:100-100/(1+ag/al);if(i<d.length-1){ag=(ag*(p-1)+g[i])/p;al=(al*(p-1)+l[i])/p;}}return r;}

interface Bar{open:number;high:number;low:number;close:number;volume:number;}
async function fetchDay(ticker:string,day:string):Promise<Bar[]>{
  const raw=await callDataApi("YahooFinance/get_stock_chart",{query:{symbol:ticker,region:"JP",interval:"5m",range:"1mo"}}) as {chart?:{result?:Array<{timestamp:number[];indicators:{quote:Array<{open:(number|null)[];high:(number|null)[];low:(number|null)[];close:(number|null)[];volume:(number|null)[]}>}}>}};
  const res=raw?.chart?.result?.[0]; const out:Bar[]=[]; if(!res)return out;
  const ts=res.timestamp??[],q=res.indicators.quote[0];
  for(let i=0;i<ts.length;i++){const o=q.open[i],h=q.high[i],l=q.low[i],c=q.close[i],v=q.volume[i];if(o==null||c==null)continue;const jst=new Date(ts[i]*1000+9*3600*1000);const d=`${jst.getUTCFullYear()}-${String(jst.getUTCMonth()+1).padStart(2,"0")}-${String(jst.getUTCDate()).padStart(2,"0")}`;if(d!==day)continue;out.push({open:o,high:h??o,low:l??o,close:c,volume:v??0});}
  return out;
}

async function main(){
  const day="2026-05-15";
  const symbols=["6526","6920","8035","6758","7011"];
  console.log(`診断日: ${day}\n`);
  for(const sym of symbols){
    const st=TARGET_STOCKS.find(s=>s.symbol===sym); if(!st)continue;
    const bars=await fetchDay(st.ticker,day); await new Promise(r=>setTimeout(r,300));
    if(bars.length<20){console.log(`${sym} ${st.name}: データ不足(${bars.length}本)`);continue;}
    const closes=bars.map(b=>b.close);
    const ma5=calcMA(closes,MA_FAST),ma25=calcMA(closes,MA_SLOW),rsi=calcRSI(closes,RSI_PERIOD);
    const slope:(number|null)[]=new Array(bars.length).fill(null);
    for(let i=SLOPE_LOOKBACK;i<bars.length;i++){const pm=ma25[i-SLOPE_LOOKBACK];if(pm!=null&&pm!==0&&ma25[i]!=null)slope[i]=((ma25[i] as number)-pm)/pm;}
    const signed=bars.map(c=>{const r=(c.high-c.low)||1;return ((c.close-c.low)-(c.high-c.close))/r*c.volume;});
    const flow:(number|null)[]=new Array(bars.length).fill(null);
    for(let i=FLOW_LOOKBACK-1;i<bars.length;i++){let s=0;for(let k=i-FLOW_LOOKBACK+1;k<=i;k++)s+=signed[k];flow[i]=s;}

    let valid=0,cTrendDown=0,cFlowDown=0,cRsi=0,cNearMA=0,cBelowMA=0,cAll=0;
    let minSlope=1,maxSlope=-1,maxRsiWhenTrendDown=0;
    for(let i=WARMUP;i<bars.length;i++){
      if(ma5[i]==null||ma25[i]==null||rsi[i]==null||slope[i]==null||flow[i]==null)continue;
      valid++;
      const sl=slope[i] as number, fl=flow[i] as number, r=rsi[i] as number, c=bars[i].close, m=ma25[i] as number;
      if(sl<minSlope)minSlope=sl; if(sl>maxSlope)maxSlope=sl;
      const trendDown=sl<-SLOPE_THRESHOLD;
      const flowDown=fl<0;
      const rsiOk=r>=SHORT_RSI_MIN;
      const nearMA=m>0&&Math.abs(c-m)/m<=SHORT_NEAR_MA;
      const belowMA=c<=m;
      if(trendDown){cTrendDown++; if(r>maxRsiWhenTrendDown)maxRsiWhenTrendDown=r;}
      if(flowDown)cFlowDown++;
      if(rsiOk)cRsi++;
      if(nearMA)cNearMA++;
      if(belowMA)cBelowMA++;
      if(trendDown&&rsiOk&&nearMA&&belowMA)cAll++;
    }
    console.log(`${sym} ${st.name} (有効${valid}本)`);
    console.log(`  slope範囲: ${minSlope.toFixed(4)} ~ ${maxSlope.toFixed(4)} (閾値=-${SLOPE_THRESHOLD})`);
    console.log(`  trendDown成立: ${cTrendDown}本  flowDown: ${cFlowDown}本  RSI>=55: ${cRsi}本  MA近辺: ${cNearMA}本  close<=ma25: ${cBelowMA}本`);
    console.log(`  下落トレンド時の最大RSI: ${maxRsiWhenTrendDown.toFixed(1)}`);
    console.log(`  空売り条件(全成立): ${cAll}本\n`);
  }
}
main().catch(e=>{console.error(e);process.exit(1);});
