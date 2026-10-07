import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {mirrorLayoutPlan,mirrorLayoutReference,mirrorFixture,projector} from '../src/mirror-layout.js';
import {assembleUnifiedPrompt} from '../src/prompts.js';
import {generateImage} from '../src/backends.js';

const refs=[{role:'identity-primary',kind:'identity-primary',identityName:'A',dataUrl:'data:image/png;base64,YWJj'}];
const story=(hand='right')=>`Show A alone standing, facing a vertical wall mirror. Observe her from behind and slightly to her ${hand==='right'?'left':'right'}; her body and head remain directed toward the mirror. Her raised ${hand} palm touches the mirror at shoulder height and her ${hand==='right'?'left':'right'} arm hangs at her side.`;
const full=edit=>assembleUnifiedPrompt({editInstruction:edit,preserve:'Her current red robe.'})+'\nVISIBLE CAST (1): A. Each listed person has one physical body.';

test('supported single-person contacts project one shared palm and do not add an identity',()=>{
    for(const side of ['right','left']){
        const plan=mirrorLayoutPlan(full(story(side)),refs);
        assert.equal(plan.hand,side);
        const fixture=mirrorFixture(side),project=projector(fixture.camera);
        assert.deepEqual(project(fixture.joints[side+'Palm']),project(fixture.reflected[side+'Palm']));
        const reference=mirrorLayoutReference(plan,512,288);
        assert.equal(reference.role,'mirror-layout');assert.equal(reference.identityName,undefined);
        assert.deepEqual(reference.geometryContact,reference.reflectedContact);
    }
    assert.equal(mirrorLayoutPlan(full(story().replace('alone standing','alone')),refs).postureSource,'unspecified-simple-contact');
});
test('unsupported poses, partial crops, unknown hand tasks and non-optical events retain the ordinary path',()=>{
    const unsupported=[story().replace('standing','seated'),story().replace('standing','kneeling'),
        story().replace('right palm','palm'),story().replace('at shoulder height','near her head'),
        story().replace('left arm hangs at her side','left arm holds a cup'),
        story()+' Use an explicit close-up.',story()+' Only her hand is visible in this partial view.',
        story()+' Her reflection acts independently in a supernatural event.',
        story()+' Her legs remain crossed.',story()+' Use a high-angle view.',
        story()+' Her arm stays fully extended.',
        story()+' She balances on one foot.',story()+' Her feet stay outside the frame.',
        story()+' She is hovering.',story()+' There is another mirror.',
        story().replace('vertical wall mirror','round wall mirror'),
        story()+' Keep her confirmed fish tail.',story().replace('vertical wall mirror','frosted-glass door'),
        story().replace('from behind and slightly to her left','from the front'),
        story().replace('from behind and slightly to her left','from behind and slightly to her right'),
        story().replace('body and head remain directed toward the mirror','head turns toward the camera'),
        story().replace('standing','not standing')];
    for(const edit of unsupported)assert.equal(mirrorLayoutPlan(full(edit),refs),null,edit);
    assert.equal(mirrorLayoutPlan(full(story()),refs,{shotMode:'portrait'}),null);
    assert.equal(mirrorLayoutPlan(full(story()).replace('CAST (1)','CAST (2)'),refs),null);
    assert.equal(mirrorLayoutPlan(full(story()),[...refs,{role:'identity-primary',identityName:'B'}]),null);
});
test('portable layout PNG decodes at the current saved aspect ratio and has physical head/foot margins',()=>{
    for(const size of [[512,288],[288,512],[512,512]]){
        const ref=mirrorLayoutReference(mirrorLayoutPlan(full(story()),refs),...size);
        const png=Buffer.from(ref.dataUrl.split(',')[1],'base64');
        assert.equal(png.readUInt32BE(16),size[0]);assert.equal(png.readUInt32BE(20),size[1]);
        const blocks=[];for(let off=8;off<png.length;){const len=png.readUInt32BE(off),type=png.toString('ascii',off+4,off+8);if(type==='IDAT')blocks.push(png.subarray(off+8,off+8+len));off+=len+12;}
        const rgba=zlib.inflateSync(Buffer.concat(blocks));assert.equal(rgba.length,size[1]*(size[0]*4+1));
        assert.ok(rgba.some(byte=>byte!==0));
    }
});
test('the plugin sends identity plus generated geometry in one Qwen call without changing saved controls',async t=>{
    const calls=[];t.mock.method(globalThis,'fetch',async(url,options={})=>{
        if(url.endsWith('/rpig-capabilities'))return Response.json({bridge:'rpig-qwen',protocol:2,reference_order:true,explicit_dimensions:true});
        calls.push({url,body:JSON.parse(options.body)});
        return Response.json({candidates:[{content:{parts:[{inlineData:{mimeType:'image/png',data:'YWJj'}}]}}]});
    });
    const settings={backend:'gemini',backendUrl:'http://127.0.0.1:8055/v1',backendModel:'qwen-image-2.1',stylePreset:'reference',shotMode:'snapshot',imageSize:'16:9',qwenResolution:'512x288',qwenSteps:24,qwenCfg:1,qwenSeed:123};
    const before=JSON.stringify(settings),diagnostics={};
    const result=await generateImage(settings,full(story()),'',refs,{diagnostics});
    assert.equal(calls.length,1);assert.equal(JSON.stringify(settings),before);
    const request=calls[0].body,parts=request.contents[0].parts;
    assert.equal(parts.filter(p=>p.inlineData).length,2);assert.equal(parts[0].inlineData.data,'YWJj');
    assert.deepEqual([request.width,request.height,request.steps,request.cfg_scale,request.seed],[512,288,24,1,123]);
    assert.match(result.usedPrompt,/geometry in <image2>/);assert.match(result.usedPrompt,/identity and artwork style from <image1>/);
    assert.match(result.usedPrompt,/Her current red robe/);assert.match(result.usedPrompt,/one shared contact point/);
    assert.equal(diagnostics.references[1].role,'mirror-layout');assert.equal(diagnostics.referenceSelection.generated,1);
});
