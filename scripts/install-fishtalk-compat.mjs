// Optional adapter for the independently authored MIT fishtalk 0.3.6 plugin.
// Preserve the upstream package, all corpus/labels and an exact file backup.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
const digest=x=>createHash('sha256').update(x).digest('hex');
const policy=`# fishtalk 与心迹的表达参考

文风包是可选的表达参考，不是人格、身份、事实或情绪来源。先理解当前上下文，再决定是否参考；当前明确要求优先。不要模仿范例里的生日、出生、关系、昵称、责怪或撒娇态度。句长和语气词只是统计，不是配额。

不要求每轮调用 pack 或 check；已有相关参考时直接交流。check 只提示形式问题，不能判断是否理解用户，不要因为检查次数或相似度而停止回应。普通短语重复不必改写。不得为了显得像人而编造现实活动。

心迹自动文风学习由桥接批量处理，复用明确反馈识别，只在当前授权主人私聊范围学习，候选须经后续独立反馈支持。不要再调用 fishtalk_deep 重复整理这些私聊。私聊不能喂入公共参考库。旧私聊和人设语料仍存档，但不向聊天工具提供通用样例。

用户明确要求学习公共评论时可以 feed/learn；仅公共、来源明确的文字可作为通用参考。用户明确要求手动深度分析公共材料时可以 deep，结果不自动附加到每次 pack。不得自动扩大抓取范围。

查看语料用 fishtalk label；查看公共参考用 fishtalk pack；需要形式检查时使用 fishtalk check。只有确实发送成功才可记录 keep。删除语料需要用户明确授权。自动学习开关、候选与停用在心迹的心绪中枢“回应习惯”中管理。
`;
export function prepareFishtalk(root){
  const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
  if(pkg.name!=='fishtalk'||pkg.version!=='0.3.6')throw Error('仅支持已检查的 fishtalk 0.3.6，请先检查新版本');
  const names=['lib/distill.js','lib/deep.js','lib/check.js','fishtalk.js','lib/dsh/index.mjs','skills/fishtalk/SKILL.md','AGENT.md'];
  const updates=[];
  const replace=(s,a,b)=>{if(s.includes(b))return s;if(!s.includes(a))throw Error('fishtalk 源码已变化，停止覆盖');return s.replace(a,b);};
  for(const name of names){
    const file=path.join(root,name),before=fs.readFileSync(file,'utf8');let after=before.replaceAll('\r\n','\n');
    if(name==='lib/distill.js'){
      after=replace(after,'const items = store.all()',"const items = store.all().filter(require('./xinji-reference').isPublicSample)");
      // No cached private pack on empty safe corpus.
      after=replace(after,"try { return JSON.parse(fs.readFileSync(store.P.pack, 'utf8')) } catch { return { counts: { total: 0, human: 0, fish: 0, labeled: 0 }, empty: true } }","return { counts: { total: 0, human: 0, fish: 0, labeled: 0 }, empty: true }");
      after=replace(after,"L.push('> 给 agent：说话前读这一页；发之前用 `fishtalk check \"你要说的话\"` 过一遍。学的是味道，别照抄下面的原句。')","L.push('> 可选表达参考，不要求每轮读包或检查。不继承范例中的身份、事实、关系或态度；先理解当前上下文。')");
      after=replace(after,"L.push('> **在公开场合说话时，这一页压过你人设卡里的口癖**：动作括号、撒娇语气、固定自称、对主人的称呼，在评论区一律收起来。人设只留性格和立场。跟主人私聊不受这条管。')","L.push('> 当前对话和明确要求优先；这些只是公共语料的形式统计，不能代表某个用户的偏好。')");
      after=replace(after,'> 学的是味道，别照抄原句。发之前 `fishtalk check`。','> 可选公共表达参考，不能替代上下文理解；不继承身份、关系或情绪，不要求逐轮检查。');
    }
    if(name==='lib/deep.js')after=replace(after,'return store.all()\n',"return store.all().filter(require('./xinji-reference').isPublicSample)\n");
    if(name==='lib/check.js'){
      after=replace(after,'const items = store.all()',"const items = store.all().filter(require('./xinji-reference').isPublicSample)");
      after=replace(after,'const ns = opts.ignoreHistory ? { score: 0 } : nearest(t, store.said())','const ns = { score: 0 } // Legacy said has no trusted chat scope; never return another private conversation.');
    }
    if(name==='fishtalk.js'){
      const start=after.indexOf("    case 'pack': {"),end=after.indexOf("    case 'deep': {",start);
      if(start<0||end<0)throw Error('CLI pack入口未识别');
      after=after.slice(0,start)+"    case 'pack': {\n      const n = readN(3); if (n === null) break;\n      console.log(require('./lib/xinji-reference').read({scene:opt('--scene'),like:opt('--like'),n}));\n      break;\n    }\n"+after.slice(end);
    }
    if(name==='lib/dsh/index.mjs'){
      after=replace(after,"description: '读文风包：说话之前先读这个，照里面的语气、开头方式、说法说话（学味道，别照抄范例）。传 like 就改成找语料里跟这个话题/这条评论最像的真人发言；可能一条都找不到，会跳过原评论、标「弱相关」和来源，不硬凑。传 scenes 只列场合（名字、条数、有没有《打法》）。'","description: '按需读取公共表达参考，不必每轮调用；不能继承身份、事实、关系或情绪，不能替代当前上下文。私聊学习由心迹自动批量处理，此工具不返回私人语料。like 可找相关公共样例，scenes 可列可用场合。'");
      const start=after.indexOf('      async execute(args = {}) {');
      const end=after.indexOf('\n    },\n    {',start);
      if(start<0||end<0)throw Error('pack入口未识别');
      after=after.slice(0,start)+"      async execute(args = {}) {\n        return require('../xinji-reference').read(args);\n      },"+after.slice(end);
      after=replace(after,'发出去之前检查一句话：鱼八股原句、AI 腔、跟别的鱼太像、跟自己以前说的太像、照抄语料原句。只报问题，不改写。通过了且真的发出去了，keep 传 true 记下来。','按需检查形式上的套话、重复或照抄；不判断上下文和同理心，不要求逐轮调用，不因两次不通过而拒绝回应。确实发送后才可用 keep。');
      after=replace(after,'把你已经读到的真人发言（评论、弹幕、帖子、聊天）喂进来学，学完自动蒸馏。只喂本来就读到的，不要为了它专门去多抓。','按用户要求保存已读到的公共发言，不自动收集私聊，不把助手自己的输出冒充真人；私聊反馈由心迹按会话隔离学习。');
      after=replace(after,'说话像真人、别写鱼八股：说话前读文风包（可带场合、可找类似发言），发之前 check，读到真人发言顺手喂进来。','按需参考公共表达样例和检查形式问题；私聊的情境文风由心迹批量学习，不逐轮增加工具调用。');
    }
    if(name==='skills/fishtalk/SKILL.md')after='---\nname: fishtalk\ndescription: 可选公共表达参考与形式检查，私聊情境学习由心迹管理。\n---\n'+policy;
    if(name==='AGENT.md')after=policy;
    updates.push({file,before,after});
  }
  const helper=fs.readFileSync(new URL('./support/fishtalk-reference.cjs',import.meta.url),'utf8');
  const file=path.join(root,'lib/xinji-reference.js');updates.push({file,before:fs.existsSync(file)?fs.readFileSync(file,'utf8'):null,after:helper});
  return updates;
}
export function installFishtalk(root,apply=false){
  const updates=prepareFishtalk(root).filter(r=>r.before!==r.after);
  if(!apply||!updates.length)return {status:updates.length?'ready':'already-installed',files:updates.map(r=>path.relative(root,r.file))};
  const backup=path.join(root,'.xinji-backups',String(Date.now()));fs.mkdirSync(backup,{recursive:true});
  const manifest=updates.map((r,i)=>({file:r.file,beforeHash:r.before===null?null:digest(r.before),afterHash:digest(r.after),backup:r.before===null?null:path.join(backup,String(i)+'.bak')}));
  for(let i=0;i<updates.length;i++)if(manifest[i].backup)fs.writeFileSync(manifest[i].backup,updates[i].before);
  fs.writeFileSync(path.join(backup,'manifest.json'),JSON.stringify(manifest,null,2));
  try{
    for(const r of updates){if(r.before!==null&&fs.readFileSync(r.file,'utf8')!==r.before)throw Error('file changed');fs.writeFileSync(r.file,r.after);}
    for(const r of updates.filter(r=>/\.(?:m?js)$/.test(r.file))){const result=spawnSync(process.execPath,['--check',r.file],{windowsHide:true,encoding:'utf8'});if(result.status!==0)throw Error('适配语法检查失败');}
  }catch(e){for(let i=0;i<updates.length;i++){if(manifest[i].backup)fs.copyFileSync(manifest[i].backup,updates[i].file);else if(fs.existsSync(updates[i].file))fs.unlinkSync(updates[i].file);}throw e;}
  return {status:'installed',backup,files:manifest.map(r=>r.file),restartRequired:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const i=process.argv.indexOf('--target');if(i<0||!process.argv[i+1])throw Error('Use --target <fishtalk directory> [--apply]');
  console.log(JSON.stringify(installFishtalk(path.resolve(process.argv[i+1]),process.argv.includes('--apply'))));
}
