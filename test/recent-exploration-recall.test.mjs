import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {recentExploreRecap,recentExplorePresence,readExploreAudience} from '../bridge/explore.mjs';

const now = Date.parse('2026-11-03T10:00:00Z');
const url = (id) => `https://www.bilibili.com/video/${id}`;

test('audience selection reaches beyond the prefix, keeps zero likes eligible and separates sampled speech',async()=>{
 let seed=37;const random=()=>((seed=(Math.imul(seed,1664525)+1013904223)>>>0)/2**32);
 const replies=Array.from({length:20},(_,i)=>({rpid:i+1,like:i===19?2000:0,content:{message:'C'+i}}));
 let hot=0,cold=0;for(let i=0;i<500;i++){
  const a=await readExploreAudience('comments',{aid:'1'},async()=>({code:0,data:{replies}}),random);
  assert.equal(new Set(a.texts).size,4);hot+=Number(a.texts.includes('C19'));cold+=Number(a.texts.includes('C0'));
 }
 assert.ok(cold>0&&hot>cold*2);
 const xml='<i>'+Array.from({length:300},(_,i)=>`<d p="1">${i}</d>`).join('')+'</i>';
 const dm=await readExploreAudience('danmaku',{cid:2},async(u,f)=>{assert.equal(f,'xml');return xml;},random);
 assert.equal(dm.available,300);assert.equal(dm.texts.length,8);assert.ok(dm.texts.some(t=>Number(t)>100));
 const state={runs:[run('x','露营',1,{audience:{...dm,noticed:1}})]};
 assert.match(recentExploreRecap(state,'上次视频的弹幕说了什么？',{now}),/抽样原话/);
 assert.doesNotMatch(recentExploreRecap(state,'上次视频的评论说了什么？',{now}),/抽样原话/);
 assert.doesNotMatch(recentExploreRecap(state,'上次视频的弹幕说了什么？',{now,selfItems:[{sourceUrl:url('x'),sourceState:'invalid'}]}),/抽样原话/);
 assert.match(recentExploreRecap({},'你能用拾光刷B站吗？',{now,exploreEnabled:false}),/已关闭/);
});
const run = (id, title, hoursAgo, more = {}) => ({
  at: now - hoursAgo * 3600000, ok: true, contentRead: true,
  topic: '菜市场', video: {bvid:id,title,url:url(id)}, ...more,
});

test('owner browsing questions recall recent successful pages, not video fact fragments', () => {
  const state = {runs:[
    run('old','很久以前的网页',31*24),
    run('before','三天前看的网页',72),
    run('one','昨天看的菜市场',12),
    run('two','重复记录',2.5),
    run('two','今天看的地理知识',2,{topic:'地理冷知识'}),
    run('fail','未读到正文',1,{ok:false,contentRead:false}),
  ]};
  const text = recentExploreRecap(state,'最近上网都看了啥',{now});
  assert.match(text,/今天看的地理知识/);
  assert.match(text,/昨天看的菜市场/);
  assert.ok(text.indexOf('今天看的地理知识') < text.indexOf('昨天看的菜市场'));
  assert.doesNotMatch(text,/很久以前的网页|未读到正文|重复记录/);
  assert.match(recentExploreRecap(state,'你找找你的私人记忆？',{now}),/今天看的地理知识/);
  assert.match(recentExploreRecap(state,'你现在能不能想起网上都看了啥嘛？',{now}),/今天看的地理知识/);
  assert.match(recentExploreRecap(state,'你现在能想起来都在网上看了啥嘛',{now}),/今天看的地理知识/);
  const interest=recentExploreRecap(state,'我是说你这两天上网有没有刷到感兴趣的',{now,tasteTopics:[
    {topic:'地理冷知识',lastSeenAt:now-3600000,evidence:[{url:url('one')},{url:url('two')}],sourceState:'current'},
  ]});
  assert.match(interest,/今天看的地理知识/);
  assert.match(interest,/地理冷知识（多次探索）/);
  assert.doesNotMatch(interest,/三天前看的网页/);
  assert.match(interest,/不能当作已确定的个人爱好/);
  assert.equal(recentExploreRecap(state,'老大喜欢吃什么？',{now}),'');
  assert.equal(recentExploreRecap(state,'我最近在网上看了啥？',{now}),'');
  assert.equal(recentExploreRecap(state,'我是说我这两天上网有没有刷到感兴趣的',{now}),'');
});

test('invalidated sources and non-Bilibili URLs are not recalled', () => {
  const state = {runs:[run('revoked','已撤回',1),run('other','外部站点',2,{video:{bvid:'other',title:'外部站点',url:'https://example.com/video'}})]};
  const text = recentExploreRecap(state,'最近看过什么视频',{now,selfItems:[{sourceUrl:url('revoked'),sourceState:'invalid'}]});
  assert.match(text,/没有可核验的成功浏览记录/);
  assert.doesNotMatch(text,/已撤回|外部站点/);
});

test('recent activity stays available as a short, qualified owner cue',()=>{
  const state={runs:[run('new','今天读到的页面',1)]};
  const tasteTopics=[{topic:'地理冷知识',lastSeenAt:now-3600000,evidence:[{url:url('new')}]}];
  const text=recentExplorePresence(state,{now,tasteTopics});
  assert.match(text,/今天读到的页面/);
  assert.match(text,/还在探索地理冷知识/);
  assert.match(text,/不等于确定喜欢/);
  assert.equal(recentExplorePresence(state,{now:now+3*86400000,tasteTopics}),'');
  assert.equal(recentExplorePresence(state,{now,tasteTopics,selfItems:[{sourceUrl:url('new'),sourceState:'invalid'}]}),'');
});

test('active workspace delivery includes the self reference block', () => {
  const source = fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
  const workspace = source.slice(source.indexOf("{id:'workspace',text:work.text"),source.indexOf("...(sharedLine?",source.indexOf("{id:'workspace',text:work.text")));
  assert.match(workspace,/\{id:'self',text:selfBlock/);
  assert.match(source,/const explicit = recentExploreRecap\(/);
  assert.match(source,/selfBlock = explicit \|\| recentExplorePresence\(/);
});

test('ongoing owner turn gets recent exploration despite exhausted chat-memory budget', async () => {
  const source = fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
  const start = source.indexOf('  async function memoryReferenceV2(');
  const end = source.indexOf('  function noteModelMessagesV2(',start);
  assert.ok(start >= 0 && end > start);
  const st = {lastUnreadSeq:7};
  const context = vm.createContext({st,
    cfg:{ownerQQ:123,socialV2:{enabled:true,selfMemory:{recall:true}}},
    socialV2:{paused:false,conversations:new Map([['private:123',st]])},
    currentMode:'reserved2',canonicalV2Key:key=>key,
    agentTokenOk:()=>true,isSessionAllowedInCurrentMode:()=>true,v2ToolEnabled:()=>true,
    normalizeSelfMemory:raw=>({items:raw.items}),normalizeTaste:raw=>({topics:raw.topics||[]}),
    readJsonSafe:file=>file.endsWith('explore.json')?{runs:[run('new','真实浏览的页面',1)]}:file.endsWith('taste.json')?{topics:[{topic:'地理冷知识',lastSeenAt:now-3600000,evidence:[{url:url('new')}]}]}:{items:[]},
    path:{join:(...items)=>items.join('/')},STATE_DIR:'/state',recentExploreRecap,recentExplorePresence,
    followupMemory:{get:()=>{throw Error('ordinary chat memory was queried')}},
  });
  vm.runInContext(source.slice(start,end),context);
  const result = await vm.runInContext("memoryReferenceV2('private:123',st,[{seq:7,messageId:'m7',text:'我是说你这两天上网有没有刷到感兴趣的'}],'token','getUnread')",context);
  assert.equal(result.source,'self-explore');
  assert.equal(result.status,'matched');
  assert.match(result.context,/真实浏览的页面/);
  assert.match(result.context,/地理冷知识/);
  assert.equal(result.messageId,'m7');
  const capability=await vm.runInContext("memoryReferenceV2('private:123',st,[{seq:7,messageId:'cap',text:'你知道自己可以用拾光刷B站吗？'}],'token','getUnread')",context);
  assert.equal(capability.status,'matched');assert.match(capability.context,/实际读取回执/);
  context.followupMemory.get=async()=>({status:'empty',context:''});
  const ordinary=await vm.runInContext("memoryReferenceV2('private:123',st,[{seq:7,messageId:'m8',text:'你好'}],'token','getUnread')",context);
  assert.equal(ordinary.status,'empty');
  assert.equal(ordinary.selfActivity,undefined);
  context.socialV2.conversations.set('private:456',st);
  const other=await vm.runInContext("memoryReferenceV2('private:456',st,[{seq:7,messageId:'m9',text:'你好'}],'token','getUnread')",context);
  assert.equal(other.selfActivity,undefined);
});
