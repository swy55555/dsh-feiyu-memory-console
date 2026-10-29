// Offline, deterministic contract exercises. Never reads installed state or calls a model.
import {ResponsePatterns} from '../bridge/response-patterns.mjs';
import {MindWorkspace} from '../bridge/mind-workspace.mjs';
import assert from 'node:assert/strict';
let now=100*86400000;const key='private:demo',results=[];
const p=new ResponsePatterns({allowed:k=>k===key,enabled:()=>true,now:()=>now});
function report(name,fn){fn();results.push({scenario:name,result:'pass'});}
function feedback(id,quote,extra={},source='user'){p.observe(key,[{strategy:'comfort_first',outcome:'helpful',experienceId:'',evidenceKind:'new',quote,confidence:.95,...extra}],{id,at:now,original:quote,source});}
report('普通聊天没有明确反馈 → 不形成回应倾向',()=>{p.observe(key,[],{id:'ordinary',at:now,original:'今天有点累',source:'user'});assert.equal(p.view(key).evidence.length,0);});
report('角色自己的安慰和模拟练习 → 不作为用户反馈',()=>{feedback('self','这样安慰很有效',{},'assistant');feedback('lesson','模拟课程打了满分',{},'simulation');assert.equal(p.view(key).evidence.length,0);});
report('首次肯定 → 暂时积累，不立刻改习惯',()=>{feedback('one','今天你先听我说完，让我舒服一些');assert.equal(p.candidates(key,'user_distress').length,0);});
report('跨日重复同件事 → 不增加次数或续期',()=>{now+=86400000;feedback('repeat','还是上回那件事，你听我说完很好',{evidenceKind:'repeat',experienceId:p.view(key).evidence[0].id});assert.equal(p.view(key).evidence.length,1);});
report('第三次独立肯定 → 仅适用情境提供参考',()=>{feedback('two','这次工作不顺，你先听我说，确实有帮助');now+=86400000;feedback('three','今天家里的事，你没急着给建议，这样很好');assert.equal(p.candidates(key,'user_distress').length,1);assert.equal(p.candidates(key,'neutral').length,0);});
report('用户明确反对 → 立即暂停',()=>{feedback('negative','我现在需要方案，不喜欢你一直只听着',{outcome:'unhelpful'});assert.equal(p.candidates(key,'user_distress').length,0);});
const w=new MindWorkspace({allowed:k=>k===key,enabled:()=>true,maxItems:1});w.begin(key,'current');
report('重要请求相关记忆优先 → 联想暂缓',()=>{const result=w.compose(key,[{id:'fact',type:'memory',score:.9,text:'会议约在下午三点'},{id:'idea',type:'association',score:.4,text:'也许可以聊聊旅行'}],{continuityMessageId:'current'});assert.equal(result.selected[0].id,'fact');assert.equal(w.snapshot(key).deferred[0].id,'idea');});
report('新消息打断 → 旧轮次参考失效',()=>{w.begin(key,'next');assert.equal(w.compose(key,[{id:'old',type:'emotion',score:1,text:'旧心情'}],{continuityMessageId:'current'}).text,'');});
console.log(JSON.stringify({version:'0.9.0',mode:'offline-fixtures',modelCalls:0,notice:'输入中的语义判断是预设测试数据；通过不代表真实模型识别正确，也不会写入真实记忆或学习状态。',results},null,2));
