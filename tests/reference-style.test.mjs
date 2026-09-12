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

for(const protocol of ['openai','gemini','chat'])test(`${protocol} sends all six distinct references in order`,async t=>{
 const six=Array.from({length:6},(_,i)=>({dataUrl:`data:image/png;base64,${Buffer.from(`ref${i}`).toString('base64')}`,kind:i?'identity-secondary':'identity-primary'}));
 let sent;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(url.endsWith('/models'))return new Response(JSON.stringify({data:[{id:'gemini-3.1-flash-image',supported_endpoint_types:['openai']}]}));
  sent=options.body;
  return new Response(JSON.stringify(protocol==='gemini'?{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]}:protocol==='chat'?{choices:[{message:{images:[{image_url:{url:'data:image/png;base64,YWJj'}}]}}]}:{data:[{b64_json:'YWJj'}]}));
 });
 await generateImage({...settings,backend:protocol==='gemini'?'gemini':'openai',backendModel:protocol==='openai'?'gpt-image-1':'gemini-3.1-flash-image'},'scene action','',six);
 const images=protocol==='openai'?await Promise.all(sent.getAll('image[]').map(async f=>Buffer.from(await f.arrayBuffer()).toString('base64'))):protocol==='gemini'?JSON.parse(sent).contents[0].parts.filter(p=>p.inlineData).map(p=>p.inlineData.data):JSON.parse(sent).messages[0].content.filter(p=>p.image_url).map(p=>p.image_url.url.split(',')[1]);
 assert.deepEqual(images,six.map(r=>r.dataUrl.split(',')[1]));
});
test('SD cannot silently consume just the first of multiple references',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected')});
 await assert.rejects(generateImage({...settings,backend:'sd'},'action','',refs),{code:'MULTI_REFERENCE_UNSUPPORTED'});assert.equal(calls,0);
});
test('invalid sixth reference fails rather than disappearing beyond an old cap',async t=>{
 let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('unexpected')});
 const six=Array.from({length:5},(_,i)=>({dataUrl:`data:image/png;base64,${Buffer.from(`ref${i}`).toString('base64')}`}));six.push({});
 await assert.rejects(generateImage(settings,'action','',six),{code:'REFERENCE_MISSING'});assert.equal(calls,0);
});
