// Execute the adapter's real authentication/Host/CSRF gates in an isolated HTTP
// fixture; replace only business handlers and state. Never touch live QQ/config.
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const html=fs.readFileSync(new URL('../bridge/xinji-console.html',import.meta.url),'utf8');
const start=source.indexOf('const server = http.createServer(async (req, res) => {')+'const server = http.createServer('.length;
const end=source.indexOf("        if (req.method === 'POST' && url.pathname === '/api/memory/confirmation-review')",start);
assert.ok(start>0&&end>start);
const context={URL,Buffer,crypto,path,port:0,ROOT:'/fixture',consoleToken:'fixture-token-one-1234',socialV2:{},cfg:{},currentMode:'reserved2',isLiveAgentToken:()=>false,fs:{readFileSync:()=>html}};
const handler=vm.runInNewContext('('+source.slice(start,end)+`
 sendJson({ok:true,dshReady:true,runtimeVersion:'auth-fixture',allow:{groups:[],private:[]},sessions:[],pending:[],presets:[],config:{},security:{},voices:[],entries:[],items:[],logs:[]});
 } catch(e){sendJson({ok:false,error:e.message},500)}
})`,context);
const server=http.createServer(handler);context.server=server;
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base=`http://127.0.0.1:${server.address().port}`;
 assert.equal((await fetch(base+'/')).status,200);
 for(const route of ['/api/status','/api/preset/sim-prompt','/anything'])assert.equal((await fetch(base+route)).status,401);
 assert.equal((await fetch(base+'/api/whitelist',{method:'POST',headers:{'content-type':'application/json'},body:'{}'})).status,401);
 assert.equal(await new Promise((resolve,reject)=>{http.get(base+'/',{headers:{host:'evil.example'}},res=>{res.resume();resolve(res.statusCode)}).on('error',reject)}),403);
 assert.equal((await fetch(base+'/api/whitelist',{method:'POST',headers:{'x-console-token':context.consoleToken,'content-type':'application/json',origin:'https://evil.example'},body:'{}'})).status,403);
 assert.equal((await fetch(base+'/api/status',{headers:{'x-console-token':context.consoleToken,'x-agent-call':'1'}})).status,403);
 browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
 const session=await browser.newContext(),page=await session.newPage();
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/#overview');await page.locator('#consoleLoginDialog').waitFor();
 assert.equal(await page.locator('dialog[open]').count(),1);
 await page.locator('#consoleLoginToken').fill('incorrect');await page.locator('#consoleLoginDialog [type=submit]').click();
 await page.locator('#consoleLoginError').filter({hasText:'令牌不正确'}).waitFor();
 assert.equal(await page.evaluate(()=>localStorage.getItem('consoleToken')),null);
 await page.locator('#consoleLoginToken').fill(context.consoleToken);await page.locator('#consoleLoginDialog [type=submit]').click();
 await page.locator('#consoleLoginDialog').waitFor({state:'detached'});
 await page.locator('#statusText').filter({hasText:'DSH 已连接'}).waitFor();
 await page.reload();await page.locator('#runtimeVersion').filter({hasText:'auth-fixture'}).waitFor();
 assert.equal(await page.locator('#consoleLoginDialog').count(),0);
 const reopened=await session.newPage();await reopened.goto(base+'/#access');await reopened.locator('#runtimeVersion').filter({hasText:'auth-fixture'}).waitFor();
 assert.equal(await reopened.locator('#consoleLoginDialog').count(),0);await reopened.close();
 context.consoleToken='fixture-token-rotated-5678';
 await page.evaluate(()=>{window.authRequests=Promise.allSettled(Array.from({length:12},()=>api('/api/status')))});
 await page.locator('#consoleLoginDialog').waitFor();assert.equal(await page.locator('dialog[open]').count(),1);
 await page.locator('#consoleLoginCancel').click();
 assert.ok((await page.evaluate(()=>window.authRequests)).every(r=>r.status==='rejected'));
 await page.evaluate(()=>Promise.allSettled([api('/api/status'),api('/api/status')]));
 assert.equal(await page.locator('#consoleLoginDialog').count(),0);
 await page.locator('#consoleLoginButton').click();await page.locator('#consoleLoginToken').fill(context.consoleToken);await page.locator('#consoleLoginDialog [type=submit]').click();
 await page.locator('#runtimeVersion').filter({hasText:'auth-fixture'}).waitFor();
 await page.waitForFunction(()=>localStorage.getItem('consoleToken')==='fixture-token-rotated-5678');
 await page.goto(base+'/?token='+context.consoleToken+'#persona');
 await page.waitForFunction(()=>!location.search);assert.equal(new URL(page.url()).hash,'#persona');
 assert.deepEqual(errors,[]);
 console.log('Auth passed: real server gates, first login, invalid token, header-free reload/new tab, 12 concurrent 401s, cancel/reopen, rotation, URL cleanup; no live state.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
