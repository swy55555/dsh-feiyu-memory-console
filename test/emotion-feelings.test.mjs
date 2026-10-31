import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyEmotion,applyEmotionEvent,tickEmotion,emotionPromptLine,withSubjectiveFeeling} from '../bridge/emotion.js'
import {validateSemanticAppraisal} from '../bridge/emotion-appraisal.mjs'
const base=1000000000
const input=(id,feelings,kind='neutral',confidence=.8)=>({source:'owner',eventId:id,text:'今天发现一个新东西，真开心',appraisal:{kind,target:kind==='conflict'?'character':'none',confidence,intensity:.5,evidence:kind==='neutral'?[]:['真开心'],feelings:feelings.map(k=>({kind:k,intensity:.5,evidence:'新东西'}))}})

test('a weaker new warm event reinforces instead of overwriting warmth; decay, settlement and negative evidence remain separate',()=>{
 const event=(id,text,kind,intensity,action='evoke')=>({source:'owner',eventId:id,text,appraisal:{kind:'neutral',target:'none',confidence:.9,intensity:0,evidence:[],feelings:[{kind,intensity,confidence:.9,evidence:text,action}]}});
 const first=applyEmotionEvent(emptyEmotion(base),event('a','今天聊得很开心','warmth',.6),base);
 const before=tickEmotion(first,base+60000),next=applyEmotionEvent(first,event('b','你在干嘛呢','warmth',.22),base+60000);
 assert.ok(next.dailyFeelings.levels.warmth>=before.dailyFeelings.levels.warmth);assert.ok(next.triggers[0].deltaV>=0);
 assert.equal(next.triggers[0].feelings[0].label,'温暖');assert.equal(next.triggers[0].dynamicsVersion,3);
 const neutral=applyEmotionEvent(next,event('c','普通消息','warmth',0),base+120000);
 assert.equal(neutral.triggers[0].deltaV,0);assert.ok(neutral.state.valence<next.state.valence);
 const settled=applyEmotionEvent(next,event('d','这件事已经过去了','warmth',0,'settle'),base+120000);assert.ok(settled.dailyFeelings.levels.warmth<.04);
 const sad=applyEmotionEvent(next,event('e','这次的结果让我失落','disappointment',.6),base+120000);assert.ok(sad.triggers[0].deltaV<0);assert.equal(sad.dynamics.conflict,0);
});

test('affection responds to event strength, retains bounds, and presentation respects configured recovery',()=>{
 const make=level=>({source:'owner',eventId:'affection',text:'谢谢你在我身边',appraisal:{kind:'affection',target:'character',confidence:.95,intensity:level,evidence:['谢谢你在我身边'],feelings:[]}});
 const mild=applyEmotionEvent(emptyEmotion(base),make(.15),base),strong=applyEmotionEvent(emptyEmotion(base),make(.8),base),zero=applyEmotionEvent(emptyEmotion(base),make(0),base);
 assert.ok(strong.state.intensity>mild.state.intensity*3);assert.ok(strong.state.intensity>=.15);assert.equal(zero.state.intensity,0);
 const recovery={emotionHalfLifeMinutes:60};
 const shown=withSubjectiveFeeling(strong,null,base+60*60000,recovery),expected=tickEmotion(strong,base+60*60000,recovery);
 assert.equal(shown.state.valence,expected.state.valence);assert.ok(shown.state.intensity>.05);
 assert.equal(applyEmotionEvent(strong,make(.8),base).state.valence,strong.state.valence);
});

test('mixed feelings keep individual strength and compact reply reference agrees with display',()=>{
 const state=applyEmotionEvent(emptyEmotion(base),input('mixed',['warmth','concern']),base);
 assert.ok(state.state.feelingStrength>state.state.intensity);
 assert.match(state.state.displayLabel,/平静.*温暖.*牵挂/);
 const prompt=emotionPromptLine(state,{isOwner:true,compact:true});assert.ok(prompt.includes(state.state.displayLabel));assert.ok(prompt.length<700);
 assert.match(prompt,/历史输入/);assert.match(prompt,/不等于每项感受强度/);
});
test('ordinary curiosity and joy are visible in the state and prompt without training relationship/personality',()=>{
 const s=applyEmotionEvent(emptyEmotion(base),input('1',['curiosity','joy']),base)
 assert.ok(s.state.arousal>.32);assert.ok(s.state.valence>.12);assert.match(s.state.nuance,/好奇|轻快/);assert.match(emotionPromptLine(s,{isOwner:true}),/细微感受：/)
 assert.equal(s.relationshipSamples,0);assert.equal(s.climate.owner.samples,0);assert.equal(s.dynamics.conflict,0);assert.equal(s.mood.valence,.12)
})
test('neutral conversation without evidence stays neutral; invalid feeling quotes fail validation',()=>{
 const i=input('1',[]);const s=applyEmotionEvent(emptyEmotion(base),i,base);assert.equal(s.state.valence,.12);assert.equal(s.state.nuance,'')
 assert.equal(validateSemanticAppraisal({...i.appraisal,feelings:[{kind:'joy',intensity:.8,evidence:'不存在'}]},i.text),null)
 assert.equal(validateSemanticAppraisal({...i.appraisal,feelings:[{kind:'anger',intensity:1,evidence:'新东西'}]},i.text),null)
})
test('daily feelings decay independently, do not grow from refreshes, and repeated messages stay bounded',()=>{
 let s=emptyEmotion(base);for(let i=0;i<40;i++)s=applyEmotionEvent(s,input(String(i),['joy','warmth']),base+i)
 assert.ok(s.state.valence<=.38);assert.ok(s.state.arousal<=.5);assert.equal(s.relationshipSamples,0)
 const same=tickEmotion(s,base+39);assert.equal(same.state.valence,s.state.valence)
 const later=tickEmotion(s,base+120*60000);assert.ok(later.state.valence<s.state.valence);assert.equal(later.state.nuance,'')
 assert.equal(applyEmotionEvent(s,input('39',['joy']),base+39).state.valence,s.state.valence)
})
test('uncertain hostility cannot become anger; daily negative tone is limited and cannot produce relationship conflict',()=>{
 let s=emptyEmotion(base);for(let i=0;i<20;i++)s=applyEmotionEvent(s,input('c'+i,['concern','disappointment'],'conflict',.8),base+i)
 assert.equal(s.dynamics.conflict,0);assert.notEqual(s.state.label,'生气');assert.ok(s.state.valence>=0);assert.equal(s.relationshipSamples,0)
})
test('daily warmth does not erase genuine unresolved conflict',()=>{
 let s=emptyEmotion(base);for(let i=0;i<5;i++)s=applyEmotionEvent(s,input('c'+i,[],'conflict',.95),base+i)
 const before=s.dynamics.conflict;s=applyEmotionEvent(s,input('warm',['joy','warmth']),base+5)
 assert.ok(s.dynamics.conflict>=before-.00001);assert.equal(s.state.nuance,'');assert.ok(s.state.valence<0)
})

test('meaningful daily events move actual state; weaker interactions remain gentler and refresh cannot amplify',()=>{
 const make=(level,kind)=>({...input('different',[]),appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[],feelings:[{kind,intensity:level,confidence:.95,evidence:'新东西'}]}})
 const mild=applyEmotionEvent(emptyEmotion(base),make(.2,'joy'),base),strong=applyEmotionEvent(emptyEmotion(base),make(.65,'joy'),base)
 assert.ok(strong.state.intensity>=.15);assert.ok(strong.state.intensity>mild.state.intensity*2);assert.equal(strong.state.label,'愉快')
 const curious=applyEmotionEvent(emptyEmotion(base),make(.5,'curiosity'),base);assert.ok(curious.state.arousal-.32>curious.state.valence-.12)
 assert.equal(tickEmotion(strong,base).state.intensity,strong.state.intensity);assert.equal(strong.relationshipSamples,0)
})

test('same short affection is deduplicated within the interaction, but can be a new interaction later',()=>{
 const first=applyEmotionEvent(emptyEmotion(base),input('one',['warmth']),base)
 const duplicate=applyEmotionEvent(first,input('two',['warmth']),base+60000)
 assert.equal(duplicate.dailyFeelings.sources.warmth.at,base)
 const later=applyEmotionEvent(duplicate,input('three',['warmth']),base+20*60000)
 assert.equal(later.dailyFeelings.sources.warmth.at,base+20*60000);assert.ok(later.dailyFeelings.levels.warmth>tickEmotion(first,base+20*60000).dailyFeelings.levels.warmth)
 assert.equal(later.dynamics.conflict,0)
})
