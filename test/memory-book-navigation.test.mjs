import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
function section(start,end){
  const a=source.indexOf(start),b=source.indexOf(end,a+start.length);
  assert.ok(a>=0&&b>a,`missing app section: ${start}`);
  return source.slice(a,b);
}
const code=[
  section('function memoryViewVisible(view)', '\nfunction hasCap('),
  section('function reloadLibraryWith(patch = {})', '\nfunction renderLibrary('),
  section('async function loadDiary()', '\nfunction diaryBook('),
].join('\n');

test('time-line scope and status clicks repaint the nested memory view',()=>{
  let paints=0;
  const S={tab:'memory',memoryView:'timeline',library:{scope:'all',status:'active',loaded:true},semantic:{}};
  const ctx=vm.createContext({S,paintCurrent:()=>{paints++}});
  vm.runInContext(code,ctx);
  vm.runInContext("reloadLibraryWith({scope:'private:2'})",ctx);
  vm.runInContext("reloadLibraryWith({status:'candidate'})",ctx);
  assert.equal(S.library.scope,'private:2');
  assert.equal(S.library.status,'candidate');
  assert.equal(S.library.loaded,false);
  assert.equal(S.semantic,null);
  assert.equal(paints,2);
  S.memoryView='diary';
  vm.runInContext("reloadLibraryWith({status:'archived'})",ctx);
  assert.equal(paints,2);
  S.tab='library';
  vm.runInContext("reloadLibraryWith({status:'deleted'})",ctx);
  assert.equal(paints,3);
});

test('loaded diary entries repaint the nested diary view',async()=>{
  let paints=0;
  const S={tab:'memory',memoryView:'diary',diary:{token:'',books:null,dates:{},autoImport:false}};
  const ctx=vm.createContext({S,sessionStorage:{getItem:()=>''},withBusy:fn=>fn(),
    api:async()=>({books:[{id:'public',entries:[{date:'2026-11-02'}]}],dates:{'2026-11-02':true},autoImport:false}),
    paintCurrent:()=>{paints++},toast:()=>{throw Error('unexpected error')}});
  vm.runInContext(code,ctx);
  await vm.runInContext('loadDiary()',ctx);
  assert.equal(S.diary.books[0].entries[0].date,'2026-11-02');
  assert.equal(paints,1);
});
