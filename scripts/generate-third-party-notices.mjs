// Generate source-review notices from the pinned lockfile and installed licence files.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const lock=JSON.parse(fs.readFileSync(path.join(root,'package-lock.json'),'utf8'));
const records=[];
for(const [location,entry]of Object.entries(lock.packages)){
  if(!location.includes('node_modules/')||entry.link)continue;
  const directory=path.join(root,location);
  let manifest;try{manifest=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8'));}catch{}
  const name=manifest?.name??location.slice(location.lastIndexOf('node_modules/')+'node_modules/'.length);
  const version=entry.version;
  const declaredLicense=manifest?.license??entry.license??'UNKNOWN';
  const licences=[];
  if(manifest)for(const file of fs.readdirSync(directory)){
    if(!/^(?:licen[cs]e|copying|notice|copyright)(?:[.-]|$)/i.test(file))continue;
    const source=path.join(directory,file);if(!fs.statSync(source).isFile())continue;
    const bytes=fs.readFileSync(source),relative=`licenses/third-party/${name.replace(/^@/,'').replaceAll('/','--')}@${version}/${file}`;
    const destination=path.join(root,relative);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.copyFileSync(source,destination);
    licences.push({path:relative,sha256:createHash('sha256').update(bytes).digest('hex')});
  }
  records.push({name,version,declaredLicense,packageUrl:entry.resolved,licenceFiles:licences});
}
records.sort((a,b)=>a.name.localeCompare(b.name)||a.version.localeCompare(b.version));
fs.mkdirSync(path.join(root,'licenses'),{recursive:true});
fs.writeFileSync(path.join(root,'licenses/dependency-inventory.json'),JSON.stringify({scope:'Public source workspace lockfile, including build/test and optional platform dependencies. Not a per-artifact legal approval.',lockfileSha256:createHash('sha256').update(fs.readFileSync(path.join(root,'package-lock.json'))).digest('hex'),packages:records},null,2)+'\n');
const escape=value=>String(value).replaceAll('|','\\|');
const header=`# Third party notices\n\nArkiMux-authored source uses Apache-2.0 unless stated otherwise. Dependencies retain their own licences and copyright notices; they are not relicensed by ArkiMux.\n\nThis inventory comes from the checked-in npm lockfile and includes development, test and optional platform packages, not just code shipped in an artifact. Licence texts present in installed packages are preserved under \`licenses/third-party/\`. Platform-specific packages not installed on this machine retain the licence declaration from the lockfile and the exact package URL in [the machine-readable inventory](licenses/dependency-inventory.json).\n\nThis source review is not a per-package redistribution or legal approval. Before a binary or npm release, verify the exact bundled dependency closure and carry its required notices and source availability information. In particular, the lockfile includes EPL-2.0-or-GPL-3.0-or-later \`elkjs\`, MPL-2.0 components and CC-BY-4.0 data; their own terms remain applicable.\n\nRegenerate with Node.js 24 or newer after \`npm ci\`:\n\n\`\`\`sh\nnode scripts/generate-third-party-notices.mjs\n\`\`\`\n\n| Package | Version | Declared licence | Included notices |\n| --- | --- | --- | --- |\n`;
fs.writeFileSync(path.join(root,'THIRD_PARTY_NOTICES.md'),header+records.map(pkg=>`| ${escape(pkg.name)} | ${escape(pkg.version)} | ${escape(typeof pkg.declaredLicense==='string'?pkg.declaredLicense:JSON.stringify(pkg.declaredLicense))} | ${pkg.licenceFiles.map(file=>`[${path.basename(file.path)}](${file.path})`).join(', ')||'Exact package URL in inventory'} |`).join('\n')+'\n');
console.log(JSON.stringify({packages:records.length,licenceFiles:records.reduce((sum,pkg)=>sum+pkg.licenceFiles.length,0),unknown:records.filter(pkg=>pkg.declaredLicense==='UNKNOWN').map(pkg=>pkg.name)}));
