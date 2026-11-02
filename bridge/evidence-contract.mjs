import {createHash} from 'node:crypto';
// External material never identifies a user's preference or an actual action.
export function externalEvidence({url='',author='',excerpt='',at=null,rootIds=[]}={}){
  const sourceVersion=createHash('sha256').update(JSON.stringify(['external-v1',url,author,excerpt])).digest('hex');
  return {version:1,scope:'self',sourceType:'external-document',speaker:author||'unknown-author',
    sourceId:url,sourceVersion,rootIds:rootIds.length?[...new Set(rootIds)]:[sourceVersion],
    spokenAt:null,eventAt:null,plannedAt:null,recordedAt:at,state:'observed',moduleVersion:1,
    causalId:sourceVersion,idempotencyKey:sourceVersion};
}
