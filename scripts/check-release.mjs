// Read-only package/document guard. Never reads a user's DSH data directory.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const errors=[];
const required=['README.md','INSTALL.md','manual/USER_GUIDE.md','docs/TECHNICAL_MANUAL.md','DISCLAIMER.md','ACKNOWLEDGEMENTS.md','UPGRADE.md','CHANGELOG.md'];
for(const rel of required)if(!fs.existsSync(path.join(root,rel)))errors.push('Missing document: '+rel);
for(const id of ['shiguang','lunkuo','chaoxi','yuyin','huilang','five-way-linkage'])if(!fs.existsSync(path.join(root,'docs/images',id+'.png')))errors.push('Missing figure: '+id);
const markdown=[];
for(const dir of ['','docs','manual','memvec'])for(const f of fs.readdirSync(path.join(root,dir)))if(f.endsWith('.md'))markdown.push(path.join(dir,f));
for(const rel of markdown){const source=fs.readFileSync(path.join(root,rel),'utf8');for(const m of source.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)){
 const target=m[1].split(/\s+"/)[0].replace(/^<|>$/g,'').split('#')[0];
 if(!target||/^[a-z][\w+.-]*:/i.test(target)||target.startsWith('//'))continue;
 const resolved=path.resolve(root,path.dirname(rel),decodeURIComponent(target));
 if(!resolved.startsWith(root+path.sep)||!fs.existsSync(resolved))errors.push('Broken link: '+rel+' -> '+target);
}}
// npm's own file list is authoritative; --ignore-scripts prevents prepack recursion.
const command=process.platform==='win32'?(process.env.ComSpec||'cmd.exe'):'npm';
const args=process.platform==='win32'?['/d','/s','/c','npm pack --dry-run --ignore-scripts --json']:['pack','--dry-run','--ignore-scripts','--json'];
const run=spawnSync(command,args,{cwd:root,encoding:'utf8',windowsHide:true,timeout:60000});
if(run.status!==0)errors.push('npm dry-run failed');
let files=[];
try{files=JSON.parse(run.stdout)[0].files.map(x=>x.path)}catch{errors.push('npm dry-run output invalid')}
const forbidden=/(^|\/)(?:state|private-evaluation|node_modules|hfcache|\.venv|\.git)(\/|$)|docs\/eval\/|(?:\.db(?:-wal|-shm)?|\.log|\.tgz|\.bak)$|(?:^|\/)(?:config\.json|console-token|api-token|bili_credential\.json|eval-snapshot\.json|eval-fixture\.json|eval-injectable\.json)$/i;
for(const rel of files)if(forbidden.test(rel))errors.push('Forbidden package path: '+rel);
for(const rel of required)if(!files.includes(rel))errors.push('Document omitted from package: '+rel);
const identity=fs.readFileSync(path.join(root,'bridge/xinji-identity.mjs'),'utf8');
const installer=fs.readFileSync(path.join(root,'bridge/install-runtime-bundle.mjs'),'utf8');
if(!identity.includes(`runtimeVersion: '${pkg.version}'`)||!installer.includes(`RUNTIME_VERSION = "${pkg.version}"`))errors.push('Runtime versions differ from package');
if(errors.length){console.error(errors.join('\n'));process.exitCode=1}
else console.log(JSON.stringify({ok:true,version:pkg.version,packageFiles:files.length,documentsChecked:markdown.length,figures:6,privateRuntimePaths:0}));
