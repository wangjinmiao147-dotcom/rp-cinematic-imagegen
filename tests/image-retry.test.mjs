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

// Execute the actual task function with isolated host/API adapters. This checks
// the production orchestration, including all three text stages and the review.
const source=await readFile(new URL('../index.js',import.meta.url),'utf8');
const resolveCharSource = source.slice(source.indexOf('async function resolveCharacterReferences('), source.indexOf('function migrateLegacyMedia('));
const resolveUserSource = source.slice(source.indexOf('async function resolveUserReferences('), source.indexOf('function migrateLegacyMedia('));
const executeTaskSource = source.slice(source.indexOf('async function executeGenerationTask('), source.indexOf('\nasync function generateCharacterSheetFlow('));
const taskSource = resolveCharSource + '\n' + resolveUserSource + '\n' + executeTaskSource;
function fixture() {
    const message={mes:'The character sits at a desk.',send_date:'today',swipe_id:0};
    const character={name:'Test',avatar:'test.png',description:'A test character'};
    const settings={backend:'openai',backendUrl:'https://api.test/v1',backendModel:'image',shotMode:'snapshot',useCharacterImage:false,previewBeforeGeneration:true};
    const context={chat:[message],chatId:'chat-one',name1:'Player',saveChat:async()=>{}};
    const cache=createImageRetryCache();
    const state={textCalls:0,imageCalls:[],reviews:0,refReads:0,failImage:true,failText:false,failRefs:false,cancelImage:false,toasts:[]};
    const dependencies={getCurrentWorldAgeContext,loadWorldInfo:async()=>state.worldBook||null,...utils,...sceneState,...qwen,...visualConstraints,parseAnalysisResponse,sanitizeDiagnostics,resolveCastReferencePlan,rpigImageRetryCache:cache,imageRetrySignature,getContext:()=>context,getChatSessionKey:c=>c.chatId,getSettings:()=>settings,
        getAllCharacters:()=> (state.characters || [character]).map(c=>({name:c.name,avatar:c.avatar,raw:c})),
        getCharacterForMessage:()=>character,getCurrentCharacter:()=>character,getPreviousGeneratedImage:()=>null, DEFAULT_SD_NEGATIVE: 'negative', timeoutSignal: () => new AbortController().signal, throwIfAborted: (signal) => { if (signal?.aborted) throw new DOMException('Aborted', 'AbortError'); }, scrubSensitiveText: (text) => text, extractJson: (text) => JSON.parse(text),
        setGenStatus:()=>{},toastr:Object.fromEntries(['info','warning','success','error'].map(type=>[type,(message,_title,options)=>state.toasts.push({type,message,options})])),
        buildDialogueContext:chat=>chat.map(m=>m.mes).join('\n'),buildParticipantContext:()=> 'participants',getCharacterVisualAnchor:()=>character.description,
        buildDirectorPrompt:()=>({system:'director',userText:'test'}),buildOmniscientPrompt:()=>({system:'omniscient',userText:'test'}),buildFinalizerPrompt:()=>({system:'finalizer',userText:'test'}),
        buildStoryFactsPrompt:()=>({system:'facts',userText:'test'}),buildRelationCheckerPrompt:options=>{state.relationDesign=options.characterDesignContext;return {system:'relation',userText:'test'};},buildEditInstructionPrompt:options=>{state.editorDesign=options.characterDesignContext;return {system:'edit',userText:'test'};},assembleUnifiedPrompt,
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
                    mentioned_only_characters:[],aliases:{},spatial_relations:[],action_ownership:[],conflicts:[]});
            }
            if (system === 'edit') {
                return JSON.stringify({ edit_instruction: (state.visibleCharacters || ['Test']).join(' and ') + ': User edited final prompt', preserve: '', exclude: state.exclude || [] });
            }
            return 'Final analyzed prompt';
        },
        parseDirectorLlmOutput:raw=>({json:JSON.parse(raw),finalPrompt:JSON.parse(raw).final_prompt}),normalizeCastCharacters:()=>state.visibleCharacters||['Test'],getFinalizerLlmSettings:s=>s,
        normalizeFinalPromptOutput:raw=>raw,collapsePromptToSingleParagraph:p=>p,enforceOmniscientEnsemble:p=>p,
        getCharacterAvatarDataUrl:async()=>{state.avatarReads=(state.avatarReads||0)+1;return null;},getCharacterAvatarInfo:()=>null,getCharacterIdentifier:c=>c?.avatar||c?.name||String(c),
        getCharacterRefs:async target=>{state.refReads++;if(state.failRefs)throw new Error('reference read failed');return target==='user'?(state.userRefs||[]):(state.refsByCharacter?.[target?.avatar] || state.refs || []);},
        buildSceneAwareImagePrompt:({basePrompt})=>basePrompt+' + reference instructions',
        reviewFinalPrompt:async()=>{state.reviews++;return{confirmed:true,prompt:'User edited final prompt',avoid:'User edited negative'};},
        generateImage:async(s,p,a,refs)=>{state.imageCalls.push({settings:{...s},prompt:p,avoid:a,refs});if(state.cancelImage)throw utils.createAbortError();if(state.failImage)throw new Error('image backend failed');return{dataUrl:'data:image/png;base64,YWJj',model:'image',usedRefs:true};},
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

test('image failure retries only images, preserving manual edits and skipping repeat review',async()=>{
    const f=fixture();assert.ok((await f.run()).error);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);
    f.settings.backendUrl='https://fixed-api.test/v1';f.settings.backendModel='fixed-image';f.state.failImage=false;
    assert.equal((await f.run()).success,true);assert.equal(f.state.textCalls,3);assert.equal(f.state.reviews,1);assert.equal(f.state.refReads,2);
    assert.equal(f.state.imageCalls.length,2);assert.equal(f.state.imageCalls[1].prompt,'User edited final prompt');assert.equal(f.state.imageCalls[1].avoid,'User edited negative');
    assert.equal(f.state.imageCalls[1].settings.backendUrl,'https://fixed-api.test/v1');
    await f.run();assert.equal(f.state.textCalls,6,'success must clear the failed-attempt cache');
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
