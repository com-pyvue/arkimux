import {build} from 'esbuild';
import {build as viteBuild} from 'vite';
import {readdir,readFile,mkdir,copyFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.dirname(fileURLToPath(import.meta.url));
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){if(['node_modules','dist'].includes(e.name))continue;const p=path.join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else if(e.name==='package.json')out.push(p);}return out;}
for(const file of await walk(path.join(root,'packages'))){const dir=path.dirname(file);const p=JSON.parse(await readFile(file,'utf8'));const entry=path.join(dir,'src',p.name.endsWith('workflow-development-web')?'index.tsx':'index.ts');
await mkdir(path.join(dir,'dist'),{recursive:true});
await build({entryPoints:[entry],outfile:path.join(dir,'dist/index.js'),bundle:true,packages:'external',platform:p.name.includes('-react')||p.name.endsWith('-ui')||p.name.endsWith('result-presentation')||p.name.endsWith('workflow-development-web')?'browser':'node',format:'esm',target:'node24',loader:{'.css':'empty'}});
if(p.name.endsWith('workflow-development-web')){await copyFile(path.join(dir,'src/public.d.ts'),path.join(dir,'dist/index.d.ts'));await copyFile(path.join(dir,'src/styles.css'),path.join(dir,'dist/styles.css'));}}
await mkdir(path.join(root,'packages/ui/dist'),{recursive:true});await copyFile(path.join(root,'packages/ui/src/styles/theme.css'),path.join(root,'packages/ui/dist/theme.css'));
for(const [out,entry]of [['local-filesystem-server.js','runLocalFilesystemServer.ts'],['bootstrap-local-operator.js','bootstrapLocalOperator.ts'],['benchmark-local-run-queries.js','benchmarkLocalRunQueries.ts']])await build({entryPoints:[path.join(root,'hosts/api/src',entry)],outfile:path.join(root,'dist/hosts/api',out),bundle:true,packages:'bundle',platform:'node',format:'esm',target:'node24'});
await viteBuild({configFile:path.join(root,'hosts/web/vite.config.ts')});
