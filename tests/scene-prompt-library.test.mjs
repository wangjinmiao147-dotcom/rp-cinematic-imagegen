import test from 'node:test';
import assert from 'node:assert/strict';
import { SCENE_PROMPT_REFERENCES, PROMPT_TERM_REFERENCES, buildScenePromptGuidance } from '../src/scene-prompt-library.js';
import { buildStoryFactsPrompt, buildRelationCheckerPrompt, buildEditInstructionPrompt, assembleUnifiedPrompt } from '../src/prompts.js';

test('the library provides applicability, grounded constraints and editable English examples', () => {
    assert.ok(SCENE_PROMPT_REFERENCES.length >= 25);
    assert.equal(new Set(SCENE_PROMPT_REFERENCES.map(r=>r.id)).size, SCENE_PROMPT_REFERENCES.length);
    for(const item of SCENE_PROMPT_REFERENCES){
        assert.ok(item.when && item.guidance && item.example && Object.isFrozen(item));
        assert.doesNotMatch(item.example, /photorealistic|cinematic lighting|8k|masterpiece/i);
    }
    assert.ok(PROMPT_TERM_REFERENCES.some(term=>term.source==='瞳孔' && term.english==='pupil'));
});

test('only editorial guidance receives the scenario catalogue; illustrative examples cannot become model facts', () => {
    for(const stage of ['fact','relation','editor']){
        const text=buildScenePromptGuidance(stage);
        assert.match(text,/不是剧情事实/);
        assert.match(text,/不照搬示例/);
        assert.match(text,/不增加JSON字段或生图阻断/);
        for(const item of SCENE_PROMPT_REFERENCES){
            assert.ok(!text.includes(item.example));
            if(stage==='editor')assert.ok(text.includes(item.guidance));
        }
    }
    assert.ok(buildScenePromptGuidance('fact').length<buildScenePromptGuidance('editor').length/4);
    assert.equal(buildScenePromptGuidance('facts'),buildScenePromptGuidance('fact'));
});

test('actual analysis builders include only the corresponding scene reference layer', () => {
    const builders=[['fact',buildStoryFactsPrompt],['relation',buildRelationCheckerPrompt],['editor',buildEditInstructionPrompt]];
    for(const [stage,build] of builders){
        const result=build({latestStory:'她闭嘴坐在木凳上。'});
        assert.ok(result.system.includes(buildScenePromptGuidance(stage)));
        assert.doesNotMatch(result.userText,/\[A\]|\[B\]|鱼尾/);
    }
    assert.doesNotMatch(assembleUnifiedPrompt({editInstruction:'Show her seated with lips closed.'}),/场景参考库|\[A\]|\[B\]/);
});
