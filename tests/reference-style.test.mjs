import test from 'node:test';
import assert from 'node:assert/strict';
import {buildDirectorPrompt,buildOmniscientPrompt,buildFinalizerPrompt} from '../src/prompts.js';
import {generateImage} from '../src/backends.js';
const settings={backend:'openai',backendUrl:'https://fixture.test/v1',backendModel:'gpt-image-1',stylePreset:'reference'};
const refs=[{dataUrl:'data:image/png;base64,YWJj',kind:'identity-primary'},{dataUrl:'data:image/png;base64,ZGVm',kind:'identity-secondary'}];
for(const build of [buildDirectorPrompt,buildOmniscientPrompt,buildFinalizerPrompt])test(`${build.name} uses story-only editing instructions`,()=>{
 const p=build({stylePreset:'reference',currentMessageText:'She sits by the window.',promptFormat:'tags'});
 assert.match(p.system,/你没有看到这些图片/);assert.match(p.system,/只总结最新剧情/);
 assert.doesNotMatch(p.system,/photorealistic|35mm film|masterpiece|电影质感/);
 assert.match(p.userText,/She sits by the window/);
});
test('reference mode rejects missing identity input before any network call',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected fetch')});
 await assert.rejects(generateImage(settings,'action','',[]),{code:'REFERENCE_REQUIRED'});
 await assert.rejects(generateImage(settings,'action','',[{...refs[0],kind:'continuity'}]),{code:'REFERENCE_REQUIRED'});assert.equal(calls,0);
});
test('reference mode sends uploaded images together to edits and locks visual style',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({data:[{b64_json:'YWJj'}]}),{status:200});});
 const result=await generateImage(settings,'Have the character sit by the window.','',refs);
 assert.equal(calls.length,1);assert.ok(calls[0].url.endsWith('/images/edits'));
 const form=calls[0].options.body;assert.equal(form.getAll('image[]').length,2);
 assert.match(form.get('prompt'),/identity AND visual style/);assert.match(form.get('prompt'),/sit by the window/);assert.equal(result.usedRefs,true);
});
test('reference mode never falls back after edits fails',async t=>{
 const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return new Response('edits unsupported',{status:405})});
 await assert.rejects(generateImage(settings,'action','',refs),{code:'EDITS_UNSUPPORTED'});assert.equal(calls.length,1);
});
test('unverified image backend is rejected before generation',async()=>{
 await assert.rejects(generateImage({...settings,backend:'tavern-sd'},'action','',refs),{code:'REFERENCE_BACKEND_UNSUPPORTED'});
});
