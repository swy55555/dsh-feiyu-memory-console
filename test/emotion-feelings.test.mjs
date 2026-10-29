import test from 'node:test'
import assert from 'node:assert/strict'
import {emptyEmotion,applyEmotionEvent,tickEmotion,emotionPromptLine} from '../bridge/emotion.js'
import {validateSemanticAppraisal} from '../bridge/emotion-appraisal.mjs'
const base=1000000000
const input=(id,feelings,kind='neutral',confidence=.8)=>({source:'owner',eventId:id,text:'今天发现一个新东西，真开心',appraisal:{kind,target:kind==='conflict'?'character':'none',confidence,intensity:.5,evidence:kind==='neutral'?[]:['真开心'],feelings:feelings.map(k=>({kind:k,intensity:.5,evidence:'新东西'}))}})
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
 assert.ok(s.state.valence<=.21);assert.ok(s.state.arousal<=.38);assert.equal(s.relationshipSamples,0)
 const same=tickEmotion(s,base+39);assert.equal(same.state.valence,s.state.valence)
 const later=tickEmotion(s,base+120*60000);assert.ok(later.state.valence<s.state.valence);assert.equal(later.state.nuance,'')
 assert.equal(applyEmotionEvent(s,input('39',['joy']),base+39).state.valence,s.state.valence)
})
test('uncertain hostility cannot become anger; daily negative tone is limited and cannot produce relationship conflict',()=>{
 let s=emptyEmotion(base);for(let i=0;i<20;i++)s=applyEmotionEvent(s,input('c'+i,['concern','disappointment'],'conflict',.8),base+i)
 assert.equal(s.dynamics.conflict,0);assert.notEqual(s.state.label,'生气');assert.ok(s.state.valence>=.08);assert.equal(s.relationshipSamples,0)
})
test('daily warmth does not erase genuine unresolved conflict',()=>{
 let s=emptyEmotion(base);for(let i=0;i<5;i++)s=applyEmotionEvent(s,input('c'+i,[],'conflict',.95),base+i)
 const before=s.dynamics.conflict;s=applyEmotionEvent(s,input('warm',['joy','warmth']),base+5)
 assert.ok(s.dynamics.conflict>=before-.00001);assert.equal(s.state.nuance,'');assert.ok(s.state.valence<0)
})
