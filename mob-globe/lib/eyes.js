// GMGN hot-searches -> { mint: { v: visiting_count, r: rank } }. One cached request serves every viewer.
export function parseHot(j){
  const out={},blocks=Array.isArray(j)?j:Array.isArray(j&&j.data)?j.data:Array.isArray(j&&j.data&&j.data.data)?j.data.data:[];
  for(const b of blocks)for(const t of (b&&b.tokens)||[]){const a=t.address,v=Number(t.visiting_count);if(a&&v>=0&&!out[a])out[a]={v,r:Number(t.rank)||0}}
  return out;
}
export function createEyes({fetchHot,ttlMs=30000,now=()=>Date.now()}){
  let cache=null,t=0,pending=null,backoff=0;
  return{async get(){
    if(!fetchHot)return null;
    const n=now();
    if(cache&&n-t<ttlMs)return cache;
    if(n<backoff)return cache;
    if(!pending)pending=fetchHot().then(j=>{cache=parseHot(j);t=now()}).catch(()=>{backoff=now()+60000}).finally(()=>{pending=null});
    await pending;return cache;
  }};
}
