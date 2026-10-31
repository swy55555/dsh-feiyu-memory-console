import assert from 'node:assert/strict'
import http from 'node:http'
import {createRequire} from 'node:module'
import {createApiHandler} from '../lib/api.js'
const {chromium}=createRequire(import.meta.url)(process.env.FEIYU_PLAYWRIGHT_PATH || 'playwright')
const server=http.createServer(createApiHandler())
let browser
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  browser=await chromium.launch({headless:true,channel:process.env.FEIYU_BROWSER_CHANNEL || 'msedge'})
  const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[],calls=[]
  page.on('pageerror',e=>errors.push(e.message))
  let failPreview=false
  await page.route('**/api/**', async route=>{
    const api=new URL(route.request().url()).pathname.replace(/^.*\/api/,'')
    let data={ok:true}
    if(api==='/overview') data={ok:true,ownerQQ:'1',total:3,candidate:2,scopes:[{scope:'private:1',label:'测试私聊'},{scope:'group:2',label:'测试群聊'}],recent:[],fading:[],health:{ok:true,capabilities:[],bridge:{ok:true}}}
    if(api==='/audit') data={ok:true,entries:[]}
    if(api.startsWith('/organize/')) {
      const body=route.request().postDataJSON();calls.push({api,body})
      assert.equal(route.request().headers()['x-feiyu-console'],'1')
      if(api.endsWith('/preview')) {
        if(failPreview) {failPreview=false;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试服务暂不可用'})});return}
        data={ok:true,scope:body.scope,token:'test-preview',modelCalls:0,graceUntil:Date.now()+100000,total:4,next:body.after?'':'next',items:body.after?[]:[
          {id:'a',action:'archive',text:'过期记录',reason:'已到期',source_text:'明确期限'},
          {id:'b',action:'confirm',text:'已有完整审核',reason:'审核通过'},
          {id:'c',action:'hold',text:'<img src=x onerror=alert(1)>',reason:'缺审核；本次不调用模型',source_text:'保留原话'}]}
      } else if(api.endsWith('/apply')) {
        if(body.action==='archive-selected'){
          assert.deepEqual(body.ids,['c']);assert.equal(body.acknowledge,true)
          data={ok:true,changed:1,applied:[{id:'c',action:'archive'}],skipped:[],modelCalls:0}
        }else{
          assert.deepEqual(body.ids,['a','b'])
          data={ok:true,changed:1,applied:[{id:'a',action:'archive'}],skipped:[{id:'b',reason:'相关事实已改变'}],modelCalls:0}
        }
      } else throw Error('Unexpected organizer route')
    }
    if(['/action','/candidate-auto','/queue/flush'].includes(api) && route.request().method()==='POST')throw Error('Unexpected paid action')
    await route.fulfill({contentType:'application/json',body:JSON.stringify(data)})
  })
  await page.goto(`http://127.0.0.1:${server.address().port}/#/upkeep`)
  const panel=page.locator('#memory-organizer')
  await panel.getByRole('heading',{name:'省心整理'}).waitFor()
  assert.equal(calls.length,0)
  await panel.getByRole('button',{name:'本地预览（不调用模型）'}).click()
  await panel.getByText('保留待处理 1 条 · 展开查看原因',{exact:true}).click()
  await panel.getByText('缺审核；本次不调用模型',{exact:true}).waitFor()
  assert.equal(calls[0].body.scope,'private:1')
  assert.equal(await panel.locator('img').count(),0)
  assert.equal(await panel.getByLabel('选择：<img src=x onerror=alert(1)>').isDisabled(),false)
  assert.equal(await panel.locator('input:checked').count(),0)
  await panel.getByRole('button',{name:'全选本页',exact:true}).click()
  assert.equal(await panel.locator('input:checked').count(),3)
  assert.equal(await panel.getByRole('button',{name:'按建议处理 3 条'}).isDisabled(),true)
  assert.equal(await panel.getByRole('button',{name:'主动归档所选 3 条'}).isDisabled(),false)
  await panel.getByRole('button',{name:'仅选择建议项'}).click()
  assert.equal(await panel.locator('input:checked').count(),2)
  await panel.getByRole('button',{name:'按建议处理 2 条'}).click()
  await panel.getByRole('status').filter({hasText:'已处理 1 条，跳过 1 条'}).waitFor()
  assert.equal(calls.filter(c=>c.api.endsWith('/apply')).length,1)
  assert.equal(await panel.getByRole('button',{name:'按建议处理 0 条'}).isDisabled(),true)
  await panel.getByRole('button',{name:'下一页'}).click()
  await panel.getByText('暂时没有需要整理的记录，现有记忆保持原样。').waitFor()
  assert.equal(calls.at(-1).body.after,'next')
  await panel.getByLabel('整理哪个聊天').selectOption('group:2')
  assert.equal(await panel.getByRole('checkbox').count(),0)
  failPreview=true
  await panel.getByRole('button',{name:'本地预览（不调用模型）'}).click()
  await panel.getByRole('alert').filter({hasText:'测试服务暂不可用'}).waitFor()
  await panel.getByRole('button',{name:'本地预览（不调用模型）'}).click()
  await panel.getByRole('checkbox').first().waitFor()
  assert.equal(calls.at(-1).body.scope,'group:2')
  if(!await panel.locator('[data-held]').evaluate(e=>e.open))await panel.getByText('保留待处理 1 条 · 展开查看原因',{exact:true}).click()
  await panel.getByLabel('选择：<img src=x onerror=alert(1)>').check()
  assert.equal(await panel.locator('[data-held]').evaluate(e=>e.open),true)
  await panel.getByRole('button',{name:'主动归档所选 1 条'}).click()
  await page.getByRole('button',{name:'取消',exact:true}).click()
  assert.equal(calls.filter(c=>c.api.endsWith('/apply')).length,1)
  await panel.getByRole('button',{name:'主动归档所选 1 条'}).click()
  await page.getByRole('button',{name:'确认归档所选记录',exact:true}).click()
  await panel.getByRole('status').filter({hasText:'已处理 1 条，跳过 0 条'}).waitFor()
  assert.equal(calls.filter(c=>c.api.endsWith('/apply')).length,2)
  await page.setViewportSize({width:390,height:844})
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2))
  assert.deepEqual(errors,[])
  console.log('PASS organizer UI: explicit free preview, selection, preserved ambiguity, no paid routes, skipped reasons, pagination, scope reset, retry, escaped text, mobile')
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
