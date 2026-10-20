import { build } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const out=path.join(root,'.tmp/uiux-prototype-build');
await build({configFile:false,root:path.join(root,'prototypes/workbench'),publicDir:false,plugins:[react()],build:{outDir:out,emptyOutDir:true,cssCodeSplit:false,rollupOptions:{output:{inlineDynamicImports:true}}}});
const files=fs.readdirSync(path.join(out,'assets'));
const js=files.filter(f=>f.endsWith('.js')).map(f=>fs.readFileSync(path.join(out,'assets',f),'utf8')).join('\n');
// System font fallback keeps the comparison self-contained without font assets.
const css=files.filter(f=>f.endsWith('.css')).map(f=>fs.readFileSync(path.join(out,'assets',f),'utf8')).join('\n').replace(/@font-face\s*\{[^}]*\}/g,'');
const target=path.resolve(root,'../docs/prototypes/uiux-20261020/workbench.html');
fs.mkdirSync(path.dirname(target),{recursive:true});
fs.writeFileSync(target,`<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'"><title>绘世 PC · 工作台对比原型</title><style>${css.replace(/<\/style/gi,'<\\/style')}</style></head><body><div id="root"></div><script type="module">${js.replace(/<\/script/gi,'<\\/script')}</script></body></html>`);
console.log(JSON.stringify({target,bytes:fs.statSync(target).size,network:'CSP connect-src none; no business IPC',components:['Button','SelectMenu','CommittedNumberInput','EffortControl','ResolutionPicker']}));
