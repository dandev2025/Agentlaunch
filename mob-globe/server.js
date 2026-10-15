// Trade Globe live relay. Sources: pump.fun (PumpPortal, no key) + Jupiter/Raydium/Orca/Meteora (Solana RPC, needs HELIUS_KEY)
// Run: HELIUS_KEY=yourkey npm start   (Node 18+) then open http://localhost:8080
import http from "node:http";import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
import WebSocket,{WebSocketServer} from "ws";
const PORT=process.env.PORT||8080,KEY=process.env.HELIUS_KEY,dir=path.dirname(fileURLToPath(import.meta.url));
const WSU=process.env.RPC_WS||`wss://mainnet.helius-rpc.com/?api-key=${KEY}`,HTTP=process.env.RPC_HTTP||`https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const HUBS=[["New York",-74,40.7,0],["Miami",-80,25.8,0],["San Francisco",-122,37.8,0],["Toronto",-79,43.7,0],["Sao Paulo",-46.6,-23.5,0],
["London",-0.1,51.5,1],["Berlin",13.4,52.5,1],["Madrid",-3.7,40.4,1],["Istanbul",29,41,1],["Dubai",55.3,25.3,1],
["Singapore",103.8,1.35,2],["Tokyo",139.7,35.7,2],["Seoul",127,37.5,2],["Hong Kong",114,22.3,2],["Mumbai",72.9,19,2],["Sydney",151,-33.9,2]];
const CEN=[-80,10,105];
const act=(r,h)=>{const l=(h+CEN[r]/15+24)%24;return .15+.85*Math.max(0,Math.cos((l-15)/24*2*Math.PI))};
// Wallet stats. Region = naive-Bayes over trading hours (1-2 trades = weighted guess, 3+ = best match).
// Bot rule: 8+ trades inside 60s, or 15+ trades spread over 16+ UTC hours. Bots are not given a location.
const wallets=new Map(),bits=x=>{let c=0;while(x){c+=x&1;x>>=1}return c};
function touch(w){const now=Date.now(),h=new Date(now).getUTCHours();let e=wallets.get(w);if(!e)e={n:0,ll:[0,0,0],hrs:0,t:[],bot:false};
for(let r=0;r<3;r++)e.ll[r]+=Math.log(act(r,h));e.n++;e.hrs|=1<<h;e.t.push(now);if(e.t.length>8)e.t.shift();
if(!e.bot&&((e.t.length===8&&now-e.t[0]<60000)||(e.n>=15&&bits(e.hrs)>=16)))e.bot=true;
wallets.delete(w);wallets.set(w,e);if(wallets.size>50000)wallets.delete(wallets.keys().next().value);return e}
function pick(e){const m=Math.max(...e.ll),p=e.ll.map(v=>Math.exp(v-m));if(e.n>=3)return p.indexOf(1);
let u=Math.random()*(p[0]+p[1]+p[2]);for(let r=0;r<3;r++){u-=p[r];if(u<=0)return r}return 0}
let sol=150;async function price(){try{sol=(await(await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json()).solana.usd}catch{}}
price();setInterval(price,60000);
const server=http.createServer((q,r)=>{try{r.writeHead(200,{"content-type":"text/html"});r.end(fs.readFileSync(path.join(dir,"index.html")))}catch{r.writeHead(404);r.end()}});
const wss=new WebSocketServer({server,path:"/stream"});
// Tracked wallets: browsers send {pin:"<address>"}; the server then follows every trade from that wallet (no sampling)
const watched=new Set(),B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
wss.on("connection",c=>c.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(typeof m.pin==="string"&&B58.test(m.pin))watch(m.pin)}));
function watch(w){if(watched.has(w)||watched.size>=50)return;watched.add(w);if(up?.readyState===1)cmd("subscribeAccountTrade",w);if(sw?.readyState===1)subWallet(w)}
const subWallet=w=>sw.send(JSON.stringify({jsonrpc:"2.0",id:"w"+Math.random(),method:"logsSubscribe",params:[{mentions:[w]},{commitment:"confirmed"}]}));
const out=(sym,buy,usd,venue,wallet,logo,mint,sig)=>{const e=wallets.get(wallet)||touch(wallet),bot=e.bot,r=bot?-1:pick(e),pool=HUBS.filter(h=>h[3]===r),h=bot?["Bots",0,0,-1]:pool[Math.random()*pool.length|0],
m=JSON.stringify({sym,buy,usd,venue,city:h[0],lon:h[1],lat:h[2],r,logo,wallet,mint,sig,n:e.n,bot});wss.clients.forEach(c=>c.readyState===1&&c.send(m));st.sent++};

// ---- pump.fun via PumpPortal ----
const meta=new Map(),subs=[];let up,last=0;const st={pump:0,pumpTrades:0,logs:0,queued:0,decoded:0,sent:0,err:"",tried:0,rpcErr:0,noTx:0,failedTx:0,noMint:0,swapSkip:0,small:0};
setInterval(()=>{console.log(`[10s] pump msgs ${st.pump} (trades ${st.pumpTrades}) | dex logs ${st.logs} queued ${st.queued} tried ${st.tried} (rpcErr ${st.rpcErr} notFound ${st.noTx} failedTx ${st.failedTx} noMint ${st.noMint} tokenForToken ${st.swapSkip} small ${st.small}) decoded ${st.decoded} | sent to browsers ${st.sent} | pump ${up?.readyState===1?"up":"DOWN"} dex ${sw?.readyState===1?"up":"DOWN"} | clients ${wss.clients.size}${st.err?" | last error: "+st.err:""}`);for(const k of ["pump","pumpTrades","logs","queued","decoded","sent","tried","rpcErr","noTx","failedTx","noMint","swapSkip","small"])st[k]=0;st.err=""},10000);
const cmd=(m,k)=>up.readyState===1&&up.send(JSON.stringify({method:m,keys:[k]}));
async function pLogo(mint){const m=meta.get(mint);if(!m?.uri)return;try{const j=await(await fetch(m.uri,{signal:AbortSignal.timeout(4000)})).json();if(meta.has(mint))m.logo=j.image}catch{}}
function pump(){up=new WebSocket("wss://pumpportal.fun/api/data");
up.on("open",()=>{up.send(JSON.stringify({method:"subscribeNewToken"}));subs.forEach(k=>cmd("subscribeTokenTrade",k));watched.forEach(w=>cmd("subscribeAccountTrade",w))});
up.on("message",raw=>{let d;try{d=JSON.parse(raw)}catch{return}st.pump++;if(d.txType!=="create"&&(st.samples=(st.samples||0)+1)<=6)console.log("[pump sample, not a new-token msg]",String(raw).slice(0,400));if(!d.mint)return;
if(d.txType==="create"){meta.set(d.mint,{sym:d.symbol,uri:d.uri});subs.push(d.mint);cmd("subscribeTokenTrade",d.mint);
if(subs.length>300){const o=subs.shift();cmd("unsubscribeTokenTrade",o);meta.delete(o)}pLogo(d.mint);return}
if((d.txType!=="buy"&&d.txType!=="sell")||!d.solAmount)return;st.pumpTrades++;touch(d.traderPublicKey);
const usd=Math.round(d.solAmount*sol),now=Date.now(),pin=watched.has(d.traderPublicKey);if(!pin&&usd<1000&&now-last<200)return;if(!pin)last=now;
const m=meta.get(d.mint),go=(s,l)=>out("$"+String(s).toUpperCase(),d.txType==="buy",usd,"pump.fun",d.traderPublicKey,l,d.mint,d.signature);if(m)go(m.sym||d.mint.slice(0,4),m.logo);else tokenInfo(d.mint).then(i=>go(i.sym,i.logo))});
up.on("close",()=>setTimeout(pump,3000));up.on("error",e=>{st.err="pump: "+e.message})}
pump();

// ---- Jupiter / Raydium / Orca / Meteora via Solana RPC ----
const PROG={JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4:"Jupiter",
"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8":"Raydium",CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK:"Raydium",CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C:"Raydium",
whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc:"Orca",LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo:"Meteora",Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB:"Meteora"};
const WSOL="So11111111111111111111111111111111111111112",USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const rpc=async(method,params)=>(await fetch(HTTP,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(8000)})).json();
const seen=new Set(),queue=[],tokMeta=new Map(),done=new Set(),pq=[],wsubs=new Set();let sw;
async function tokenInfo(mint){if(tokMeta.has(mint))return tokMeta.get(mint);let v={sym:mint.slice(0,4)};
try{const p=(await(await fetch("https://api.dexscreener.com/latest/dex/tokens/"+mint,{signal:AbortSignal.timeout(4000)})).json()).pairs?.[0];if(p)v={sym:p.baseToken.symbol,logo:p.info?.imageUrl}}catch{}
tokMeta.set(mint,v);if(tokMeta.size>5000)tokMeta.delete(tokMeta.keys().next().value);return v}
const bal=b=>parseFloat(b.uiTokenAmount.uiAmountString||"0");
async function decode(sig){if(done.has(sig))return;done.add(sig);if(done.size>5000)done.delete(done.values().next().value);st.tried++;const r=await rpc("getTransaction",[sig,{encoding:"jsonParsed",maxSupportedTransactionVersion:1,commitment:"confirmed"}]);if(r.error){st.rpcErr++;st.err="rpc: "+JSON.stringify(r.error).slice(0,160);return}const t=r.result;
if(!t){st.noTx++;return}if(t.meta?.err){st.failedTx++;return}const keys=t.transaction.message.accountKeys.map(k=>k.pubkey||k),signer=keys[0],m=t.meta,d=new Map();
for(const b of m.postTokenBalances||[])if(b.owner===signer)d.set(b.mint,(d.get(b.mint)||0)+bal(b));
for(const b of m.preTokenBalances||[])if(b.owner===signer)d.set(b.mint,(d.get(b.mint)||0)-bal(b));
const q=((m.postBalances[0]-m.preBalances[0]+m.fee)/1e9+(d.get(WSOL)||0))*sol+(d.get(USDC)||0);
let mint,amt=0;for(const[k,v]of d)if(k!==WSOL&&k!==USDC&&Math.abs(v)>Math.abs(amt)){mint=k;amt=v}
if(!mint){st.noMint++;return}const buy=amt>0,usd=Math.round(Math.abs(q));if((buy&&q>=0)||(!buy&&q<=0)){st.swapSkip++;return}if(usd<10){st.small++;return} // token-for-token swaps skipped
const venue=keys.map(k=>PROG[k]).sort((a,b)=>(b==="Jupiter")-(a==="Jupiter")).find(Boolean)||"DEX",i=await tokenInfo(mint);
st.decoded++;touch(signer);out("$"+String(i.sym).toUpperCase(),buy,usd,venue,signer,i.logo,mint,sig)}
setInterval(()=>{while(pq.length)decode(pq.shift()).catch(()=>{})},300); // tracked wallets: always decoded
setInterval(()=>{const i=queue.findLastIndex(x=>Date.now()-x.t>3000);if(i<0)return;const s=queue.splice(i,1)[0].sig;decode(s).catch(e=>{st.err="decode: "+e.message})},1000/(+process.env.DECODE_PER_SEC||0.4)); // sampled swaps, newest first. Each decode = 1 Helius credit
function dex(){sw=new WebSocket(WSU);let n=0;
sw.on("open",()=>watched.forEach(w=>subWallet(w)));
sw.on("open",()=>Object.keys(PROG).forEach(p=>sw.send(JSON.stringify({jsonrpc:"2.0",id:++n,method:"logsSubscribe",params:[{mentions:[p]},{commitment:"confirmed"}]}))));
sw.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}
if(typeof m.id==="string"&&m.id[0]==="w"&&m.result!=null)wsubs.add(m.result);
if(m.error)st.err=JSON.stringify(m.error).slice(0,200);const v=m.params?.result?.value;if(!v||v.err)return;st.logs++;
if(wsubs.has(m.params.subscription)){pq.push(v.signature);return} // tracked wallets skip sampling
if(seen.has(v.signature)||!v.logs.some(l=>/swap|route/i.test(l)))return;seen.add(v.signature);if(seen.size>5000)seen.delete(seen.values().next().value);queue.push({sig:v.signature,t:Date.now()});st.queued++;while(queue.length&&Date.now()-queue[0].t>30000)queue.shift();if(queue.length>3000)queue.shift()});
const ka=setInterval(()=>sw.readyState===1&&sw.ping(),30000);sw.on("close",()=>{clearInterval(ka);setTimeout(dex,3000)});sw.on("error",e=>{st.err="dex: "+e.message})}
if(KEY||process.env.RPC_WS)dex();else console.log("No HELIUS_KEY set: pump.fun only. Add a key to include Jupiter, Raydium, Orca and Meteora.");
server.listen(PORT,()=>console.log("Trade Globe on http://localhost:"+PORT));
