// Deterministic mechanism replay, NOT a real model evaluation or personal experience.
import assert from 'node:assert/strict';
import {emptyEmotion,applyEmotionEvent,tickEmotion} from '../bridge/emotion.js';
import {automaticLightContext,parseLightNotes,applyAutomaticLight} from '../bridge/daily-memory.js';
let at=1800000000000,state=emptyEmotion(at);const rows=[];
function step(text,feelings=[],kind='neutral'){
 at+=60000;state=applyEmotionEvent(state,{source:'owner',eventId:'replay-'+rows.length,text,appraisal:{kind,target:kind==='criticism'?'task':'none',confidence:.95,intensity:kind==='criticism'?.25:0,evidence:kind==='neutral'?[]:[text],feelings}},at);
 rows.push({message:text,emotion:state.state.label,feelings:state.state.nuance||'无额外感受',deviation:state.state.intensity,conflict:state.dynamics.conflict,personalitySamples:state.relationshipSamples});
}
const feeling=(kind,evidence,intensity,reason,action='evoke')=>({kind,evidence,intensity,reason,confidence:.95,action});
step('今天试了一种新咖啡做法，挺有意思',[feeling('curiosity','新咖啡做法',.4,'接住新的分享')]);
step('今天试了一种新咖啡做法，挺有意思',[feeling('curiosity','新咖啡做法',.4,'接住新的分享')]);
step('明天要面试，有些紧张',[feeling('concern','明天要面试，有些紧张',.45,'对明确待办有一点牵挂')]);
step('帮我看一下这段代码');
step('面试已经通过了，不用担心',[feeling('concern','面试已经通过了，不用担心',0,'挂念的事已结束','settle'),feeling('relief','面试已经通过了',.5,'得到明确好结果')]);
step('这段代码你理解错了',[],'criticism');
step('我先去忙，晚点再聊');
assert.ok(rows.every(r=>r.conflict===0&&r.personalitySamples===0));assert.match(rows[0].feelings,/好奇/);assert.doesNotMatch(rows[4].feelings,/牵挂/);assert.match(rows[4].feelings,/安心/);
state=tickEmotion(state,at+180*60000);assert.equal(state.state.nuance,'');
const notes={},m={id:'source-1',userId:'demo',text:'明天面试，路线还没确认',time:at};
const open={source_id:m.id,quote:m.text,topic:'确认面试路线',action:'open',target_id:'',ttlHours:12,confidence:.95,assessment:{subject:'self',mode:'asserted',sensitive:false}};
applyAutomaticLight(notes,parseLightNotes([open],[m]),at);const expiresAt=notes.autoTopics[0].expiresAt;
applyAutomaticLight(notes,parseLightNotes([open],[m]),at+60000);assert.equal(notes.autoTopics.length,1);assert.equal(notes.autoTopics[0].expiresAt,expiresAt);
console.log(JSON.stringify({kind:'离线规则回放：情境判断由测试预设，不代表实际模型识别率',rows,afterThreeHours:{emotion:state.state.label,feelings:state.state.nuance},notes:{active:automaticLightContext(notes,at).length,duplicateDidNotRenew:true},checks:'passed'},null,2));
