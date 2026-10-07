import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {auditPublicFiles} from './public-files.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'scripts/release-manifest.json'),'utf8'));
const [extension,local]=process.argv.slice(2);
if(!extension||!local)throw Error('Usage: check-artifacts.mjs extracted-extension extracted-local-service');
const walk=(base,relative='')=>fs.readdirSync(path.join(base,relative),{withFileTypes:true}).flatMap(entry=>{
    const child=(relative?relative+'/':'')+entry.name;
    if(entry.isSymbolicLink())throw Error('Archive symlink: '+child);
    return entry.isDirectory()?walk(base,child):[child];
});
for(const [base,expected] of [[extension,manifest.extensionFiles],[local,manifest.localServiceFiles]]){
    const actual=walk(base).sort();
    if(JSON.stringify(actual)!==JSON.stringify([...expected].sort()))throw Error('Archive manifest differs from the reviewed file list');
    const issues=auditPublicFiles(base,actual);
    if(issues.length){for(const issue of issues)console.error(issue.file+': '+issue.risk);process.exit(1);}
}
for(const file of manifest.extensionFiles.filter(f=>f.endsWith('.js'))){
    const content=fs.readFileSync(path.join(extension,file),'utf8');
    for(const match of content.matchAll(/from\s+['"](\.[^'"]+)['"]/g)){
        const target=path.resolve(path.dirname(path.join(extension,file)),match[1]);
        if(target.startsWith(path.resolve(extension)+path.sep)&&!fs.existsSync(target))throw Error(file+': missing packaged import');
    }
}
const index=fs.readFileSync(path.join(extension,'index.js'),'utf8');
if(!/llmFallbackEnabled:\s*false/.test(index))throw Error('Local fallback must default to off');
if(!/qwenSceneDetail:\s*false/.test(index))throw Error('Clear drawing must default to off');
console.log('OK: extracted ZIPs match manifests; imports, defaults and public-file audit passed.');
