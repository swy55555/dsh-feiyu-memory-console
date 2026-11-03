import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {recentExploreRecap} from '../bridge/explore.mjs';

const now = Date.parse('2026-11-03T10:00:00Z');
const url = (id) => `https://www.bilibili.com/video/${id}`;
const run = (id, title, hoursAgo, more = {}) => ({
  at: now - hoursAgo * 3600000, ok: true, contentRead: true,
  topic: '菜市场', video: {bvid:id,title,url:url(id)}, ...more,
});

test('owner browsing questions recall recent successful pages, not video fact fragments', () => {
  const state = {runs:[
    run('old','很久以前的网页',31*24),
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
  assert.equal(recentExploreRecap(state,'老大喜欢吃什么？',{now}),'');
  assert.equal(recentExploreRecap(state,'我最近在网上看了啥？',{now}),'');
});

test('invalidated sources and non-Bilibili URLs are not recalled', () => {
  const state = {runs:[run('revoked','已撤回',1),run('other','外部站点',2,{video:{bvid:'other',title:'外部站点',url:'https://example.com/video'}})]};
  const text = recentExploreRecap(state,'最近看过什么视频',{now,selfItems:[{sourceUrl:url('revoked'),sourceState:'invalid'}]});
  assert.match(text,/没有近 30 天内可核验/);
  assert.doesNotMatch(text,/已撤回|外部站点/);
});

test('active workspace delivery includes the self reference block', () => {
  const source = fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
  const workspace = source.slice(source.indexOf("{id:'workspace',text:work.text"),source.indexOf("...(sharedLine?",source.indexOf("{id:'workspace',text:work.text")));
  assert.match(workspace,/\{id:'self',text:selfBlock/);
  assert.match(source,/selfBlock = recentExploreRecap\(/);
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
    normalizeSelfMemory:raw=>({items:raw.items}),
    readJsonSafe:file=>file.endsWith('explore.json')?{runs:[run('new','真实浏览的页面',1)]}:{items:[]},
    path:{join:(...items)=>items.join('/')},STATE_DIR:'/state',recentExploreRecap,
    followupMemory:{get:()=>{throw Error('ordinary chat memory was queried')}},
  });
  vm.runInContext(source.slice(start,end),context);
  const result = await vm.runInContext("memoryReferenceV2('private:123',st,[{seq:7,messageId:'m7',text:'你现在能不能想起网上都看了啥嘛？'}],'token','waitMessages')",context);
  assert.equal(result.source,'self-explore');
  assert.equal(result.status,'matched');
  assert.match(result.context,/真实浏览的页面/);
  assert.equal(result.messageId,'m7');
});
