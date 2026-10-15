// Trade Globe live relay. Sources: pump.fun (PumpPortal, no key) + Jupiter/Raydium/Orca/Meteora (Solana RPC, needs HELIUS_KEY)
// Run: HELIUS_KEY=yourkey npm start   (Node 18+) then open http://localhost:8080
import crypto from "node:crypto";import http from "node:http";import fs from "node:fs";import path from "node:path";import {fileURLToPath} from "node:url";
import WebSocket,{WebSocketServer} from "ws";
import {createStore} from "./lib/store.js";
import {originAllowed,clientIp,createRateLimit,createConnLimit,backoff,cleanSym,safeUrl} from "./lib/limits.js";
const PORT=process.env.PORT||8080,KEY=process.env.HELIUS_KEY,dir=path.dirname(fileURLToPath(import.meta.url));
const WSU=process.env.RPC_WS||`wss://mainnet.helius-rpc.com/?api-key=${KEY}`,HTTP=process.env.RPC_HTTP||`https://mainnet.helius-rpc.com/?api-key=${KEY}`;
const HUBS=[["New York",-74,40.7,0],["Miami",-80,25.8,0],["San Francisco",-122,37.8,0],["Toronto",-79,43.7,0],["Sao Paulo",-46.6,-23.5,0],
["London",-0.1,51.5,1],["Berlin",13.4,52.5,1],["Madrid",-3.7,40.4,1],["Istanbul",29,41,1],["Dubai",55.3,25.3,1],
["Singapore",103.8,1.35,2],["Tokyo",139.7,35.7,2],["Seoul",127,37.5,2],["Hong Kong",114,22.3,2],["Mumbai",72.9,19,2],["Sydney",151,-33.9,2]];
const CEN=[-80,10,105];
const act=(r,h)=>{const l=(h+CEN[r]/15+24)%24;return .15+.85*Math.max(0,Math.cos((l-15)/24*2*Math.PI))};
// Wallet stats. Region = naive-Bayes over trading hours (1-2 trades = weighted guess, 3+ = best match).
// Bot rule: 8+ trades inside 60s, or 15+ trades spread over 16+ UTC hours. Bots are not given a location.
const ALLOWED=(process.env.ALLOWED_ORIGINS||"").split(",").map(x=>x.trim()).filter(Boolean),TRUST=process.env.TRUST_PROXY!=="0",httpRL=createRateLimit({max:120,windowMs:60000}),connLim=createConnLimit(8),globalConns=createConnLimit(400),msgRL=createRateLimit({max:10,windowMs:10000}),started=Date.now();
let lastOut=0,pb=0,db0=0,indexHtml=null;
const SEND_PER_SEC=+process.env.SEND_PER_SEC||8,SEND_BURST=30; // per-viewer cap keeps bandwidth (and the hosting bill) small; big trades and tracked wallets always go through
let lastDbErr="",loopLag=0,lagT=Date.now(),cpuPct=0,cpuPrev=process.cpuUsage(),cpuT=Date.now();
setInterval(()=>{const n=Date.now();loopLag=Math.max(loopLag*.8,n-lagT-250);lagT=n},250).unref();
setInterval(()=>{const u=process.cpuUsage(cpuPrev),n=Date.now();cpuPct=Math.round((u.user+u.system)/1000/(n-cpuT)*100);cpuPrev=process.cpuUsage();cpuT=n},5000).unref();
const LAUNCH=Date.parse(process.env.LAUNCH_DATE||"")||0;if(process.env.LAUNCH_DATE&&!LAUNCH)console.log("[db] LAUNCH_DATE is not a valid date (use e.g. 2026-10-16T00:00:00Z); counting from the first saved trade instead.");
const store=createStore({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_SERVICE_ROLE_KEY,launch:LAUNCH}),flowCache=new Map();
const wallets=new Map(),bits=x=>{let c=0;while(x){c+=x&1;x>>=1}return c};
function touch(w){const now=Date.now(),h=new Date(now).getUTCHours();let e=wallets.get(w);if(!e)e={n:0,ll:[0,0,0],hrs:0,t:[],bot:false};
for(let r=0;r<3;r++)e.ll[r]+=Math.log(act(r,h));e.n++;e.hrs|=1<<h;e.t.push(now);if(e.t.length>8)e.t.shift();
if(!e.bot&&((e.t.length===8&&now-e.t[0]<60000)||(e.n>=15&&bits(e.hrs)>=16)))e.bot=true;
wallets.delete(w);wallets.set(w,e);if(wallets.size>50000)wallets.delete(wallets.keys().next().value);return e}
function pick(e){const m=Math.max(...e.ll),p=e.ll.map(v=>Math.exp(v-m));if(e.n>=3)return p.indexOf(1);
let u=Math.random()*(p[0]+p[1]+p[2]);for(let r=0;r<3;r++){u-=p[r];if(u<=0)return r}return 0}
let sol=150;async function price(){try{sol=(await(await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json()).solana.usd}catch{}}
price();setInterval(price,60000);
const logoBuf=new Map(),logoP=new Map(),logoFail=new Map(),IPFS=["https://ipfs.io/ipfs/","https://cf-ipfs.com/ipfs/","https://gateway.pinata.cloud/ipfs/"];
const logoUrl=(mint,hint)=>{if(!mint)return;if(logoBuf.has(mint))return "/logo/"+mint;ensureLogo(mint,hint)};
async function grab(u){if(!safeUrl(u))throw new Error("blocked url");const r=await fetch(u,{signal:AbortSignal.timeout(4000),headers:{"user-agent":"Mozilla/5.0"}});const ct=r.headers.get("content-type")||"";if(!r.ok)throw new Error("HTTP "+r.status);if(!/^image\/(png|jpeg|gif|webp)\b/.test(ct))throw new Error("not image: "+ct.slice(0,30));const b=Buffer.from(await r.arrayBuffer());if(b.length>600000)throw new Error("too big");return{b,ct}}
function ensureLogo(mint,hint){if(logoBuf.has(mint))return Promise.resolve();if(logoP.has(mint))return logoP.get(mint);const f=logoFail.get(mint);if((f&&(f.n>=3||Date.now()-f.t<60000))||logoP.size>30)return Promise.resolve();
const p=(async()=>{const mk=list=>{const c=[];const add=u=>{if(!u||c.includes(u)||!safeUrl(u))return;c.push(u);const m=u.match(/\/ipfs\/(.+)$/);if(m)IPFS.forEach(g=>c.push(g+m[1]))};list.forEach(add);return c};
const first=[hint,meta.get(mint)?.logo];
if(!first.some(Boolean)&&meta.get(mint)?.uri){try{if(safeUrl(meta.get(mint).uri))first.push((await(await fetch(meta.get(mint).uri,{signal:AbortSignal.timeout(2500)})).json()).image)}catch{}}
const stage1=mk(first);if(mint.endsWith("pump"))stage1.push(`https://images.pump.fun/coin-image/${mint}?imageWidth=128&imageHeight=128`);stage1.push(`https://dd.dexscreener.com/ds-data/tokens/solana/${mint}.png`);
const race=async list=>{if(!list.length)throw new Error("no candidates");return await Promise.any(list.slice(0,8).map(x=>grab(x).catch(e=>{throw new Error(new URL(x).host+": "+e.message)})))};
let why="";
try{logoBuf.set(mint,await race(stage1))}catch(e){why=(e.errors||[e]).map(x=>x.message).slice(-1)[0]||"";try{const t=(await tokenInfo(mint)).logo;logoBuf.set(mint,await race(mk([t])))}catch(e2){const m2=(e2.errors||[e2]).map(x=>x.message).slice(-1)[0]||"";if(m2&&!/no candidates/.test(m2))why=m2}}
if(logoBuf.has(mint)){if(logoBuf.size>800)logoBuf.delete(logoBuf.keys().next().value);st.logoOk++;logoFail.delete(mint);return}
st.logoFail++;st.logoWhy=why;logoFail.set(mint,{t:Date.now(),n:(f?.n||0)+1})})().catch(()=>{}).finally(()=>logoP.delete(mint));logoP.set(mint,p);return p}
const server=http.createServer((q,r)=>{try{r.setHeader("x-content-type-options","nosniff");r.setHeader("referrer-policy","no-referrer");
if(q.url==="/healthz"){const up_=up?.readyState===1,dx=sw?.readyState===1||!(KEY||process.env.RPC_WS),age=lastOut?Date.now()-lastOut:null,grace=Date.now()-started<120000,ok=grace||(age!==null&&age<300000);r.writeHead(ok?200:503,{"content-type":"application/json","cache-control":"no-store"});return r.end(JSON.stringify({ok,uptimeS:Math.round((Date.now()-started)/1000),pump:up_,dex:dx,lastTradeAgeMs:age,clients:wss.clients.size,logos:{ok:st.logoOk,failed:st.logoFail,cached:logoBuf.size,lastFail:st.logoWhy},cpuPct,loopLagMs:Math.round(loopLag),build:(process.env.RENDER_GIT_COMMIT||"local").slice(0,7),dbError:lastDbErr||undefined,db:store.enabled?{saved:store.stat.flushed,failures:store.stat.failures}:"off"}))}
if((q.url.startsWith("/api/")||q.url.startsWith("/logo/"))&&!httpRL.hit(clientIp(q,TRUST))){r.writeHead(429);return r.end()}if(q.url==="/api/totals"){const send=(c,o)=>{r.writeHead(c,{"content-type":"application/json","cache-control":"no-store"});r.end(JSON.stringify(o))};if(!store.enabled)return send(503,{error:"database not configured"});const hit=flowCache.get("totals");if(hit&&Date.now()-hit.t<30000)return send(200,hit.d);store.totals().then(d=>{flowCache.set("totals",{t:Date.now(),d});send(200,d)}).catch(e=>{lastDbErr="totals: "+e.message;st.err="totals: "+e.message;send(502,{error:"query failed"})});return}
const fm=q.url.match(/^\/api\/flow\?range=(24h|7d|30d)$/);if(!fm&&q.url.startsWith("/api/")){r.writeHead(400);return r.end()}if(fm){const send=(c,o)=>{r.writeHead(c,{"content-type":"application/json","cache-control":"no-store"});r.end(JSON.stringify(o))};if(!store.enabled)return send(503,{error:"database not configured"});const hit=flowCache.get(fm[1]);if(hit&&Date.now()-hit.t<30000)return send(200,hit.d);store.flow(fm[1]).then(d=>{flowCache.set(fm[1],{t:Date.now(),d});send(200,d)}).catch(e=>{lastDbErr="flow: "+e.message;st.err="flow: "+e.message;send(502,{error:"query failed"})});return}const lm=q.url.match(/^\/logo\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);if(lm){const e=logoBuf.get(lm[1]);if(!e){r.writeHead(404);return r.end()}r.writeHead(200,{"content-type":e.ct,"cache-control":"public,max-age=86400","content-security-policy":"default-src 'none'"});return r.end(e.b)}const page=process.env.NODE_ENV==="production"?(indexHtml||=fs.readFileSync(path.join(dir,"index.html"))):fs.readFileSync(path.join(dir,"index.html"));r.writeHead(200,{"content-type":"text/html; charset=utf-8"});r.end(page)}catch{r.writeHead(404);r.end()}});
const wss=new WebSocketServer({server,path:"/stream",maxPayload:2048,verifyClient:({origin,req},cb)=>originAllowed(origin,req.headers.host,ALLOWED)?cb(true):cb(false,403,"origin not allowed")});
// Tracked wallets: browsers send {pin:"<address>"}; the server then follows every trade from that wallet (no sampling)
const PASS=process.env.PIN_PASSCODE||"",PROD=process.env.NODE_ENV==="production",failRL=createRateLimit({max:6,windowMs:3600000}),same=(a,b)=>{const x=Buffer.from(String(a)),y=Buffer.from(String(b));return x.length===y.length&&crypto.timingSafeEqual(x,y)};
setInterval(()=>wss.clients.forEach(c=>{if(c.isAlive===false)return c.terminate();c.isAlive=false;try{c.ping()}catch{}}),25000).unref(); // keeps proxies from silently dropping idle sockets and clears dead ones
const watched=new Set(),B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
wss.on("connection",(c,req)=>{c.on("error",()=>{});const f1=connLim.acquire(clientIp(req,TRUST)),f2=f1&&globalConns.acquire("*");if(!f1||!f2){f1&&f1();c.close(1013,"too many connections");return}c.on("close",()=>{f1();f2()});c.isAlive=true;c.on("pong",()=>{c.isAlive=true});c.on("error",()=>{});const ip=clientIp(req,TRUST);let owner=!PASS&&!PROD;if(owner)c.send(JSON.stringify({tracked:[...watched]}));c.on("message",raw=>{if(!msgRL.hit(ip+":m")){c.close(1008,"slow down");return}let m;try{m=JSON.parse(raw)}catch{return}if(!owner&&(typeof m.hello==="string"||typeof m.pin==="string")){if(!PASS){c.send(JSON.stringify({pinError:"disabled"}));return}if(!failRL.hit(ip+":pin")){c.send(JSON.stringify({pinError:"locked"}));return}if(same(m.code??m.hello,PASS)){owner=true;c.send(JSON.stringify({tracked:[...watched]}))}else{c.send(JSON.stringify({pinError:"code"}));return}}
if(owner&&typeof m.pin==="string"&&B58.test(m.pin)){if(!watched.has(m.pin))store.saveTracked(m.pin).catch(e=>{st.err="saveTracked: "+e.message});watch(m.pin)}})});
function watch(w){if(watched.has(w)||watched.size>=50)return;watched.add(w);if(up?.readyState===1)cmd("subscribeAccountTrade",w);if(sw?.readyState===1)subWallet(w)}
const subWallet=w=>sw.send(JSON.stringify({jsonrpc:"2.0",id:"w"+Math.random(),method:"logsSubscribe",params:[{mentions:[w]},{commitment:"confirmed"}]}));
const out=(sym0,buy,usd,venue,wallet,logo,mint,sig)=>{const sym=cleanSym(sym0,mint);const e=wallets.get(wallet)||touch(wallet),bot=e.bot,r=bot?-1:pick(e),pool=HUBS.filter(h=>h[3]===r),h=bot?["Bots",0,0,-1]:pool[Math.random()*pool.length|0],
m=JSON.stringify({sym,buy,usd,venue,city:h[0],lon:h[1],lat:h[2],r,logo:logoUrl(mint,logo),wallet,mint,sig,n:e.n,bot});lastOut=Date.now();const big=usd>=2000||watched.has(wallet),nowT=Date.now();wss.clients.forEach(c=>{if(c.readyState!==1||c.bufferedAmount>=1e6)return;const dt=(nowT-(c.tAt||nowT))/1000;c.tAt=nowT;c.tok=Math.min(SEND_BURST,(c.tok??SEND_BURST)+dt*SEND_PER_SEC);if(c.tok<1&&!big)return;c.tok-=1;c.send(m);st.bytes+=m.length});st.sent++;if(venue!=="pump.fun"){store.add({mint,sym,venue,region:r,buy,usd,wallet,sig,bot});store.wallet(wallet,e)}};

// ---- pump.fun via PumpPortal ----
const meta=new Map(),subs=[];let up,last=0;
const st={skipped:0,bytes:0,logoOk:0,logoFail:0,logoWhy:"",pumpEv:0,pump:0,pumpTrades:0,logs:0,queued:0,decoded:0,sent:0,err:"",tried:0,rpcErr:0,noTx:0,failedTx:0,noMint:0,swapSkip:0,small:0};
setInterval(()=>{console.log(`[10s] pump msgs ${st.pump} (trades ${st.pumpTrades}) | dex logs ${st.logs} queued ${st.queued} tried ${st.tried} (rpcErr ${st.rpcErr} notFound ${st.noTx} failedTx ${st.failedTx} noMint ${st.noMint} tokenForToken ${st.swapSkip} small ${st.small}) decoded ${st.decoded} | sent to browsers ${st.sent} | pump.fun on-chain events ${st.pumpEv} | cpu ${cpuPct}% lag ${Math.round(loopLag)}ms skipped ${st.skipped} | to viewers ${(st.bytes/10240).toFixed(0)} KB/s | logos ok ${st.logoOk} failed ${st.logoFail} (${logoBuf.size} cached)${st.logoWhy?" last fail: "+st.logoWhy:""} | db ${store.enabled?`${store.stat.flushed} rows saved, ${store.stat.failures} failed`:"off"} | pump ${up?.readyState===1?"up":"DOWN"} dex ${sw?.readyState===1?"up":"DOWN"} | clients ${wss.clients.size}${st.err?" | last error: "+st.err:""}`);for(const k of ["skipped","bytes","logoOk","logoFail","pumpEv","pump","pumpTrades","logs","queued","decoded","sent","tried","rpcErr","noTx","failedTx","noMint","swapSkip","small"])st[k]=0;st.err=""},10000);
const cmd=(m,k)=>up.readyState===1&&up.send(JSON.stringify({method:m,keys:[k]}));
async function pLogo(mint){const m=meta.get(mint);if(!m?.uri||!safeUrl(m.uri))return;try{const j=await(await fetch(m.uri,{signal:AbortSignal.timeout(2500)})).json();if(meta.has(mint))m.logo=j.image}catch{}}
function pump(){up=new WebSocket("wss://pumpportal.fun/api/data");
up.on("open",()=>{pb=0;up.send(JSON.stringify({method:"subscribeNewToken"}));watched.forEach(w=>cmd("subscribeAccountTrade",w))});
up.on("message",raw=>{let d;try{d=JSON.parse(raw)}catch{return}st.pump++;if(d.txType!=="create"&&(st.samples=(st.samples||0)+1)<=6)console.log("[pump sample, not a new-token msg]",String(raw).slice(0,400));if(!d.mint)return;
if(d.txType==="create"){meta.set(d.mint,{sym:d.symbol,uri:d.uri});subs.push(d.mint);
if(subs.length>3000){meta.delete(subs.shift())}pLogo(d.mint);return}
if((d.txType!=="buy"&&d.txType!=="sell")||!d.solAmount)return;st.pumpTrades++;touch(d.traderPublicKey);
const usd=Math.round(d.solAmount*sol),now=Date.now(),pin=watched.has(d.traderPublicKey);if(!pin&&usd<1000&&now-last<200)return;if(!pin)last=now;
const m=meta.get(d.mint),go=(s,l)=>out("$"+String(s).toUpperCase(),d.txType==="buy",usd,"pump.fun",d.traderPublicKey,l,d.mint,d.signature);if(m)go(m.sym||d.mint.slice(0,4),m.logo);else tokenInfo(d.mint).then(i=>go(i.sym,i.logo))});
up.on("close",()=>setTimeout(pump,backoff(pb++)));up.on("error",e=>{st.err="pump: "+e.message})}
pump();

// ---- Jupiter / Raydium / Orca / Meteora via Solana RPC ----
const PROG={JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4:"Jupiter",
"675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8":"Raydium",CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK:"Raydium",CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C:"Raydium",
whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc:"Orca",LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo:"Meteora",Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB:"Meteora"};
const WSOL="So11111111111111111111111111111111111111112",USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const rpc=async(method,params)=>(await fetch(HTTP,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method,params}),signal:AbortSignal.timeout(8000)})).json();
const seen=new Set(),queue=[],tokMeta=new Map(),done=new Set(),pq=[],wsubs=new Set();let sw;
let lastDas=0;
async function tokenInfo(mint){const c=tokMeta.get(mint);if(c&&(c.ok||Date.now()-c.t<60000))return c;let v={sym:mint.slice(0,4),t:Date.now()};
try{const p=(await(await fetch("https://api.dexscreener.com/latest/dex/tokens/"+mint,{signal:AbortSignal.timeout(2500)})).json()).pairs?.[0];if(p){v.sym=p.baseToken.symbol;v.logo=p.info?.imageUrl}}catch{}
if(!v.logo){try{const a=await(await fetch("https://lite-api.jup.ag/tokens/v2/search?query="+mint,{signal:AbortSignal.timeout(2500)})).json(),x=Array.isArray(a)?a.find(t=>t.id===mint||t.address===mint):null;if(x){if(x.symbol)v.sym=x.symbol;v.logo=x.icon||x.logoURI}}catch{}}
if(!v.logo&&process.env.USE_DAS==="1"&&(KEY||process.env.RPC_HTTP)&&Date.now()-lastDas>30000){lastDas=Date.now();st.das=(st.das||0)+1;try{const x=(await rpc("getAsset",{id:mint})).result?.content;if(x){if(x.metadata?.symbol)v.sym=x.metadata.symbol;v.logo=x.links?.image||x.files?.[0]?.cdn_uri||x.files?.[0]?.uri}}catch{}}
v.ok=!!v.logo;tokMeta.set(mint,v);if(tokMeta.size>5000)tokMeta.delete(tokMeta.keys().next().value);return v}
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
setInterval(()=>{const i=queue.findLastIndex(x=>Date.now()-x.t>3000);if(i<0)return;const s=queue.splice(i,1)[0].sig;decode(s).catch(e=>{st.err="decode: "+e.message})},1000/((+process.env.DECODE_PER_SEC||0.4)*1)); // sampled swaps, newest first. Each decode = 1 Helius credit
const B58A="123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz",TRADE=Buffer.from("bddb7fd34ee661ee","hex");
const b58=u=>{let n=0n;for(const x of u)n=n*256n+BigInt(x);let o="";while(n>0n){o=B58A[Number(n%58n)]+o;n/=58n}for(const x of u){if(x)break;o="1"+o}return o};
const pumpEvent=b=>b.length>=97&&b.subarray(0,8).equals(TRADE)?{mint:b58(b.subarray(8,40)),sol:Number(b.readBigUInt64LE(40))/1e9,buy:b[56]===1,user:b58(b.subarray(57,89))}:null; // pump.fun TradeEvent from "Program data:" log lines
function pumpTrade(e,sig){st.pumpEv++;const w=touch(e.user),usd=Math.round(e.sol*sol),now=Date.now(),pin=watched.has(e.user);
store.add({mint:e.mint,sym:meta.get(e.mint)?.sym||tokMeta.get(e.mint)?.sym,venue:"pump.fun",region:w.bot?-1:pick(w),buy:e.buy,usd:e.sol*sol,wallet:e.user,sig,bot:w.bot});store.wallet(e.user,w);
if(usd<1&&!pin)return;if(!pin&&usd<1000&&now-last<35)return;if(!pin)last=now;st.pumpTrades++;
const m=meta.get(e.mint),go=(sy,l)=>out("$"+String(sy).toUpperCase(),e.buy,usd,"pump.fun",e.user,l,e.mint,sig);const wait=p=>Promise.race([p,new Promise(r=>setTimeout(r,700))]);if(m)wait(ensureLogo(e.mint,m.logo)).then(()=>go(m.sym||e.mint.slice(0,4),m.logo));else tokenInfo(e.mint).then(i=>wait(ensureLogo(e.mint,i.logo)).then(()=>go(i.sym,i.logo)))}
const PUMP="6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";let pumpSub;
function dex(){sw=new WebSocket(WSU);let n=0;sw.on("open",()=>{db0=0});pumpSub=undefined;
sw.on("open",()=>watched.forEach(w=>subWallet(w)));
sw.on("open",()=>sw.send(JSON.stringify({jsonrpc:"2.0",id:"pump",method:"logsSubscribe",params:[{mentions:[PUMP]},{commitment:"confirmed"}]})));
sw.on("open",()=>Object.keys(PROG).forEach(p=>sw.send(JSON.stringify({jsonrpc:"2.0",id:++n,method:"logsSubscribe",params:[{mentions:[p]},{commitment:"confirmed"}]}))));
sw.on("message",raw=>{const txt=raw.toString();if(txt.includes("logsNotification")&&!wsubs.size&&!txt.includes("Program data:")&&!/swap|route/i.test(txt)){st.skipped++;return}let m;try{m=JSON.parse(txt)}catch{return}
if(m.id==="pump"&&m.result!=null)pumpSub=m.result;else if(typeof m.id==="string"&&m.id[0]==="w"&&m.result!=null)wsubs.add(m.result);
if(m.error)st.err=JSON.stringify(m.error).slice(0,200);const v=m.params?.result?.value;if(!v||v.err)return;st.logs++;
if(m.params.subscription===pumpSub){for(const l of v.logs)if(l.startsWith("Program data: ")){try{const buf=Buffer.from(l.slice(14),"base64"),e=pumpEvent(buf);if(e)pumpTrade(e,v.signature);else if((st.unk=(st.unk||0)+1)<=0)console.log("[pump log, unrecognised]",buf.length,"bytes, starts",buf.subarray(0,8).toString("hex"))}catch{}}return}
if(wsubs.has(m.params.subscription)){pq.push(v.signature);return} // tracked wallets skip sampling
if(seen.has(v.signature)||v.logs.length>45||!v.logs.some(l=>/swap|route/i.test(l)))return; // long logs are usually arbitrage bots, which decode to nothing
seen.add(v.signature);if(seen.size>5000)seen.delete(seen.values().next().value);queue.push({sig:v.signature,t:Date.now()});st.queued++;while(queue.length&&Date.now()-queue[0].t>30000)queue.shift();if(queue.length>3000)queue.shift()});
const ka=setInterval(()=>sw.readyState===1&&sw.ping(),30000);sw.on("close",()=>{clearInterval(ka);setTimeout(dex,backoff(db0++))});sw.on("error",e=>{st.err="dex: "+e.message})}
if(KEY||process.env.RPC_WS)dex();else console.log("No HELIUS_KEY set: pump.fun only. Add a key to include Jupiter, Raydium, Orca and Meteora.");
if(store.enabled){setInterval(()=>store.flush(),5000);
store.loadWallets().then(rows=>{for(const w of rows)if(!wallets.has(w.wallet))wallets.set(w.wallet,{n:w.n,ll:w.ll,hrs:w.hours_mask,t:[],bot:w.bot});console.log("[db] loaded "+rows.length+" wallet profiles")}).catch(e=>console.log("[db] could not load wallets:",e.message));
store.loadTracked().then(a=>{a.forEach(watch);console.log("[db] loaded "+a.length+" tracked wallets")}).catch(e=>console.log("[db] could not load tracked wallets:",e.message))}
else console.log("No SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY: history is off (live view still works).");
let dying=false;const bye=async()=>{if(dying)return;dying=true;console.log("shutting down");server.close();wss.clients.forEach(c=>c.close(1001,"restarting"));await Promise.race([store.flush().catch(()=>{}),new Promise(r=>setTimeout(r,4000))]);process.exit(0)};process.on("SIGTERM",bye);process.on("SIGINT",bye);
server.listen(PORT,()=>console.log("Trade Globe on http://localhost:"+PORT));
