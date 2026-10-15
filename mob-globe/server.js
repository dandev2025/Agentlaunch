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
const logoBuf=new Map(),logoBusy=new Set(),logoFail=new Map(),IPFS=["https://ipfs.io/ipfs/","https://cloudflare-ipfs.com/ipfs/"];
const logoUrl=(mint,hint)=>{if(!mint)return;if(logoBuf.has(mint))return "/logo/"+mint;ensureLogo(mint,hint);};
async function grab(u){const r=await fetch(u,{signal:AbortSignal.timeout(6000)});const ct=r.headers.get("content-type")||"";if(!r.ok||!/^image\//.test(ct))throw 0;const b=Buffer.from(await r.arrayBuffer());if(b.length>600000)throw 0;return{b,ct}}
async function ensureLogo(mint,hint){if(logoBusy.has(mint)||logoBuf.has(mint)||Date.now()-(logoFail.get(mint)||0)<300000||logoBusy.size>30)return;logoBusy.add(mint);
try{let u=hint||meta.get(mint)?.logo;if(!u&&meta.get(mint)?.uri){try{u=(await(await fetch(meta.get(mint).uri,{signal:AbortSignal.timeout(5000)})).json()).image}catch{}}
if(!u)u=(await tokenInfo(mint)).logo;if(!u)throw 0;const c=[u];const m=u.match(/\/ipfs\/(.+)$/);if(m)IPFS.forEach(g=>c.push(g+m[1]));
for(const x of c){try{logoBuf.set(mint,await grab(x));if(logoBuf.size>800)logoBuf.delete(logoBuf.keys().next().value);return}catch{}}throw 0}
catch{logoFail.set(mint,Date.now())}finally{logoBusy.delete(mint)}}
const server=http.createServer((q,r)=>{try{const lm=q.url.match(/^\/logo\/([1-9A-HJ-NP-Za-km-z]{32,44})$/);if(lm){const e=logoBuf.get(lm[1]);if(!e){r.writeHead(404);return r.end()}r.writeHead(200,{"content-type":e.ct,"cache-control":"public,max-age=86400"});return r.end(e.b)}r.writeHead(200,{"content-type":"text/html"});r.end(fs.readFileSync(path.join(dir,"index.html")))}catch{r.writeHead(404);r.end()}});
const wss=new WebSocketServer({server,path:"/stream"});
// Tracked wallets: browsers send {pin:"<address>"}; the server then follows every trade from that wallet (no sampling)
const watched=new Set(),B58=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
wss.on("connection",c=>c.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(typeof m.pin==="string"&&B58.test(m.pin))watch(m.pin)}));
function watch(w){if(watched.has(w)||watched.size>=50)return;watched.add(w);if(up?.readyState===1)cmd("subscribeAccountTrade",w);if(sw?.readyState===1)subWallet(w)}
const subWallet=w=>sw.send(JSON.stringify({jsonrpc:"2.0",id:"w"+Math.random(),method:"logsSubscribe",params:[{mentions:[w]},{commitment:"confirmed"}]}));
const out=(sym,buy,usd,venue,wallet,logo,mint,sig)=>{const e=wallets.get(wallet)||touch(wallet),bot=e.bot,r=bot?-1:pick(e),pool=HUBS.filter(h=>h[3]===r),h=bot?["Bots",0,0,-1]:pool[Math.random()*pool.length|0],
m=JSON.stringify({sym,buy,usd,venue,city:h[0],lon:h[1],lat:h[2],r,logo:logoUrl(mint,logo),wallet,mint,sig,n:e.n,bot});wss.clients.forEach(c=>c.readyState===1&&c.send(m));st.sent++};

// ---- pump.fun via PumpPortal ----
const meta=new Map(),subs=[];let up,last=0;
const st={pumpEv:0,pump:0,pumpTrades:0,logs:0,queued:0,decoded:0,sent:0,err:"",tried:0,rpcErr:0,noTx:0,failedTx:0,noMint:0,swapSkip:0,small:0};
setInterval(()=>{console.log(`[10s] pump msgs ${st.pump} (trades ${st.pumpTrades}) | dex logs ${st.logs} queued ${st.queued} tried ${st.tried} (rpcErr ${st.rpcErr} notFound ${st.noTx} failedTx ${st.failedTx} noMint ${st.noMint} tokenForToken ${st.swapSkip} small ${st.small}) decoded ${st.decoded} | sent to browsers ${st.sent} | pump.fun on-chain events ${st.pumpEv} | pump ${up?.readyState===1?"up":"DOWN"} dex ${sw?.readyState===1?"up":"DOWN"} | clients ${wss.clients.size}${st.err?" | last error: "+st.err:""}`);for(const k of ["pumpEv","pump","pumpTrades","logs","queued","decoded","sent","tried","rpcErr","noTx","failedTx","noMint","swapSkip","small"])st[k]=0;st.err=""},10000);
const cmd=(m,k)=>up.readyState===1&&up.send(JSON.stringify({method:m,keys:[k]}));
async function pLogo(mint){const m=meta.get(mint);if(!m?.uri)return;try{const j=await(await fetch(m.uri,{signal:AbortSignal.timeout(4000)})).json();if(meta.has(mint))m.logo=j.image}catch{}}
function pump(){up=new WebSocket("wss://pumpportal.fun/api/data");
up.on("open",()=>{up.send(JSON.stringify({method:"subscribeNewToken"}));watched.forEach(w=>cmd("subscribeAccountTrade",w))});
up.on("message",raw=>{let d;try{d=JSON.parse(raw)}catch{return}st.pump++;if(d.txType!=="create"&&(st.samples=(st.samples||0)+1)<=6)console.log("[pump sample, not a new-token msg]",String(raw).slice(0,400));if(!d.mint)return;
if(d.txType==="create"){meta.set(d.mint,{sym:d.symbol,uri:d.uri});subs.push(d.mint);
if(subs.length>3000){meta.delete(subs.shift())}pLogo(d.mint);return}
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
let lastDas=0;
async function tokenInfo(mint){const c=tokMeta.get(mint);if(c&&(c.ok||Date.now()-c.t<60000))return c;let v={sym:mint.slice(0,4),t:Date.now()};
try{const p=(await(await fetch("https://api.dexscreener.com/latest/dex/tokens/"+mint,{signal:AbortSignal.timeout(4000)})).json()).pairs?.[0];if(p){v.sym=p.baseToken.symbol;v.logo=p.info?.imageUrl}}catch{}
if(!v.logo&&(KEY||process.env.RPC_HTTP)&&Date.now()-lastDas>4000){lastDas=Date.now();st.das=(st.das||0)+1;try{const x=(await rpc("getAsset",{id:mint})).result?.content;if(x){if(x.metadata?.symbol)v.sym=x.metadata.symbol;v.logo=x.links?.image||x.files?.[0]?.cdn_uri||x.files?.[0]?.uri}}catch{}}
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
function pumpTrade(e,sig){st.pumpEv++;touch(e.user);const usd=Math.round(e.sol*sol),now=Date.now(),pin=watched.has(e.user);if(usd<1&&!pin)return;if(!pin&&usd<1000&&now-last<35)return;if(!pin)last=now;st.pumpTrades++;
const m=meta.get(e.mint),go=(sy,l)=>out("$"+String(sy).toUpperCase(),e.buy,usd,"pump.fun",e.user,l,e.mint,sig);if(m)go(m.sym||e.mint.slice(0,4),m.logo);else tokenInfo(e.mint).then(i=>go(i.sym,i.logo))}
const PUMP="6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";let pumpSub;
function dex(){sw=new WebSocket(WSU);let n=0;pumpSub=undefined;
sw.on("open",()=>watched.forEach(w=>subWallet(w)));
sw.on("open",()=>sw.send(JSON.stringify({jsonrpc:"2.0",id:"pump",method:"logsSubscribe",params:[{mentions:[PUMP]},{commitment:"confirmed"}]})));
sw.on("open",()=>Object.keys(PROG).forEach(p=>sw.send(JSON.stringify({jsonrpc:"2.0",id:++n,method:"logsSubscribe",params:[{mentions:[p]},{commitment:"confirmed"}]}))));
sw.on("message",raw=>{let m;try{m=JSON.parse(raw)}catch{return}
if(m.id==="pump"&&m.result!=null)pumpSub=m.result;else if(typeof m.id==="string"&&m.id[0]==="w"&&m.result!=null)wsubs.add(m.result);
if(m.error)st.err=JSON.stringify(m.error).slice(0,200);const v=m.params?.result?.value;if(!v||v.err)return;st.logs++;
if(m.params.subscription===pumpSub){for(const l of v.logs)if(l.startsWith("Program data: ")){try{const buf=Buffer.from(l.slice(14),"base64"),e=pumpEvent(buf);if(e)pumpTrade(e,v.signature);else if((st.unk=(st.unk||0)+1)<=0)console.log("[pump log, unrecognised]",buf.length,"bytes, starts",buf.subarray(0,8).toString("hex"))}catch{}}return}
if(wsubs.has(m.params.subscription)){pq.push(v.signature);return} // tracked wallets skip sampling
if(seen.has(v.signature)||v.logs.length>45||!v.logs.some(l=>/swap|route/i.test(l)))return; // long logs are usually arbitrage bots, which decode to nothing
seen.add(v.signature);if(seen.size>5000)seen.delete(seen.values().next().value);queue.push({sig:v.signature,t:Date.now()});st.queued++;while(queue.length&&Date.now()-queue[0].t>30000)queue.shift();if(queue.length>3000)queue.shift()});
const ka=setInterval(()=>sw.readyState===1&&sw.ping(),30000);sw.on("close",()=>{clearInterval(ka);setTimeout(dex,3000)});sw.on("error",e=>{st.err="dex: "+e.message})}
if(KEY||process.env.RPC_WS)dex();else console.log("No HELIUS_KEY set: pump.fun only. Add a key to include Jupiter, Raydium, Orca and Meteora.");
server.listen(PORT,()=>console.log("Trade Globe on http://localhost:"+PORT));
