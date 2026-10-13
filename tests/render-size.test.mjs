import test from 'node:test';
import assert from 'node:assert/strict';
import { configuredLocalImageSize } from '../src/render-size.js';
import { qwenSize, qwenIdentityRenderSettings, qwenSceneRenderPlan } from '../src/qwen.js';
import { getLocalRenderParameters, generateImage } from '../src/backends.js';
import { buildComfyPresetWorkflow } from '../src/comfy-presets.js';

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jr1sAAAAASUVORK5CYII=';
const refs=[{kind:'identity-primary',role:'identity-primary',identityName:'Alice',dataUrl:`data:image/png;base64,${png}`}];
const qwen={backend:'gemini',backendUrl:'http://127.0.0.1:8055',backendModel:'qwen-image-2.1',stylePreset:'reference',
    imageSize:'16:9',qwenResolution:'512x288',qwenSteps:24,localImageWidth:'512',localImageHeight:'288'};
const json=body=>new Response(JSON.stringify(body),{headers:{'Content-Type':'application/json'}});

test('explicit local pixels stay exact and missing overrides preserve the existing defaults',()=>{
    assert.equal(configuredLocalImageSize({}),null);
    assert.equal(configuredLocalImageSize({localImageWidth:'',localImageHeight:''}),null);
    assert.deepEqual(configuredLocalImageSize({localImageWidth:'480',localImageHeight:640}),[480,640]);
    assert.deepEqual(qwenSize({...qwen,imageSize:'9:16'}),[512,288]);
});

test('partial, fractional, nonnumeric and unaligned local pixels are rejected rather than changed',()=>{
    for(const [width,height] of [[512,''],[null,512],[255,512],[512,2050],[512,323],[512.5,512],['Infinity',512],[true,512],[{},512]]) {
        assert.throws(()=>configuredLocalImageSize({localImageWidth:width,localImageHeight:height}),{code:'LOCAL_RENDER_SIZE_INVALID'});
    }
});

test('manual pixels keep the chosen Qwen steps even with stale automatic quality flags',()=>{
    const settings={...qwen,qwenSceneDetail:true,qwenIdentityDetailBoost:true};
    assert.equal(qwenIdentityRenderSettings(settings,refs),settings);
    assert.equal(qwenSceneRenderPlan(settings,refs),null);
    assert.deepEqual(getLocalRenderParameters(settings,refs).size,[512,288]);
    assert.equal(getLocalRenderParameters(settings,refs).steps,24);
});

test('preview distinguishes internal high-resolution rendering from a resized final image',()=>{
    const parameters=getLocalRenderParameters({...qwen,localImageWidth:'',localImageHeight:'',qwenSceneDetail:true},refs);
    assert.deepEqual(parameters.size,[1024,576]);assert.deepEqual(parameters.outputSize,[512,288]);
    assert.match(parameters.description,/实际绘制：1024×576 像素 · 24 步.*最终输出：512×288/);
});

test('production Qwen request uses the same explicit pixels and steps as the preview',async t=>{
    let request;
    const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
    globalThis.fetch=async(url,options)=>{
        if(String(url).endsWith('/rpig-capabilities'))return json({bridge:'rpig-qwen',protocol:2,reference_order:true,explicit_dimensions:true});
        request=JSON.parse(options.body);return json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:png}}]}}]});
    };
    const settings={...qwen,qwenSceneDetail:true,qwenIdentityDetailBoost:true};
    const diagnostics={};
    await generateImage(settings,'Show Alice alone holding a yellow book in a courtyard.','',refs,{diagnostics});
    assert.deepEqual([request.width,request.height],[512,288]);assert.equal(request.steps,24);
    assert.deepEqual(diagnostics.renderParameters.size,[request.width,request.height]);
    assert.equal(diagnostics.renderParameters.steps,request.steps);
});

test('production SD request honors explicit pixels and its selected sampling steps',async t=>{
    let request;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
    globalThis.fetch=async(_url,options)=>{request=JSON.parse(options.body);return json({images:[png]});};
    await generateImage({backend:'sd',backendUrl:'http://sd.test',stylePreset:'anime',imageSize:'16:9',
        localImageWidth:448,localImageHeight:320,sdSteps:17},'one adult person standing in a courtyard','',[]);
    assert.deepEqual([request.width,request.height,request.steps],[448,320,17]);
});

test('built-in Comfy workflows apply the chosen pixels to the latent or scaled reference',()=>{
    for(const preset of ['sd-text','sd-img2img','qwen-edit']){
        const {workflow}=buildComfyPresetWorkflow({backend:'comfyui',comfyPreset:preset,comfyCheckpoint:'sd.safetensors',
            comfyUnet:'qwen.safetensors',comfyClip:'clip.safetensors',comfyVae:'vae.safetensors',
            localImageWidth:480,localImageHeight:640,comfySteps:17},{prompt:'one adult person',uploadedImages:preset==='sd-text'?[]:['one.png']});
        assert.deepEqual([workflow['10'].inputs.width,workflow['10'].inputs.height],[480,640]);
        assert.equal(workflow['12'].inputs.steps,17);
    }
});

test('invalid local pixels stop before reference hydration or backend requests',async t=>{
    let calls=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
    globalThis.fetch=async()=>{calls++;throw new Error('No request expected');};
    await assert.rejects(generateImage({...qwen,localImageHeight:323},'Show Alice holding a yellow book.','',
        [{kind:'identity-primary',url:'http://reference.test/a.png'}],{fetchToDataUrl:async()=>{calls++;}}),{code:'LOCAL_RENDER_SIZE_INVALID'});
    assert.equal(calls,0);
});
