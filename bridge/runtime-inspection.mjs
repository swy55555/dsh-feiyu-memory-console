import fs from 'node:fs';
import path from 'node:path';
import {isBuiltin} from 'node:module';
import {spawnSync} from 'node:child_process';

// Read source only: checking must not load config, acquire locks or start services.
export function inspectClosure(directory, {dependencies = false, sourceLayout = false} = {}) {
  const root = path.resolve(directory), missing = new Set(), packages = new Set(), visited = new Set();
  const aliases = sourceLayout ? {'human-context.mjs': 'human-context-v09.mjs'} : {};
  function visit(file) {
    const relative = path.relative(root, file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) { missing.add('outside-runtime: ' + relative); return; }
    if (visited.has(file)) return;
    visited.add(file);
    if (!fs.existsSync(file)) { missing.add(relative); return; }
    if (!/\.(?:m?js|cjs)$/.test(file)) return;
    const source = fs.readFileSync(file, 'utf8');
    const specs = new Set();
    for (const pattern of [/^\s*(?:import|export)\s+(?:[^;]*?\s+from\s*)?['"]([^'"\r\n]+)['"]/gm, /\b(?:import|require)\(\s*['"]([^'"\r\n]+)['"]\s*\)/g]) {
      for (const match of source.matchAll(pattern)) specs.add(match[1]);
    }
    for (const spec of specs) {
      if (isBuiltin(spec)) continue;
      if (spec.startsWith('.')) {
        let target = path.resolve(path.dirname(file), spec);
        const local = path.relative(root, target);
        if (aliases[local]) target = path.join(root, aliases[local]);
        visit(target);
      } else if (dependencies) {
        packages.add(spec);
      }
    }
  }
  for (const entry of ['bridge-v09.js', 'mcp-snowluma-safe.js', 'mcp-host-server.js', 'mcp-web-search-safe.js']) visit(path.join(root, entry));
  if (dependencies && packages.size) {
    // ESM-only packages may deliberately have no CommonJS/require export.
    const check = spawnSync(process.execPath, ['--input-type=module', '-e', 'import fs from "node:fs"; import {fileURLToPath} from "node:url"; const missing=JSON.parse(process.argv[1]).filter(spec=>{try{return !fs.existsSync(fileURLToPath(import.meta.resolve(spec)))}catch{return true}});console.log(JSON.stringify(missing));', JSON.stringify([...packages])], {cwd: root, encoding: 'utf8', windowsHide: true, timeout: 15000});
    if (check.status === 0) { const unresolved = JSON.parse(check.stdout); packages.clear(); for (const name of unresolved) packages.add(name); }
  }
  return {ok: missing.size === 0 && packages.size === 0, missing: [...missing].sort(), missingPackages: [...packages].sort(), checkedFiles: visited.size, dependenciesChecked: dependencies};
}
