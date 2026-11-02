import {createHash} from 'node:crypto';

// This budgets generated reference blocks, never the current request, tools or persona rules.
// No semantic similarity guess: only identical text with the same scope, purpose and version.
export function assembleReferences({key,blocks=[],budgetChars=8000}={}) {
  const budget=Math.max(2400,Math.min(16000,Number(budgetChars)||8000));
  const selected=[],decisions=[],seen=new Set();let used=0,inputChars=0;
  for(const [index,item] of blocks.map((b,i)=>[i,b]).filter(([,b])=>b&&typeof b==='object').sort((a,b)=>(b[1].priority||0)-(a[1].priority||0)||a[0]-b[0])) {
    if(!item||typeof item.text!=='string'||!item.text)continue;
    inputChars+=item.text.length;
    const meta={id:item.id,chars:item.text.length,reason:''};
    if(item.scope!==key){decisions.push({...meta,reason:'scope-mismatch'});continue;}
    const fingerprint=createHash('sha256').update(JSON.stringify([key,item.purpose||item.id,item.version||'',item.text])).digest('hex');
    if(seen.has(fingerprint)){decisions.push({...meta,reason:'exact-duplicate'});continue;}
    let text=item.text;
    if(used+text.length>budget&&!item.required){
      text=typeof item.fit==='function'?item.fit(Math.max(0,budget-used)):'';
      // A renderer must return complete records under budget, not cut arbitrary strings.
      if(typeof text!=='string'||text.length>budget-used)text='';
    }
    if(!text){decisions.push({...meta,reason:'budget'});continue;}
    seen.add(fingerprint);selected.push({id:item.id,text,index});used+=text.length;
    decisions.push({...meta,selectedChars:text.length,reason:text===item.text?'selected':'complete-records-only'});
  }
  selected.sort((a,b)=>a.index-b.index);
  return {text:selected.map(r=>r.text).join(''),blocks:selected.map(({index,...r})=>r),
    report:{budgetChars:budget,inputChars,usedChars:used,omittedChars:inputChars-used,protectedOverflow:used>budget,decisions}};
}
