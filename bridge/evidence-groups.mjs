// Group metadata is advisory about context, never an authorization or truth claim.
// Merge overlapping groups so that iteration order cannot leak half a group.
export function evidenceUnits(rows,heldRoots=new Set()){
  const parent=new Map();
  const root=x=>{if(!parent.has(x))parent.set(x,x);let r=x;while(parent.get(r)!==r)r=parent.get(r);return r;};
  const join=(a,b)=>parent.set(root(b),root(a));
  const invalid=new Set();
  for(const r of rows){
    const members=r.contextVersions??r.retrieval?.contextVersions;
    if(members===undefined)continue;
    if(!Array.isArray(members)||members.length<2||members.length>12||members.some(x=>typeof x!=='string'||!x||x.length>128)||!(r.contract?.rootIds||[]).some(x=>members.includes(x))){invalid.add(r);continue;}
    for(const x of members)join(members[0],x);
  }
  const members=new Map();for(const x of parent.keys()){const k=root(x);if(!members.has(k))members.set(k,[]);members.get(k).push(x);}
  const units=[],byGroup=new Map();
  for(const r of rows){
    const groups=[...new Set((r.contract?.rootIds||[]).filter(x=>parent.has(x)).map(root))];
    if(invalid.has(r)||groups.length>1){units.push({rows:[r],requiredRoots:[],missing:true});continue;}
    const g=groups[0];
    if(g===undefined){units.push({rows:[r],requiredRoots:[],missing:false});continue;}
    if(!byGroup.has(g)){const u={rows:[],requiredRoots:members.get(g),missing:false};byGroup.set(g,u);units.push(u);}
    byGroup.get(g).rows.push(r);
  }
  for(const u of units){
    const available=new Set([...heldRoots,...u.rows.filter(r=>!invalid.has(r)).flatMap(r=>r.contract?.rootIds||[])]);
    u.missing ||= u.requiredRoots.some(x=>!available.has(x));
  }
  return units;
}
