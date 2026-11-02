import * as emotion from '../bridge/emotion.js';
import {randomUUID} from 'node:crypto';
import {memvecHeaders} from '../bridge/memvec-auth.mjs';
import {assembleReferences,summarizeAssembly} from '../bridge/reference-assembly.mjs';
import * as goals from '../bridge/goals.mjs';
import * as rhythm from '../bridge/rhythm.mjs';
import * as shared from '../bridge/shared-activities.mjs';
import * as repair from '../bridge/repair.mjs';
import {RetrievalSessions,renderEvidence} from '../bridge/retrieval-session.mjs';
export function wireEvidenceFixture(ctx){
  ctx.renderEvidence=renderEvidence;ctx.isSessionAllowedInCurrentMode=()=>true;ctx.socialV2={paused:false};
  ctx.retrievalSessions=new RetrievalSessions({request:async(route,body)=>{
    const response=await ctx.fetch('http://fixture.invalid'+route,{body:JSON.stringify(body)});
    const data=await response.json();
    return {...data,results:(data.results||[]).map(r=>({...r,contract:r.contract||{version:1,scope:r.scope,speaker:r.subject_id||'',sourceType:'organized-fact',recordKind:r.tier==='task'?'plan-not-known-complete':'past-statement',sourceId:r.source_id||r.id,rootIds:[r.source_id||r.id],spokenAt:r.source_time||null}}))};
  }});
}
// These VM tests use synthetic HTTP peers; never read a live service credential.
process.env.MEMVEC_API_TOKEN=randomUUID().replaceAll('-', '');
export const extras={associationSnapshot:()=>({strong:[],weak:[]}),appendBroadcastTrace:()=>{},ASSEMBLER_VERSION:"test",narrativeState:{},currentNarrative:()=>null,...emotion,memvecHeaders,assembleReferences,summarizeAssembly,emotionViewFor:()=>emotion.emptyEmotion(),emotionRecoveryCfg:()=>({}),idleAssociations:{feeling:()=>null},...goals,...rhythm,...shared,...repair,goalsState:goals.normalizeGoals(null),sharedState:shared.normalizeShared(null),repairState:repair.normalizeRepairs(null),saveRepairState:()=>{},setInterval,clearInterval,setTimeout,clearTimeout};
