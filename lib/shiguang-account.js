import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import QRCode from './qr/index.js';
const passport='https://passport.bilibili.com/x/passport-login/web/qrcode/';
async function request(url,cookie){
 const r=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(9000),headers:{'user-agent':'Mozilla/5.0',referer:'https://www.bilibili.com/',...(cookie?{cookie}:{})}});
 if(!r.ok)throw Error('B 站暂时无法连接');
 return r.json();
}
function cookie(c){return ['SESSDATA','bili_jct','DedeUserID'].map((k,i)=>{
 const s=String(c[['sessdata','bili_jct','dedeuserid'][i]]??'');
 if(!s||/[;\r\n]/.test(s))throw Error('本地登录信息无效');
 return k+'='+s;
}).join('; ');}
function read(file){try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch(e){if(e.code==='ENOENT')return null;throw Error('无法读取拾光凭据');}}
function qrSvg(value){
 const qr=new QRCode(-1,1);qr.addData(value);qr.make();const n=qr.getModuleCount();let d='';
 for(let y=0;y<n;y++)for(let x=0;x<n;x++)if(qr.isDark(y,x))d+='M'+(x+4)+' '+(y+4)+'h1v1h-1z';
 return 'data:image/svg+xml;base64,'+Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+(n+8)+' '+(n+8)+'" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="white"/><path d="'+d+'"/></svg>').toString('base64');
}
export function accountManager(get=request){
 let session=null,busy=false;
 return async function account(file,op,id){
  if(busy)throw Error('账号操作正在进行，请稍后重试');
  busy=true;
  try{
   if(op==='status'){
    const old=read(file);if(!old)return {status:'signed-out'};
    const r=await get('https://api.bilibili.com/x/web-interface/nav',cookie(old));
    if(r.code===-101||r.data?.isLogin===false)return {status:'signed-out'};
    if(r.code!==0||!r.data?.isLogin||String(r.data.mid)!==String(old.dedeuserid))throw Error('暂时无法验证当前账号');
    return {status:'signed-in',name:r.data.uname,uid:String(r.data.mid)};
   }
   if(op==='start'){
    const r=await get(passport+'generate');if(r.code!==0)throw Error('二维码生成失败');
    const u=new URL(r.data.url);
    if(u.protocol!=='https:'||!['passport.bilibili.com','account.bilibili.com'].includes(u.hostname)||!r.data.qrcode_key)throw Error('二维码来源无效');
    session={id:randomUUID(),key:r.data.qrcode_key,until:Date.now()+180000,file};
    return {id:session.id,qr:qrSvg(u.href),status:'waiting'};
   }
   if(!session||id!==session.id||file!==session.file||Date.now()>=session.until)return {status:'expired'};
   if(op==='cancel'){session=null;return {status:'cancelled'};}
   if(op!=='poll')throw Error('未知账号操作');
   const r=await get(passport+'poll?qrcode_key='+encodeURIComponent(session.key));
   if(r.code!==0)throw Error('查询扫码状态失败');
   const d=r.data;if(d.code===86101)return {status:'waiting'};if(d.code===86090)return {status:'scanned'};
   if(d.code===86038){session=null;return {status:'expired'};}
   if(d.code!==0)throw Error('B 站未确认登录');
   session=null;
   const fields=Object.fromEntries(new URL(d.url).search.slice(1).split('&').map(s=>{const i=s.indexOf('=');return [s.slice(0,i),s.slice(i+1)]}));
   const c={sessdata:fields.SESSDATA,bili_jct:fields.bili_jct,dedeuserid:fields.DedeUserID};
   const old=read(file);if(!/^\d+$/.test(c.dedeuserid)||old&&String(old.dedeuserid)!==c.dedeuserid)throw Error('请使用拾光原先绑定的 B 站账号扫码');
   const nav=await get('https://api.bilibili.com/x/web-interface/nav',cookie(c));
   if(nav.code!==0||!nav.data?.isLogin||String(nav.data.mid)!==c.dedeuserid)throw Error('新登录身份核验失败');
   fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
   const tmp=file+'.'+randomUUID()+'.tmp';
   try{fs.writeFileSync(tmp,JSON.stringify(c),{flag:'wx',mode:0o600});fs.renameSync(tmp,file);}finally{fs.rmSync(tmp,{force:true});}
   return {status:'signed-in',uid:c.dedeuserid,name:nav.data.uname};
  }finally{busy=false;}
 };
}
export const shiguangAccount=accountManager();
