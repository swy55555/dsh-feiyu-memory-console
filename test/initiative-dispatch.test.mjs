import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {computeInitiatives} from '../bridge/initiative.mjs';

test('live intent selects a runnable contact before an unhandled revisit and later allows exploration',()=>{
 const now=Date.parse('2026-11-03T04:00:00Z');
 const common={now,goals:{curiosity:.55,autonomy:.55,relatedness:.55},concerns:Array.from({length:4},()=>({status:'open'})),
   conf:{dryRun:false,allowContact:true,allowExplore:true,quietHours:['01:00','09:00'],timezone:'Asia/Shanghai',threshold:.45,contactIdleHours:12},
   ownerIdleHours:0,actionableOnly:true};
 const first=computeInitiatives(common);assert.equal(first.chosen,'contact');
 const next=computeInitiatives({...common,lastContactAt:now-1000});assert.equal(next.chosen,'explore');
 const simulated=computeInitiatives({...common,actionableOnly:false});assert.equal(simulated.chosen,'revisit');
});
test('exploration canary uses a scoped token header instead of an out-of-scope local variable',()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=src.indexOf('const exploreTimer = setInterval('),end=src.indexOf('exploreTimer.unref?.()',start);
 assert.ok(start>0&&end>start);
 const block=src.slice(start,end);assert.match(block,/const actionToken = String\(cfg\.consoleToken/);
 assert.match(block,/'x-console-token': actionToken/);assert.doesNotMatch(block,/\$\{consoleToken/);
});
