import * as emotion from '../bridge/emotion.js';
import {randomUUID} from 'node:crypto';
import {memvecHeaders} from '../bridge/memvec-auth.mjs';
import {assembleReferences,summarizeAssembly} from '../bridge/reference-assembly.mjs';
import * as goals from '../bridge/goals.mjs';
import * as rhythm from '../bridge/rhythm.mjs';
import * as shared from '../bridge/shared-activities.mjs';
import * as repair from '../bridge/repair.mjs';
// These VM tests use synthetic HTTP peers; never read a live service credential.
process.env.MEMVEC_API_TOKEN=randomUUID().replaceAll('-', '');
export const extras={associationSnapshot:()=>({strong:[],weak:[]}),appendBroadcastTrace:()=>{},ASSEMBLER_VERSION:"test",narrativeState:{},currentNarrative:()=>null,...emotion,memvecHeaders,assembleReferences,summarizeAssembly,emotionViewFor:()=>emotion.emptyEmotion(),emotionRecoveryCfg:()=>({}),idleAssociations:{feeling:()=>null},...goals,...rhythm,...shared,...repair,goalsState:goals.normalizeGoals(null),sharedState:shared.normalizeShared(null),repairState:repair.normalizeRepairs(null),saveRepairState:()=>{},setInterval,clearInterval,setTimeout,clearTimeout};
