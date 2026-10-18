import test from "node:test";import assert from "node:assert/strict";import {createHolders} from "../lib/holders.js";
const page=(owners,cursor)=>({result:{token_accounts:owners.map(o=>({owner:o,amount:1})),cursor}});
test("counts distinct owners across pages",async()=>{const pg=[page(["a","b","a"],"c1"),page(["c","d"])];let i=0;const h=createHolders({call:async()=>pg[i++]});assert.deepEqual(await h.get("M"),{n:4,capped:false})});
test("caps pages and flags it",async()=>{let i=0;const h=createHolders({pages:2,call:async()=>page(["o"+i++],"more")});const d=await h.get("M");assert.equal(d.capped,true);assert.equal(d.n,2)});
test("caches and dedupes",async()=>{let n=0;const h=createHolders({call:async()=>{n++;return page(["a"])}});await Promise.all([h.get("M"),h.get("M")]);await h.get("M");assert.equal(n,1)});
test("rate limit and failure return null",async()=>{const h=createHolders({maxPerMin:1,call:async()=>{throw new Error("x")}});assert.equal(await h.get("A"),null);assert.equal(await h.get("B"),null)});
test("prefers gmgn, falls back to helius",async()=>{let hel=0;const h=createHolders({gmgn:async()=>({n:500,capped:false,top10:.2}),call:async()=>{hel++;return page(["a"])}});assert.equal((await h.get("M")).top10,.2);assert.equal(hel,0);const h2=createHolders({gmgn:async()=>null,call:async()=>page(["a","b"])});assert.equal((await h2.get("M")).n,2)});
