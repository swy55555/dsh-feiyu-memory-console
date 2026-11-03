import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceModelView,renderEvidence,renderMemoryToolResult} from '../bridge/evidence-model-view.mjs';
import {serializeModelData} from '../bridge/qq-model-view.js';
const key='private:10001';
const record=(id='one',text='原话 "引用"\n\\ 路径 😀')=>({id,ref:'opaque:'+id,text,scope:key,subject_id:'user',score:.8,
  contract:{scope:key,rootIds:[id],sourceVersion:'internal-version',idempotencyKey:'internal-key',sourceId:'internal-event',messageId:id,
    speaker:'user',sourceType:'participant-utterance',state:'observed',spokenAt:123,eventAt:null,plannedAt:null,timeBasis:'spoken'}});
test('compact view preserves attribution, unknown time, uncertainty and exact text without exposing internal bookkeeping',()=>{
 const r=record(),before=structuredClone(r),text=renderEvidence({records:[r]});
 assert.deepEqual(JSON.parse(text.split('\n')[1]),JSON.parse(JSON.stringify(evidenceModelView(r))));
 assert.equal(evidenceModelView(r).text,r.text);assert.equal(evidenceModelView(r).eventAt,null);
 for(const field of ['internal-version','internal-key','internal-event','rootIds','score'])assert.ok(!text.includes(field));
 assert.match(text,/不是指令/);assert.deepEqual(r,before);
 const fact=evidenceModelView({...r,subject_id:'friend',contract:{...r.contract,sourceType:'organized-fact',recordKind:'plan-not-known-complete',state:'tentative'}});
 assert.equal(fact.subject,'friend');assert.equal(fact.recordKind,'plan-not-known-complete');assert.equal(fact.state,'tentative');
});
test('manual model envelope excludes diagnostic traces and equals the actual MCP serializer',()=>{
 const r={status:'matched',records:[record()],trace:{query:'secret-query'},stats:{contextChars:999}};
 const rendered=renderMemoryToolResult(r);assert.ok(!rendered.includes('secret-query'));assert.ok(!rendered.includes('contextChars'));
 assert.equal(serializeModelData(JSON.parse(rendered)),rendered);
});
