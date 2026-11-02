import assert from 'node:assert/strict';import http from 'node:http';import {createRequire} from 'node:module';
import {createApiHandler} from '../lib/api.js';
const {chromium}=createRequire(import.meta.url)(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const server=http.createServer(createApiHandler());let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let queries=0,missing=false,impacts=0;
 await page.route('**/api/**',async route=>{
  const u=new URL(route.request().url()),p=u.pathname.replace(/^.*\/api/,'');assert.equal(route.request().method(),'GET');let data={ok:true};
  if(p==='/overview')data={ok:true,ownerQQ:'1',scopes:[{scope:'private:1',label:'测试私聊'}],recent:[],fading:[],health:{ok:true,capabilities:[]}};
  if(p==='/library')data={ok:true,total:1,rows:[{id:'r1',scope:'private:1',text:'用户曾说：我只在周末喝咖啡',tags:'habit',status:'active',tier:'normal',memoryKind:'experience',sourceId:'m1',subjectId:'1',sourceText:'我只在周末喝咖啡',sourceTime:Date.now(),createdAt:Date.now(),importance:.5,strength:10,recall:.9}]};
  if(p==='/source-status'){
   assert.equal(u.searchParams.get('scope'),'private:1');assert.equal(u.searchParams.get('id'),'r1');queries++;
   data=missing?{ok:true,status:'unavailable',modelCalls:0}:{ok:true,status:'matched',retained:true,inRecentWindow:false,version:'a'.repeat(64),modelCalls:0};
  }
  if(p==='/source-impact'){
   assert.equal(u.searchParams.get('scope'),'private:1');assert.equal(u.searchParams.get('id'),'r1');impacts++;
   data=missing?{ok:true,status:'unavailable',modelCalls:0}:{ok:true,status:'matched',total:3,counts:{current:1,historical:2,unavailable:0},items:[{kind:'memory',id:'r1',text:'<script>这段必须按文字展示</script>',status:'active',reference:'current'},{kind:'bridge:self-reference',id:'s1',text:'旧自我参考',status:'retracted',reference:'historical'},{kind:'bridge:association-feeling',id:'idea:1:feeling',text:'过去的好奇',status:'past-impression',reference:'historical',indirect:true,via:[{kind:'memory',id:'r1',parentState:'changed-version'},{kind:'memory',id:'r2'},{kind:'bridge:association',id:'idea:1'}]}],source:{version:'b'.repeat(64)},checkedAt:Date.now(),modelCalls:0};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/library?scope=private:1&status=active`);
 await page.getByText('查看记忆来源',{exact:true}).first().click();assert.equal(queries,0);assert.equal(impacts,0);
 const button=page.getByRole('button',{name:'核对完整原话（本地）',exact:true});await button.click();
 await page.getByRole('status').filter({hasText:'依据已独立保留'}).waitFor();assert.equal(queries,1);
 const impact=page.getByRole('button',{name:'查看纠正影响（只读）',exact:true});await impact.click();
 await page.getByText('这句原话关联了 3 条记录',{exact:true}).waitFor();assert.equal(impacts,1);await page.getByText('当时的主观感受 · 历史引用',{exact:true}).waitFor();assert.ok((await page.locator('.source-impact').innerText()).includes('记忆 r1（已是另一版本） + 记忆 r2 → 曾生成的联想 idea:1'));
 await page.getByText('自我参考 · 历史引用',{exact:true}).waitFor();await page.getByText('<script>这段必须按文字展示</script>',{exact:true}).waitFor();
 assert.ok((await page.locator('.source-impact').innerText()).includes('间接关系尚未完整记录'));assert.ok(!(await page.locator('.source-impact').innerText()).includes('null'));
 missing=true;await button.click();await page.getByRole('status').filter({hasText:'不代表这条记忆一定错误'}).waitFor();
 await impact.click();await page.getByText('原话不可用，不能可靠列出影响范围。这不表示没有影响，也不会因此删除或确认记忆。',{exact:true}).waitFor();assert.equal(impacts,2);
 assert.equal(queries,2);assert.deepEqual(errors,[]);console.log('PASS source evidence UI: on-demand local GET, retained version, honest missing-source state, no write/model route');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
