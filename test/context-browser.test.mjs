// Isolated context-page regression. No connection to QQ or the user's console.
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url),
  { chromium } = require(process.env.FEIYU_PLAYWRIGHT_PATH || "playwright");
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../web",
);
const key = "private:10001",
  feedback = [],
  errors = [];
const row = {
  id: "memory-1",
  scope: key,
  kind: "associated",
  subjectId: "10001",
  text: "我喜欢意面 <img src=x onerror=alert(1)>",
  reasons: ["一跳关联", "同主体事实"],
  score: 0.5,
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost"),
    route = url.pathname.replace("/console", "");
  if (route.startsWith("/api/")) {
    let data = { ok: true };
    if (route === "/api/version") data.version = "0.9.0";
    if (route === "/api/context/keys") data.keys = [{ key, label: "测试聊天" }];
    if (route === "/api/context")
      data = { ...data, stats: {messages:2,summaries:1}, config: {}, messages: [
        {id:'demo1',at:Date.now()-10000,sender:'测试用户',text:'明天要面试，我想先确认一下路线。',is_self:0},
        {id:'demo2',at:Date.now(),sender:'角色',text:'好，我们先看看地址和出发时间，再留一点缓冲。',is_self:1}
      ], summaries: [{id:'s1',period_start:Date.now()-3600000,period_end:Date.now()-1800000,text:'测试用户计划明天面试，正在确认出行路线。面试结果尚未发生。',structured:JSON.stringify({topics:['面试准备'],open_loops:['确认出发时间'],tone:'平和'})}] };
    if (route === "/api/context/traces")
      data.traces = [
        {
          traceId: "trace-1",
          key,
          at: Date.now(),
          query: "你记得我喜欢什么吗",
          reason: "ok",
          injected: [row],
          candidates: [row],
          reply: { status: "partial", sent: 2, turnId: "turn-3" },
        },
      ];
    if (route === "/api/action") {
      let body = "";
      for await (const chunk of req) body += chunk;
      feedback.push(JSON.parse(body));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
    return;
  }
  const name = path.basename(route),
    file = path.join(root, name);
  if (
    !fs.existsSync(file) ||
    !["context.html", "context.js", "app.css", "refinement.css", "context.css", "favicon.svg"].includes(name)
  ) {
    res.writeHead(404);
    res.end();
    return;
  }
  res.setHeader(
    "content-type",
    name.endsWith(".js")
      ? "text/javascript"
      : name.endsWith(".css")
        ? "text/css"
        : name.endsWith(".svg")
          ? "image/svg+xml"
          : "text/html",
  );
  res.end(fs.readFileSync(file));
});
let browser;
try {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FEIYU_BROWSER_CHANNEL
      ? { channel: process.env.FEIYU_BROWSER_CHANNEL }
      : {}),
  });
  const page = await browser.newPage({
    viewport: { width: 1365, height: 1000 },
  });
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", () => errors.push("unexpected dialog"));
  await page.goto(
    `http://127.0.0.1:${server.address().port}/console/context.html`,
  );
  await page.locator("#app-version").filter({ hasText: "v0.9.0" }).waitFor();
  await page.locator("#traces summary").click();
  await page.getByText(/回复：部分发送/).waitFor();
  await page.getByText(/主体 10001/).waitFor();
  assert.equal(await page.locator("#traces img").count(), 0);
  assert.equal(
    await page
      .locator("#traces")
      .textContent()
      .then((t) => t.includes("[object Object]")),
    false,
  );
  await page.getByRole("button", { name: "本轮不相关" }).click();
  await page.getByText("已记录本轮反馈，记忆保持原样").waitFor();
  assert.deepEqual(feedback, [
    { op: "irrelevant", id: row.id, scope: key, key, traceId: "trace-1" },
  ]);
  await page.getByRole('region',{name:'上下文与记忆的关系'}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  await page.setViewportSize({width:1365,height:1000});
  assert.deepEqual(errors, []);
  if (process.env.FEIYU_SCREENSHOT)
    await page.screenshot({
      path: process.env.FEIYU_SCREENSHOT,
      fullPage: true,
    });
  await page.evaluate(()=>{localStorage.setItem('feiyu-theme','light')});await page.reload();await page.locator('#summaries .ctx-summary').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
  if(process.env.FEIYU_SCREENSHOT)await page.screenshot({path:process.env.FEIYU_SCREENSHOT.replace('dark.png','light.png'),fullPage:true});
  console.log(
    "context browser OK: mounted route, actual rows, attribution, reply status, escaped text and trace-bound feedback",
  );
} finally {
  if (browser) await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}
