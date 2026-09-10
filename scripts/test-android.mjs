import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {connect} from './android-cdp.mjs';
const root=fileURLToPath(new URL('../src/', import.meta.url));const cache=new Map();
async function moduleUrl(name){
    if(cache.has(name))return cache.get(name);
    let source=await fs.readFile(path.join(root,name),'utf8');
    if(name==='gallery.js')source=source.replace("const REFS_DB_NAME = 'rpig-refs'", "const REFS_DB_NAME = 'rpig-regression-test'");
    for(const match of [...source.matchAll(/from '(\.\/[^']+)'/g)])source=source.replace(match[0],`from '${await moduleUrl(match[1].slice(2))}'`);
    const url='data:text/javascript;base64,'+Buffer.from(source).toString('base64');cache.set(name,url);return url;
}
const urls={};for(const name of ['floating-ui.js','backends.js','utils.js','gallery.js','llm.js'])urls[name]=await moduleUrl(name);
const c=await connect();const network=[];
c.listeners.push(m=>{if(m.method==='Network.loadingFailed')network.push({error:m.params.errorText,cors:m.params.corsErrorStatus,blockedReason:m.params.blockedReason})});
await c.send('Network.enable');
const expression=`(async()=>{
const urls=${JSON.stringify(urls)};const ui=await import(urls['floating-ui.js']);const backend=await import(urls['backends.js']);const util=await import(urls['utils.js']);const gallery=await import(urls['gallery.js']);const llm=await import(urls['llm.js']);
const outcomes=[];const check=async(name,fn)=>{try{const detail=await fn();outcomes.push({name,pass:true,detail})}catch(e){outcomes.push({name,pass:false,error:e.message})}};
const expect=(condition,message)=>{if(!condition)throw new Error(message)};
const failure=async(fn,code)=>{try{await fn()}catch(e){expect(e.code===code,'expected '+code+', got '+e.code);return e.code}throw new Error('expected failure '+code)};
const base='http://127.0.0.1:18765';const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
const s={backend:'openai',backendModel:'fixture',backendKey:'fixture-not-a-real-key'};
await check('real DOM transformed-root FAB placement',async()=>{const fab=document.querySelector('.rpig-fab');const panel=document.querySelector('.rpig-fab-panel');window.rpigFloatingCleanup?.();window.rpigFloatingCleanup=ui.keepFloatingUIVisible(fab,panel);const r=fab.getBoundingClientRect();expect(r.top>=0&&r.bottom<=visualViewport.height,'FAB outside visible viewport');expect(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===fab,'FAB not hittable');return r.toJSON()});
await check('real multipart edits success',async()=>{const r=await backend.generateOpenAIImage({...s,backendUrl:base+'/200'},'fixture','1024x1024',[{dataUrl:png}]);expect(r.usedRefs===true,'not edits');return {usedRefs:r.usedRefs}});
for(const [status,code] of [[404,'EDITS_NOT_FOUND'],[405,'EDITS_UNSUPPORTED'],[500,'EDITS_HTTP']])await check('real edits HTTP '+status,()=>failure(()=>backend.generateOpenAIImage({...s,backendUrl:base+'/'+status},'fixture','1024x1024',[{dataUrl:png}]),code));
await check('real browser CORS denial stays network-unknown',()=>failure(()=>backend.generateOpenAIImage({...s,backendUrl:base+'/cors-denied'},'fixture','1024x1024',[{dataUrl:png}]),'NETWORK_FAILED'));
await check('real independent LLM CORS denial',()=>failure(()=>llm.callLLM('fixture','fixture',{llmSource:'custom',llmUrl:base+'/cors-denied',llmModel:'fixture',llmKey:'fixture'}),'NETWORK_FAILED'));
await check('real image download and hydration',async()=>{const refs=await backend.hydrateReferenceImages([{url:base+'/reference.png'}]);expect(refs[0].dataUrl.startsWith('data:image/png;base64,'),'no bytes');return {count:refs.length}});
await check('real missing reference HTTP 410',()=>failure(()=>backend.hydrateReferenceImages([{url:base+'/expired.png'}]),'REFERENCE_DOWNLOAD_FAILED'));
await check('real temporary output download HTTP 410',()=>failure(()=>gallery.persistMediaUrl(base+'/expired.png','fixture',{fetchToDataUrl:util.fetchToDataUrl,saveBase64AsFile:()=>{throw new Error('should not save')}}),'TEMP_IMAGE_DOWNLOAD_FAILED'));
await check('native Android IndexedDB write and read',async()=>{await gallery.saveCharacterRefs('fixture',[{dataUrl:png,label:'fixture'}]);const refs=await gallery.getCharacterRefs('fixture');expect(refs.length===1&&refs[0].dataUrl===png,'IDB roundtrip failed');return {count:refs.length}});
await new Promise((resolve,reject)=>{const r=indexedDB.deleteDatabase('rpig-regression-test');r.onsuccess=resolve;r.onerror=()=>reject(r.error)});
return {ua:navigator.userAgent,outcomes};})()`;
const result=await c.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});
const report={result:result.result.value||result,network};await fs.writeFile((process.env.RPIG_ANDROID_REPORT || 'android-test-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));c.ws.close();
if(report.result.outcomes?.some(o=>!o.pass)||!report.result.outcomes)process.exitCode=1;
