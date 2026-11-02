import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {SelfReference} from '../bridge/self-reference.mjs';
import {sharedTemperamentLine,temperamentLine} from '../bridge/self-temperament.mjs';
import {ReferenceReuse} from '../bridge/reference-reuse.mjs';
import {TurnTraces} from '../bridge/turn-traces.mjs';
const persona={spec:{dimensions:[{key:'warm',label:'PRIVATE NAME',desc:'PRIVATE STORY',band:20},{key:'proud',label:'PRIVATE LABEL',desc:'PRIVATE PLACE',band:12},{key:'secret',label:'SECRET CUSTOM DIM'}]},current:{warm:54,proud:70,secret:88},baseline:{warm:42,proud:82,secret:80},history:[{text:'PRIVATE HISTORY'}]};
test('private and public pride mean indirect affection, never contradictory facts; render leaves state intact',()=>{
 const p=structuredClone(persona);p.spec.dimensions[1]={...p.spec.dimensions[1],label:'嘴硬',desc:'坦率 ↔ 口是心非'};const before=structuredClone(p);
 const privateLine=temperamentLine(p),publicLine=sharedTemperamentLine(p);
 for(const line of [privateLine,publicLine]){assert.match(line,/表达含蓄程度/);assert.match(line,/70/);assert.doesNotMatch(line,/口是心非/);}
 assert.deepEqual(p,before);assert.match(privateLine,/PRIVATE STORY/);assert.doesNotMatch(publicLine,/PRIVATE STORY/);
 p.current.proud=20;assert.notEqual(temperamentLine(p),privateLine);assert.equal(p.current.warm,54);
});
function setup(){const ref=new SelfReference({enabled:()=>true,allowed:k=>k==='private:1',initialPersona:persona});
 ref.state.claims=[{id:'secret',category:'interest',text:'PRIVATE CLAIM',status:'tentative',lastEvidenceAt:Date.now(),evidenceDays:[],confidence:.9}];return ref;}

test('public temperament shares values, excludes all custom text, history and private claims',()=>{
 const ref=setup(),group=ref.render('group:2'),other=ref.render('private:3');
 for(const result of [group,other]){assert.match(result,/共同的性格倾向/);assert.match(result,/54/);assert.match(result,/70/);assert.doesNotMatch(result,/PRIVATE|SECRET|88/);}
 assert.equal(group,other);assert.match(ref.render('private:1'),/PRIVATE CLAIM/);
 ref.state.temperament.current.warm=55;assert.match(ref.render('group:2'),/55/);
 assert.equal(ref.state.temperament.current.proud,70);
});
test('invalid or unknown numeric dimensions do not become a fallback public identity',()=>{
 assert.equal(sharedTemperamentLine(null),'');
 assert.equal(sharedTemperamentLine({spec:{dimensions:[{key:'secret'}]},current:{secret:99}}),'');
 assert.equal(sharedTemperamentLine({spec:persona.spec,current:{warm:NaN,proud:101}}),'');
});
test('actual dispatch supplies shared temperament to group and other private without owner claim leakage',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf('  async function dispatchTracedPrompt('),end=source.indexOf('  function traceRow(',start),sent=[];
 const ctx=vm.createContext({cfg:{},selfReference:setup(),selfReferenceEnabled:()=>true,referenceReuse:new ReferenceReuse(),
   reverse:new Map([['g','group:2'],['p','private:3'],['o','private:1']]),turnTraces:new TurnTraces(()=>{}),
   api:{sessions:{prompt:async p=>{sent.push(p);return {result:{ok:true,value:{accepted:true}}};}}}});
 const dispatch=vm.runInContext(source.slice(start,end)+';dispatchTracedPrompt',ctx);
 for(const sessionId of ['g','p','o'])await dispatch({sessionId,content:[{type:'text',text:'本轮正在聊的原话'}]});
 for(const p of sent.slice(0,2)){assert.match(p.content[0].text,/共同的性格倾向/);assert.doesNotMatch(p.content[0].text,/PRIVATE/);assert.ok(p.content[0].text.endsWith('本轮正在聊的原话'));}
 assert.match(sent[2].content[0].text,/PRIVATE CLAIM/);
});
test('media suggestion retains current request; it creates no additional model or tool call',()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf('  function withStyleNudge('),end=source.indexOf('\n  }',start)+4;
 for(const random of [0,.5]){
  const ctx=vm.createContext({cfg:{socialV2:{style:{voiceChance:.35,stickerChance:.55}}},Math:{random:()=>random},log:()=>{}});
  const fn=vm.runInContext(source.slice(start,end)+';withStyleNudge',ctx);
  const p=fn('请用文字详细说明为什么刚才误解了我');assert.ok(p.endsWith('请用文字详细说明为什么刚才误解了我'));
  assert.doesNotMatch(p,/文字最多补一句|能只发表情就只发表情|这次用\*\*语音/);
 }
});
