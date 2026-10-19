import test from "node:test";import assert from "node:assert/strict";import {parseHot,createEyes} from "../lib/eyes.js";
const sample={data:[{chain:"sol",tokens:[{address:"A",visiting_count:"120",rank:1},{address:"B",visiting_count:5,rank:2},{address:"A",visiting_count:1}]}]};
test("parses blocks, first wins",()=>{const o=parseHot(sample);assert.equal(o.A.v,120);assert.equal(o.B.r,2)});
test("tolerates junk",()=>{assert.deepEqual(parseHot(null),{});assert.deepEqual(parseHot({data:"x"}),{})});
test("caches and backs off on failure",async()=>{let n=0,t=0;const e=createEyes({fetchHot:async()=>{n++;return sample},now:()=>t});await e.get();await e.get();assert.equal(n,1);t=31000;await e.get();assert.equal(n,2);
let f=0,t2=0;const e2=createEyes({fetchHot:async()=>{f++;throw new Error("x")},now:()=>t2});await e2.get();await e2.get();assert.equal(f,1)});
