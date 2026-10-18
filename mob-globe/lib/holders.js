// Counts distinct wallets holding a token via Helius DAS getTokenAccounts. Capped pages keep credit use bounded.
export function createHolders({call,pages=5,ttlMs=90000,maxPerMin=20,now=()=>Date.now()}){
  const cache=new Map(),pending=new Map();let win=[];
  async function count(mint){
    const owners=new Set();let cursor,capped=false;
    for(let i=0;i<pages;i++){
      const p={mint,limit:1000,options:{showZeroBalance:false}};if(cursor)p.cursor=cursor;
      const r=await call("getTokenAccounts",p),res=r&&r.result;
      if(!res||!Array.isArray(res.token_accounts))throw new Error("bad response");
      for(const a of res.token_accounts)if(a.owner&&Number(a.amount)>0)owners.add(a.owner);
      cursor=res.cursor;
      if(!cursor||res.token_accounts.length===0)return{n:owners.size,capped:false};
      if(i===pages-1)capped=true;
    }
    return{n:owners.size,capped};
  }
  return{async get(mint){
    const t=now(),c=cache.get(mint);
    if(c&&t-c.t<ttlMs)return c.d;
    if(pending.has(mint))return pending.get(mint);
    win=win.filter(x=>t-x<60000);
    if(win.length>=maxPerMin)return c?c.d:null;
    win.push(t);
    const pr=count(mint).then(d=>{cache.set(mint,{t:now(),d});if(cache.size>500)cache.delete(cache.keys().next().value);return d}).catch(()=>c?c.d:null).finally(()=>pending.delete(mint));
    pending.set(mint,pr);return pr;
  }};
}
