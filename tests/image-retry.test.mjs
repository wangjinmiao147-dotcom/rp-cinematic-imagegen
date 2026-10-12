import {getCurrentWorldAgeContext} from '../src/character-world-context.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createImageRetryCache, imageRetrySignature } from '../src/image-retry.js';
import * as utils from '../src/utils.js';
import * as sceneState from '../src/scene-state.js';
import * as qwen from '../src/qwen.js';
import {parseAnalysisResponse} from '../src/analysis-validation.js';
import {assembleUnifiedPrompt} from '../src/prompts.js';
import {sanitizeDiagnostics} from '../src/diagnostics.js';
import {resolveCastReferencePlan} from '../src/character-identities.js';
import * as visualConstraints from '../src/visual-constraints.js';
import * as taskContext from '../src/task-context.js';

// Execute the actual task function with isolated host/API adapters. This checks
// the production orchestration, including all three text stages and the review.
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const resolveCharSource = source.slice(source.indexOf('async function resolveCharacterReferences('), source.indexOf('function migrateLegacyMedia('));
const resolveUserSource = source.slice(source.indexOf('async function resolveUserReferences('), source.indexOf('function migrateLegacyMedia('));
const executeTaskSource = source.slice(source.indexOf('async function executeGenerationTask('), source.indexOf('\nasync function generateCharacterSheetFlow('));
const taskSource = resolveCharSource + '\n' + resolveUserSource + '\n' + executeTaskSource;
function fixture({ clock = null } = {}) {
    const message={mes:'The character sits at a desk.',send_date:'today',swipe_id:0};
    const character={name:'Test',avatar:'test.png',description:'A test character'};
    const settings={backend:'openai',backendUrl:'https://api.test/v1',backendModel:'image',shotMode:'snapshot',useCharacterImage:false,previewBeforeGeneration:true};
    const context={chat:[message],chatId:'chat-one',name1:'Player',saveChat:async()=>{}};
    const cache=createImageRetryCache();
    const state={textCalls:0,imageCalls:[],reviews:0,refReads:0,failImage:true,failText:false,failRefs:false,cancelImage:false,toasts:[]};
    const RuntimeDate = clock ? class extends Date {
        constructor(...args) { super(...(args.length ? args : [clock.now])); }
        static now() { return clock.now; }
    } : Date;
    const dependencies={Date:RuntimeDate,getCurrentWorldAgeContext,loadWorldInfo:async()=>state.worldBook||null,...utils,...sceneState,...qwen,...visualConstraints,...taskContext,parseAnalysisResponse,sanitizeDiagnostics,resolveCastReferencePlan,rpigImageRetryCache:cache,imageRetrySignature,getContext:()=>context,getChatSessionKey:c=>c.chatId,getSettings:()=>settings,
        getAllCharacters:()=> (state.characters || [character]).map(c=>({name:c.name,avatar:c.avatar,raw:c})),
        getCharacterForMessage:()=>character,getCurrentCharacter:()=>character,getPreviousGeneratedImage:()=>null, DEFAULT_SD_NEGATIVE: 'negative', timeoutSignal: () => new AbortController().signal, throwIfAborted: (signal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }, scrubSensitiveText: (text) => text, extractJson: (text) => JSON.parse(text),
        setGenStatus:()=>{},toastr:Object.fromEntries(['info','warning','success','error'].map(type=>[type,(message,_title,options)=>state.toasts.push({type,message,options})])),
        buildDialogueContext:chat=>chat.map(m=>m.mes).join('\n'),buildParticipantContext:()=> 'participants',getCharacterVisualAnchor:()=>character.description,
        buildDirectorPrompt:()=>({system:'director',userText:'test'}),buildOmniscientPrompt:()=>({system:'omniscient',userText:'test'}),buildFinalizerPrompt:()=>({system:'finalizer',userText:'test'}),
        buildStoryFactsPrompt:()=>({system:'facts',userText:'test'}),buildRelationCheckerPrompt:options=>{state.relationDesign=options.characterDesignContext;return {system:'relation',userText:'test'};},buildEditInstructionPrompt:options=>{state.editorDesign=options.characterDesignContext;state.editorCast=options.castAndSpatialFacts;return {system:'edit',userText:'test'};},assembleUnifiedPrompt,
        persistGenerationDiagnostics:diagnostic=>sanitizeDiagnostics(diagnostic),
        callLLM:async (system)=>{
            state.textCalls++;
            state.textSystems ||= []; state.textSystems.push(system);
            system = system.split('\n')[0];
            if(state.failText) throw new Error('text endpoint failed');
            if (system === 'facts') {
                const unknown = {location:null,time_of_day:null,weather:null,lighting:null,scene_continues:null};
                const prior = sceneState.getPreviousSceneState(context.chat, context.chat.indexOf(message));
                state.onFacts?.();
                return JSON.stringify({moment:'now',moment_evidence:message.mes,scene_state:unknown,
                    actions:[{character:'Test',action:'sit at desk',expression:null,gaze:null,contact:null}],
                    thoughts:[],uncertainties:[],explicit_changes:{clothing:[],environment:[],props:[]},
                    persistent_continues:null,persistent_updates:[],narrative_end_updates:[],continuity_updates:[],
                    narrative_end_state:{...unknown,persistent_continues:null},
                    continuity_state:prior._hasInterveningMessages?{...unknown,persistent_continues:null}:null,...state.factOverrides});
            }
            if (system === 'relation') {
                return JSON.stringify({visible_characters:state.invalidCast?[null]:[{canonical_name:'Test',presence_evidence:message.mes,visible_scope:null}],
                    mentioned_only_characters:[],aliases:{},spatial_relations:[],action_ownership:[],conflicts:[],...state.relationOverrides});
            }
            if (system === 'edit') {
                return JSON.stringify({ edit_instruction: state.editInstruction ?? ((state.visibleCharacters || ['Test']).join(' and ') + ': User edited final prompt'), preserve: '', exclude: state.exclude || [] });
            }
            return 'Final analyzed prompt';
        },
        parseDirectorLlmOutput:raw=>({json:JSON.parse(raw),finalPrompt:JSON.parse(raw).final_prompt}),normalizeCastCharacters:()=>state.visibleCharacters||['Test'],getFinalizerLlmSettings:s=>s,
        normalizeFinalPromptOutput:raw=>raw,collapsePromptToSingleParagraph:p=>p,enforceOmniscientEnsemble:p=>p,
        getCharacterAvatarDataUrl:async()=>{state.avatarReads=(state.avatarReads||0)+1;return null;},getCharacterAvatarInfo:()=>null,getCharacterIdentifier:c=>c?.avatar||c?.name||String(c),
        getCharacterRefs:async target=>{state.refReads++;state.onRefs?.();if(state.failRefs)throw new Error('reference read failed');return target==='user'?(state.userRefs||[]):(state.refsByCharacter?.[target?.avatar] || state.refs || []);},
        buildSceneAwareImagePrompt:({basePrompt})=>basePrompt+' + reference instructions',
        reviewFinalPrompt:async()=>{state.reviews++;state.onReview?.();return{confirmed:true,prompt:'User edited final prompt',avoid:'User edited negative'};},
        generateImage:async(s,p,a,refs)=>{state.imageCalls.push({settings:{...s},prompt:p,avoid:a,refs});state.onImage?.();if(state.cancelImage)throw utils.createAbortError();if(state.failImage)throw new Error('image backend failed');return{dataUrl:'data:image/png;base64,YWJj',model:'image',usedRefs:true};},
        fetchToDataUrl:async()=>'',SlashCommandParser:{},persistMediaUrl:async()=>'/saved.png',saveBase64AsFile:()=>{},migrateLegacyMedia:()=>{},
        $:()=>({addClass(){return this;}}),updateMessageBlock:()=>{},ensureFallbackMediaRender:()=>{},saveToGallery:async()=>{},
    };
    const execute=new Function(...Object.keys(dependencies),taskSource+';return executeGenerationTask;')(...Object.values(dependencies));
    return{state,message,settings,context,character,cache,run:async (overrides={})=>{
        let testRes;
        const res=await execute({messageIndex:context.chat.indexOf(message),controller:new AbortController(),resolve:r=>{testRes=r;},...overrides});
        return testRes || res;
    }};
}

for (const wording of ['Lin Lan', '小岚', '林澜', 'She']) {
    test(`production generation accepts ${wording} while keeping the verified character and reference identity`, async()=>{
        const f=fixture();
        f.character.name='林岚';f.message.name='林岚';f.message.mes='林岚站在门边，左手指着一把钥匙。';
        f.settings.stylePreset='reference';f.settings.previewBeforeGeneration=false;f.state.failImage=false;
        f.state.visibleCharacters=['林岚'];
        f.state.factOverrides={actions:[{character:'林岚',action:'左手指着一把钥匙',expression:null,gaze:null,contact:null}]};
        f.state.relationOverrides={visible_characters:[{canonical_name:'林岚',presence_evidence:f.message.mes,visible_scope:null}],
            aliases:{小岚:'林岚'},action_ownership:['林岚左手指着一把钥匙']};
        f.state.refs=[{url:'/lin-identity.png',label:'Lin identity',isPrimaryIdentity:true}];
        f.state.editInstruction=`${wording} stands by the door and points at one key with her left hand.`;
        assert.equal((await f.run()).success,true);
        assert.equal(f.state.textCalls,3,'No extra identity repair or model call is added');
        assert.deepEqual(f.state.editorCast.aliases,{小岚:'林岚'});
        assert.equal(f.state.imageCalls.length,1);
        assert.match(f.state.imageCalls[0].prompt,/VISIBLE CAST \(1\): 林岚/);
        assert.ok(f.state.imageCalls[0].prompt.includes(f.state.editInstruction));
        assert.equal(f.state.imageCalls[0].refs[0].identityId,'character:test.png');
        assert.equal(f.state.imageCalls[0].refs[0].identityName,'林岚');
        assert.equal(f.state.imageCalls[0].refs[0].url,'/lin-identity.png');
        assert.equal(f.message.extra.rpigLastAttempt.errorCode,null);
    });
}

test('two translated actors keep separate stage-two card references and partial-body context',async()=>{
    const f=fixture();
    f.character.name='林岚';f.message.name='林岚';f.message.mes='林岚伸手，周禾只露出右手递来一把钥匙。';
    const other={name:'周禾',avatar:'zhou.png'};
    f.state.characters=[f.character,other];f.state.visibleCharacters=['林岚','周禾'];
    f.settings.stylePreset='reference';f.settings.previewBeforeGeneration=false;f.state.failImage=false;
    f.state.factOverrides={actions:[{character:'林岚',action:'伸手',expression:null,gaze:null,contact:null},
        {character:'周禾',action:'只露出右手递来一把钥匙',expression:null,gaze:null,contact:null}]};
    f.state.relationOverrides={visible_characters:[{canonical_name:'林岚',presence_evidence:'林岚伸手',visible_scope:null},
        {canonical_name:'周禾',presence_evidence:'周禾只露出右手递来一把钥匙',visible_scope:'右手，仅手部'}],
        aliases:{小岚:'林岚',ZhouHe:'周禾'},action_ownership:['林岚伸手','周禾右手递来一把钥匙']};
    f.state.refsByCharacter={'test.png':[{url:'/lin-identity.png',isPrimaryIdentity:true}],
        'zhou.png':[{url:'/zhou-identity.png',isPrimaryIdentity:true}]};
    f.state.editInstruction='Lin Lan reaches toward one key offered by Zhou He, whose right hand alone is visible.';
    assert.equal((await f.run()).success,true);
    assert.equal(f.state.textCalls,3);
    assert.equal(f.state.editorCast.visible_characters[1].visible_scope,'右手，仅手部');
    assert.deepEqual(f.state.editorCast.action_ownership,['林岚伸手','周禾右手递来一把钥匙']);
    assert.deepEqual(f.state.imageCalls[0].refs.map(ref=>[ref.identityId,ref.identityName,ref.url]),
        [['character:test.png','林岚','/lin-identity.png'],['character:zhou.png','周禾','/zhou-identity.png']]);
    assert.match(f.state.imageCalls[0].prompt,/VISIBLE CAST \(2\): 林岚, 周禾/);
});

test('an empty third-stage result still stops before any image request',async()=>{
    const f=fixture();f.state.editInstruction='';f.state.failImage=false;
    const result=await f.run();
    assert.equal(result.error.code,'ANALYSIS_INVALID_SCHEMA');
    assert.equal(f.state.imageCalls.length,0);
    assert.equal(f.message.extra.rpigLastAttempt.stage,'instruction');
});

test('image failure retries only images, preserving manual edits and skipping repeat review',async()=>{
    const f=fixture();assert.ok((await f.run()).error);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);
    f.settings.backendUrl='https://fixed-api.test/v1';f.settings.backendModel='fixed-image';f.state.failImage=false;
    assert.equal((await f.run()).success,true);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);assert.equal(f.state.refReads,2);
    assert.equal(f.state.imageCalls.length,2);assert.equal(f.state.imageCalls[1].prompt,'User edited final prompt');assert.equal(f.state.imageCalls[1].avoid,'User edited negative');
    assert.equal(f.state.imageCalls[1].settings.backendUrl,'https://fixed-api.test/v1');
    await f.run();assert.equal(f.state.textCalls,6,'success must clear the failed-attempt cache');
});

test('story diagnostics identify the actual task backend and preserve uncoded failures as null', async()=>{
    const f=fixture();
    assert.ok((await f.run()).error);
    const failed=f.message.extra.rpigLastAttempt;
    assert.equal(failed.mode,'story');
    assert.equal(failed.backend,'openai');
    assert.equal(failed.status,'failed');
    assert.equal(failed.stage,'image-request');
    assert.equal(failed.errorCode,null);
    assert.ok(Date.parse(failed.finishedAt)>=Date.parse(failed.timestamp));
    f.settings.backend='gemini';f.state.failImage=false;
    assert.equal((await f.run()).success,true);
    const completed=f.message.extra.rpigLastAttempt;
    assert.equal(completed.mode,'story');
    assert.equal(completed.backend,'gemini');
    assert.equal(completed.status,'success');
    assert.equal(completed.stage,'complete');
    assert.equal(completed.errorCode,null);
});

test('story diagnostic duration includes text analysis before the image request', async()=>{
    const start=Date.UTC(2026,9,12,1,0,0);
    const clock={now:start};
    const f=fixture({clock});
    f.state.onFacts=()=>{clock.now+=3000;};
    f.state.onImage=()=>{clock.now+=2000;};
    assert.ok((await f.run()).error);
    const diagnostic=f.message.extra.rpigLastAttempt;
    assert.equal(Date.parse(diagnostic.timestamp),start);
    assert.equal(Date.parse(diagnostic.finishedAt)-Date.parse(diagnostic.timestamp),5000);
});

test('actual orchestration carries verified current undress through a missing editor wardrobe sentence',async()=>{
    const f=fixture();f.message.mes='Test未穿衣物，正在浴室里叩门。';
    f.settings.previewBeforeGeneration=false;f.state.failImage=false;
    f.state.factOverrides={persistent_continues:true,persistent_updates:[
        {character:'Test',category:'clothing',key:'outfit',value:'未穿衣物',evidence:'Test未穿衣物'}],
        actions:[{character:'Test',action:'正在浴室里叩门',expression:null,gaze:null,contact:null}]};
    assert.equal((await f.run()).success,true);
    assert.match(f.state.imageCalls[0].prompt,/Show Test unclothed/);
    assert.deepEqual(f.message.extra.rpigInfo.diagnostics.appearanceChanges,[{character:'Test',state:'unclothed'}]);
});

test('production orchestration passes its actual shot mode to the unified and Qwen framing preference',async()=>{
    for(const shotMode of ['snapshot','portrait']){
        const f=fixture();f.settings.shotMode=shotMode;f.settings.previewBeforeGeneration=false;f.state.failImage=false;
        assert.equal((await f.run()).success,true);
        const prompt=f.state.imageCalls[0].prompt;
        assert.ok(prompt.includes(visualConstraints.FRAMING_PREFERENCES[shotMode]));
        assert.ok(qwen.qwenReferenceEditPrompt(prompt,[{kind:'identity-primary'}]).includes(visualConstraints.FRAMING_PREFERENCES[shotMode]));
    }
    const f=fixture();f.settings.shotMode='snapshot';f.settings.previewBeforeGeneration=false;f.state.failImage=false;
    assert.equal((await f.run({explicitShotMode:'portrait'})).success,true);
    assert.ok(f.state.imageCalls[0].prompt.includes(visualConstraints.FRAMING_PREFERENCES.portrait));
});

test('the production pipeline passes scoped exclusions into the positive image prompt',async()=>{
    const f=fixture();f.state.failImage=false;f.settings.previewBeforeGeneration=false;
    f.state.exclude=["blushing on the main figure's face",'writing on the blank paper'];
    assert.equal((await f.run()).success,true);
    const sent=f.state.imageCalls[0];
    assert.match(sent.prompt,/ELEMENTS TO OMIT:/);
    for(const item of f.state.exclude){assert.ok(sent.prompt.includes(item));assert.ok(sent.avoid.includes(item));}
});

test('multiple image failures keep the same completed analysis',async()=>{
    const f=fixture();await f.run();await f.run();await f.run();assert.equal(f.state.textCalls,3);assert.equal(f.state.imageCalls.length,3);assert.equal(f.state.reviews,1);
});

test('manual retry reuses completed automatic analysis instead of discarding its preset',async()=>{
    const f=fixture();await f.run({presetPrompt:'Auto director result',generationMeta:{automatic:true,sceneAnchor:'desk',sceneChanged:true}});
    assert.equal(f.state.textCalls,3);await f.run();assert.equal(f.state.textCalls,3);assert.equal(f.state.imageCalls.length,2);
});

test('reference failure after text completion retries reference reading without text calls',async()=>{
    const f=fixture();f.state.failRefs=true;assert.ok((await f.run()).error);assert.equal(f.state.imageCalls.length,0);f.state.failRefs=false;f.state.failImage=false;
    assert.equal((await f.run()).success,true);assert.equal(f.state.textCalls,3);assert.equal(f.state.refReads,2);
});

for(const [name,mutate] of [
    ['message edit',f=>f.message.mes+=' New action.'],['swipe',f=>f.message.swipe_id++],['chat change',f=>f.context.chatId='other'],
    ['character change',f=>f.character.avatar='other.png'],['character description',f=>f.character.description='New character'],
    ['shot mode',f=>f.settings.shotMode='portrait'],['style',f=>f.settings.stylePreset='anime'],['omniscient mode',f=>f.settings.omniscientMode=false],
])test(`${name} invalidates old analysis`,async()=>{const f=fixture();await f.run();mutate(f);await f.run();assert.ok(f.state.textCalls>3);});

test('text failure does not cache incomplete analysis',async()=>{
    const f=fixture();f.state.failText=true;await f.run();assert.equal(f.state.imageCalls.length,0);f.state.failText=false;await f.run();assert.equal(f.state.textCalls,4);
});

test('cancellation and explicit chat cleanup discard retry analysis',async()=>{
    const f=fixture();f.state.cancelImage=true;
    const res1 = await f.run();
    assert.equal(res1?.cancelled,true);f.state.cancelImage=false;await f.run();assert.equal(f.state.textCalls,6);f.cache.clear();await f.run();assert.equal(f.state.textCalls,9);
});

test('generation error toast supplies plain text with explicit HTML escaping',async()=>{
    const f=fixture();await f.run();const error=f.state.toasts.find(t=>t.type==='error');assert.equal(error.options.escapeHtml,true);assert.equal(error.message.includes('&quot;'),false);
});

test('user can choose fresh analysis after failure and then reuse the new result', async()=>{
    const f=fixture();await f.run();assert.equal(f.state.textCalls,3);
    f.settings.imageRetryMode='reanalyze';await f.run();assert.equal(f.state.textCalls,6);assert.equal(f.state.reviews,2);
    f.settings.imageRetryMode='reuse';f.state.failImage=false;assert.equal((await f.run()).success,true);
    assert.equal(f.state.textCalls,6);assert.equal(f.state.reviews,2);
});
test('fresh analysis failure cannot resurrect an older cached prompt', async()=>{
    const f=fixture();await f.run();f.settings.imageRetryMode='reanalyze';f.state.failText=true;await f.run();
    f.settings.imageRetryMode='reuse';f.state.failText=false;await f.run();
    assert.equal(f.state.textCalls,7);assert.equal(f.state.reviews,2);
});

test('reference style prioritizes uploaded image over card avatar in the actual task',async()=>{
    const f=fixture();f.settings.stylePreset='reference';f.settings.useCharacterImage=true;
    f.state.refs=[{dataUrl:'data:image/png;base64,YWJj',label:'uploaded style'}];await f.run();
    assert.equal(f.state.avatarReads||0,0);assert.equal(f.state.imageCalls[0].refs.length,1);
    assert.equal(f.state.imageCalls[0].refs[0].dataUrl,f.state.refs[0].dataUrl);
    assert.equal(f.state.imageCalls[0].refs[0].kind,'identity-primary');
});

test('visible User receives the separate User three-view references without leaking the off-camera role character',async()=>{
    const f=fixture();f.settings.stylePreset='reference';f.settings.useCharacterImage=true;f.state.visibleCharacters=['Player'];
    f.state.refs=[{dataUrl:'data:image/png;base64,Y2hhcg==',label:'off-camera character'}];
    f.state.userRefs=[{dataUrl:'data:image/png;base64,dXNlcg==',label:'User front'}];f.state.failImage=false;
    assert.equal((await f.run()).success,true);
    assert.equal(f.state.avatarReads||0,0);
    assert.equal(f.state.imageCalls[0].refs.length,1);
    assert.equal(f.state.imageCalls[0].refs[0].dataUrl,f.state.userRefs[0].dataUrl);
    assert.equal(f.state.imageCalls[0].refs[0].identityId,'user');
    assert.equal(f.state.imageCalls[0].refs[0].identityName,'Player');
    assert.equal(f.state.imageCalls[0].refs[0].kind,'identity-primary');
});

test('editing an earlier message beyond the display summary invalidates retry analysis', async()=>{
    const f=fixture();const prior={mes:'Earlier story. '+ 'x'.repeat(500),swipe_id:0};f.context.chat.unshift(prior);
    await f.run();assert.equal(f.state.textCalls,3);
    prior.mes+=' Changed clothing.';await f.run();assert.equal(f.state.textCalls,6);
});
test('editing a continuity source during analysis discards the in-flight result', async()=>{
    const f=fixture();const prior={mes:'Earlier story.'};f.context.chat.unshift(prior);
    f.state.onFacts=()=>{prior.mes+=' Changed ending.';};await f.run();
    assert.equal(f.state.textCalls,1);assert.equal(f.state.imageCalls.length,0);
});
test('an invalid nonempty cast cannot reach the image backend or cache', async()=>{
    const f=fixture();f.state.invalidCast=true;const result=await f.run();
    assert.equal(result.error.code,'ANALYSIS_EMPTY_CAST');assert.equal(f.state.imageCalls.length,0);
    f.state.invalidCast=false;await f.run();assert.equal(f.state.textCalls,5);
});

test('a renamed current card uses its own uploaded references under the story actor name',async()=>{
    const f=fixture();f.settings.stylePreset='reference';f.state.failImage=false;
    f.character.name='林岚1';f.character.avatar='林岚11.png';f.message.name='林岚1';
    f.state.visibleCharacters=['林岚'];
    f.state.refs=[{dataUrl:'data:image/png;base64,b3du',label:'own reference',isPrimaryIdentity:true}];
    assert.equal((await f.run()).success,true);
    assert.equal(f.state.imageCalls[0].refs.length,1);
    assert.equal(f.state.imageCalls[0].refs[0].identityId,'character:林岚11.png');
    assert.equal(f.state.imageCalls[0].refs[0].identityName,'林岚');
    assert.equal(f.state.imageCalls[0].refs[0].dataUrl,f.state.refs[0].dataUrl);
});

test('two visible characters load separate card libraries instead of sharing the focal face',async()=>{
    const f=fixture();f.settings.stylePreset='reference';f.state.failImage=false;
    f.character.name='First1';f.state.visibleCharacters=['First','Second'];
    f.state.characters=[f.character,{name:'Second2',avatar:'second.png'}];
    f.state.refsByCharacter={
        'test.png':[{dataUrl:'data:image/png;base64,Zmlyc3Q=',isPrimaryIdentity:true}],
        'second.png':[{dataUrl:'data:image/png;base64,c2Vjb25k',isPrimaryIdentity:true}],
    };
    assert.equal((await f.run()).success,true);
    const refs=f.state.imageCalls[0].refs;
    assert.deepEqual(refs.map(r=>r.identityName),['First','Second']);
    assert.deepEqual(refs.map(r=>r.identityId),['character:test.png','character:second.png']);
    assert.notEqual(refs[0].dataUrl,refs[1].dataUrl);
});

test('the actual three-stage orchestration uses the current linked world age',async()=>{
    const f=fixture();f.state.failImage=false;f.character.data={extensions:{world:'Test world'}};
    f.state.worldBook={entries:{3:{comment:'Test',content:'外表年龄: 18岁'}}};
    assert.equal((await f.run()).success,true);assert.match(f.state.textSystems[0],/18岁/);
    assert.match(f.state.relationDesign,/18岁/);assert.match(f.state.editorDesign,/18岁/);
});
test('editing the message while references load stops before the image request',async()=>{
    const f=fixture();f.state.failImage=false;
    f.state.onRefs=()=>{f.message.mes='A replacement story.';};
    await f.run();
    assert.equal(f.state.imageCalls.length,0);
    assert.equal(f.message.extra?.media,undefined);
});

test('editing the message in the prompt review stops before the image request',async()=>{
    const f=fixture();f.state.failImage=false;
    f.state.onReview=()=>{f.message.swipe_id=1;};
    await f.run();
    assert.equal(f.state.reviews,1);
    assert.equal(f.state.imageCalls.length,0);
});

test('changing backend settings during text analysis applies to the next task only',async()=>{
    const f=fixture();
    f.state.onFacts=()=>{f.settings.backendUrl='https://replacement.test/v1';};
    await f.run();
    assert.equal(f.state.imageCalls[0].settings.backendUrl,'https://api.test/v1');
    f.state.failImage=false;
    await f.run();
    assert.equal(f.state.imageCalls[1].settings.backendUrl,'https://replacement.test/v1');
});
