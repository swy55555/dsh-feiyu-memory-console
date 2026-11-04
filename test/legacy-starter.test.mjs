import test from 'node:test';
import assert from 'node:assert/strict';
import {legacyStarterPrompt,validateLegacyStarter} from '../bridge/legacy-starter.mjs';
import {planSetup,setupFeatures,setupRevision,setupInitialLegacy} from '../bridge/onboarding.mjs';
import {SelfReference} from '../bridge/self-reference.mjs';

const card='角色名叫小舟。她说话温暖，小时候在虚构的海边城镇长大。她习惯叫对方老大。她喜欢看游戏视频。';
const dims=[{key:'warm',label:'温度',value:42},{key:'playful',label:'玩心',value:68}];
const preview={
 dimensions:[{key:'warm',value:70,quote:'说话温暖'},{key:'playful',value:68,quote:''}],
 identity:[{text:'名字叫小舟',quote:'角色名叫小舟'}],
 background:[{text:'设定为在海边城镇长大',quote:'小时候在虚构的海边城镇长大'}],
 style:[{text:'习惯称呼对方老大',quote:'习惯叫对方老大'}],
 interest:[{text:'旧卡写过喜欢游戏视频',quote:'她喜欢看游戏视频'}],
};

test('legacy starter requires quoted card evidence and leaves unsupported dimensions at default',()=>{
 const valid=validateLegacyStarter(preview,card,dims);
 assert.equal(valid.starter[0].value,70);
 assert.equal(valid.legacy.entries.background.length,1);
 assert.equal(valid.legacy.entries.interest[0].text,'她喜欢看游戏视频');
 assert.match(legacyStarterPrompt(card,dims),/旧角色卡迁移/);
 assert.match(legacyStarterPrompt(card,dims),/主人的喜好/);
 assert.throws(()=>validateLegacyStarter({...preview,background:[{text:'住在月球',quote:'月球'}]},card,dims),/原文依据/);
 assert.throws(()=>validateLegacyStarter({...preview,dimensions:[{key:'warm',value:70,quote:'不存在'},preview.dimensions[1]]},card,dims),/原卡依据/);
});

test('Markdown emphasis omitted by the model is recovered only from the same source span',()=>{
 const formatted='她说话温暖。**默认 1~30 字**：长短有变化。';
 const result=validateLegacyStarter({dimensions:[{key:'warm',value:70,quote:'说话温暖'},{key:'playful',value:68,quote:''}],identity:[],background:[],style:[{text:'旧卡偏好短句',quote:'默认 1~30 字：长短有变化。'}],interest:[]},formatted,dims);
 assert.equal(result.legacy.entries.style[0].quote,'**默认 1~30 字**：长短有变化。');
 assert.equal(result.legacy.entries.style[0].text,'默认 1~30 字：长短有变化。');
 assert.throws(()=>validateLegacyStarter({...preview,style:[{text:'无依据',quote:'默认每天固定十条'}]},formatted,dims),/原文依据/);
 const invented=validateLegacyStarter({...preview,interest:[{text:'喜欢游戏视频和露营',quote:'她喜欢看游戏视频。'}]},card,dims);
 assert.equal(invented.legacy.entries.interest[0].text,'她喜欢看游戏视频。');
});

test('only a new, confirmed setup seeds card references separately from lived claims',()=>{
 const persona={spec:{dimensions:dims.map(d=>({key:d.key,label:d.label,baseline:d.value,band:20}))},baseline:{warm:42,playful:68},current:{warm:42,playful:68}};
 const file={socialV2:{}},features={...setupFeatures(file),self:true,continuity:true};
 const body={revision:setupRevision(file),features,starter:validateLegacyStarter(preview,card,dims).starter,legacyCard:card,legacyPreview:preview};
 const next=planSetup(file,body,{origin:{freshPersona:true},state:{claims:[],queue:[]},persona,ownerAllowed:true});
 assert.equal(next.xinjiSetup.legacy.entries.background[0].quote,preview.background[0].quote);
 assert.equal(next.xinjiSetup.legacy.entries.interest[0].text,'她喜欢看游戏视频');
 assert.equal(JSON.stringify(next).includes(card),false);
 let saved;
 const self=new SelfReference({enabled:()=>true,allowed:key=>key==='owner',initialPersona:persona,initialLegacy:setupInitialLegacy(next.xinjiSetup,null,{freshPersona:true}),save:s=>saved=s});
 assert.equal(self.state.claims.length,0);
 assert.match(self.render('owner'),/旧角色卡的初始设定/);
 assert.match(self.render('owner'),/旧卡兴趣候选，未确认/);
 assert.match(self.render('owner'),/不因这些候选改变拾光选题/);
 assert.doesNotMatch(self.render('group'),/海边城镇/);
 assert.equal(setupInitialLegacy(next.xinjiSetup,saved,{freshPersona:true}),null);
 assert.throws(()=>planSetup(file,body,{origin:{freshPersona:true},state:saved,persona,ownerAllowed:true}),/已有性格或经历/);
});
