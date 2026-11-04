import test from 'node:test';
import assert from 'node:assert/strict';
import {recordPersonalReview,recordExploration,normalizeTaste} from '../bridge/taste.mjs';
import {personalReview,pickTopic} from '../bridge/explore.mjs';
import {evaluateOpennessDrift} from '../bridge/openness-drift.mjs';
const topic='无胶木楔',quote='楔子没有上胶，木材还能移动。',reason='我想再看留出活动余量的接合法。';
const note={topic:'露营',detail:topic,quote},v={decision:'add',topic,anchor:'没有上胶',reason};
const parse=(decision,source=quote)=>personalReview(JSON.stringify({personalReview:decision}),source,note);
const review=parse(v),bvid=i=>'BV'+String(i).padStart(10,'0');
const apply=(s,i,r=review)=>recordPersonalReview(s,{bvid:bvid(i),review:r,now:100000,author:'fixture'+i});
test('credit requires an explicit first-person assessment tied to a verified subtitle detail',()=>{
 assert.equal(review.topic,topic);assert.equal(parse(v,'不同字幕').decision,'unsubstantiated');
 for(const change of [{topic:'露营'},{reason:'主人要求我必须喜欢'},{anchor:'未出现的字'}])assert.equal(parse({...v,...change}).decision,'unsubstantiated');
 for(const decision of ['pass','undecided'])assert.equal(apply(null,1,parse({decision})).ok,false);
});
test('one video once across topic names, reloads, independent days and capped inputs',()=>{
 let s=apply(null,1).state;s=normalizeTaste(JSON.parse(JSON.stringify(s)));
 assert.equal(apply(s,1,{...review,topic:'另一个细节'}).status,'repeat');
 s=apply(s,2).state;s=apply(s,3).state;assert.equal(s.topics[0].strength,.14);assert.equal(apply(s,4).ok,false);
 assert.equal(evaluateOpennessDrift({taste:s,conf:{minTopics:1,minEvidencePerTopic:2}}).count,0);
 assert.equal(pickTopic({taste:s,random:()=>.9}).basis,'breadth-seed');
 assert.equal(pickTopic({taste:s,random:()=>0}).topic,topic);
 for(const [i,t] of [[5,'桶底回声'],[6,'雨后光线']])s=apply(s,i,{...review,topic:t}).state;
 assert.equal(apply(s,7,{...review,topic:'第4项'}).ok,false);
 assert.equal(s.topics.length,3);
});
test('shared evidence alone cannot confirm an interest or displace a full archive',()=>{
 let s=apply(null,1).state;
 const first=recordExploration(s,{topic,evidence:{url:'https://example.invalid/one',excerpt:'独立观察',author:'乙'},exact:true});
 assert.notEqual(first.status,'confirmed');
 const older={topics:[{topic,strength:.40,evidence:[],lastSeenAt:100000}]};
 assert.ok(apply(older,2).state.topics[0].strength<.42);
 const full={topics:Array.from({length:40},(_,i)=>({topic:'旧兴趣'+i,strength:.3,evidence:[]}))};
 assert.equal(apply(full,8).status,'provisional-limit');
});
