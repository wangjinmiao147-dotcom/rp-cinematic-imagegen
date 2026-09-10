import test from 'node:test';import assert from 'node:assert/strict';
import {generateImage,extractChatImage} from '../src/backends.js';
import {upstreamErrorMessage} from '../src/utils.js';
const refs=[{dataUrl:'data:image/png;base64,YWJj',kind:'identity-primary'},{dataUrl:'data:image/png;base64,ZGVm',kind:'continuity'}];
const settings={backend:'openai',backendUrl:'https://relay.test/v1',backendModel:'gemini-3.1-flash-image',backendKey:'fixture',imageSize:'9:16'};
const json=(status,body)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const mismatch={error:{message:'not supported model for image generation, only imagen models are supported (request id: fixture)',code:'convert_request_failed'}};

test('exact New API rejection switches protocol once while preserving prompt and reference bytes',async t=>{
    const calls=[];const warnings=[];t.mock.method(globalThis,'fetch',async(url,options)=>{if(url.endsWith('/models'))return json(200,{data:[]});
        calls.push({url,options});return calls.length===1?json(500,mismatch):json(200,{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'aW1hZ2U='}}]}}]});
    });
    const result=await generateImage(settings,'One character, same outfit','',refs,{onWarning:m=>warnings.push(m)});
    assert.equal(result.usedRefs,true);assert.equal(calls.length,2);assert.ok(calls[0].url.endsWith('/images/edits'));
    assert.equal(calls[1].url,'https://relay.test/v1beta/models/gemini-3.1-flash-image:generateContent');
    const payload=JSON.parse(calls[1].options.body);assert.deepEqual(payload.contents[0].parts.filter(p=>p.inlineData).map(p=>p.inlineData.data),['YWJj','ZGVm']);
    assert.ok(payload.contents[0].parts.some(p=>p.text?.includes('One character, same outfit')));
    assert.equal(payload.generationConfig.imageConfig.aspectRatio,'9:16');assert.equal(calls[1].options.headers.Authorization,'Bearer fixture');assert.equal(warnings.length,1);
});

test('Gemini without refs can recover from the same explicit generations conversion error',async t=>{
    const calls=[];t.mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/models'))return json(200,{data:[]});calls.push(url);return calls.length===1?json(500,mismatch):json(200,{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]});});
    assert.equal((await generateImage(settings,'test','',[])).usedRefs,false);assert.ok(calls[0].endsWith('/images/generations'));assert.ok(calls[1].endsWith(':generateContent'));
});

for(const [name,status,body,model] of [
    ['generic 500',500,{error:{message:'upstream overloaded'}},settings.backendModel],
    ['rate limiting',429,mismatch,settings.backendModel],['OpenAI model',500,mismatch,'gpt-image-1'],
])test(`${name} never triggers automatic protocol switching`,async t=>{
    let calls=0;t.mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/models'))return json(200,{data:[]});calls++;return json(status,body);});
    await assert.rejects(generateImage({...settings,backendModel:model},'test','',refs));assert.equal(calls,1);
});

test('native Gemini failure is surfaced without retry loop or reference-free fallback',async t=>{
    let calls=0;t.mock.method(globalThis,'fetch',async url=>{if(url.endsWith('/models'))return json(200,{data:[]});calls++;return calls===1?json(500,mismatch):json(403,{error:{message:'native route denied'}});});
    await assert.rejects(generateImage(settings,'test','',refs),e=>e.code==='GEMINI_IMAGE_HTTP'&&/native route denied/.test(e.message));assert.equal(calls,2);
});

test('JSON upstream reason is readable plain text with secrets removed',()=>{
    assert.equal(upstreamErrorMessage(JSON.stringify({error:{message:'unknown "image" model, key=fixture-secret'}}),['fixture-secret']),'unknown "image" model, key=[REDACTED]');
});

test('declared OpenAI Chat protocol bypasses Images API and carries every reference',async t=>{
    const calls=[];t.mock.method(globalThis,'fetch',async(url,options)=>{
        calls.push({url,options});
        return url.endsWith('/models')?json(200,{data:[{id:settings.backendModel,supported_endpoint_types:['openai']}]}):json(200,{choices:[{message:{content:'![test](data:image/png;base64,YWJj)'}}]});
    });
    const result=await generateImage(settings,'test prompt','',refs);
    assert.equal(result.usedRefs,true);assert.equal(calls.length,2);assert.ok(calls[1].url.endsWith('/chat/completions'));
    const payload=JSON.parse(calls[1].options.body);assert.deepEqual(payload.messages[0].content.filter(p=>p.type==='image_url').map(p=>p.image_url.url),refs.map(r=>r.dataUrl));
});

test('Chat 404 remains an explicit failure and does not try other paid routes',async t=>{
    let calls=0;t.mock.method(globalThis,'fetch',async url=>{calls++;return url.endsWith('/models')?json(200,{data:[{id:settings.backendModel,supported_endpoint_types:['openai']}]}):json(404,{error:{message:'openai_error'}});});
    await assert.rejects(generateImage(settings,'test','',refs),e=>e.code==='CHAT_IMAGE_HTTP'&&/404/.test(e.message));assert.equal(calls,2);
});

test('declared native Gemini protocol bypasses Images API',async t=>{
    const calls=[];t.mock.method(globalThis,'fetch',async url=>{calls.push(url);return url.endsWith('/models')?json(200,{data:[{id:settings.backendModel,supported_endpoint_types:['gemini']}]}):json(200,{candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]});});
    assert.equal((await generateImage(settings,'test','',refs)).usedRefs,true);assert.equal(calls.length,2);assert.ok(calls[1].includes('/v1beta/models/'));
});

test('Chat image extraction accepts typed images/markdown and rejects ordinary text links',()=>{
    for(const message of [{images:[{image_url:{url:'https://cdn.test/image.png'}}]}, {content:[{type:'image_url',image_url:{url:'https://cdn.test/image.png'}}]}, {content:'![image](https://cdn.test/image.png)'}])assert.equal(extractChatImage({choices:[{message}]}),'https://cdn.test/image.png');
    assert.equal(extractChatImage({choices:[{message:{content:'Please visit https://example.com for help'}}]}),null);
});

