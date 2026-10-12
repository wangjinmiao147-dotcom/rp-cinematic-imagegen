import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisResponse } from '../src/analysis-validation.js';

const instructionResult = instruction => JSON.stringify({
    edit_instruction: instruction,
    thought_bubble_instruction: '',
    preserve: '',
    exclude: [],
});

function parse(instruction, names = ['林岚']) {
    return parseAnalysisResponse(instructionResult(instruction), 3, {
        latestStory: '林岚站在门边，抬起左手指着一把钥匙。',
        expectedCharacterNames: names,
    });
}

// Stage 3 controls wording. Its parser validates usable structured content;
// actor, action and reference identities come from the Stage 2 result. These
// cases must neither trigger a spelling gate nor invent a replacement name.
for (const instruction of [
    'Show her standing by the door and pointing at one key with her left hand.',
    'Show the same woman standing by the door and pointing at one key with her left hand.',
    'Show 小岚 standing by the door and pointing at one key with her left hand.',
    'Show Lin Lan standing by the door and pointing at one key with her left hand.',
    'Show Linlan standing by the door and pointing at one key with her left hand.',
    'Show 林澜 standing by the door and pointing at one key with her left hand.',
]) {
    test(`stage-three wording stays usable without literal canonical spelling: ${instruction.split(' standing')[0]}`, () => {
        const result = parse(instruction);
        assert.equal(result.edit_instruction, instruction);
        assert.equal(result.preserve, '');
        assert.deepEqual(result.exclude, []);
    });
}

test('a nickname or a romanized name is not duplicated into an extra actor by normalization', () => {
    const instruction = 'Show Xiao Lan holding one key while Zhou He keeps his palm open beneath it.';
    const result = parse(instruction, ['林岚', '周禾']);
    assert.equal(result.edit_instruction, instruction);
    assert.deepEqual(Object.keys(result).sort(), ['edit_instruction', 'exclude', 'preserve', 'thought_bubble_instruction']);
});

test('colliding short names do not make the parser infer or rewrite a different identity', () => {
    for (const [instruction, names] of [
        ['Show Anna holding a key beside Ann, who keeps both hands lowered.', ['Ann', 'Anna']],
        ['Show Lin Lan holding a key beside Lin, who keeps both hands lowered.', ['林', '林岚']],
        ['Show Anna alone with one key.', ['Ann']],
    ]) {
        assert.equal(parse(instruction, names).edit_instruction, instruction);
    }
});

test('the parser does not mine exclusions for identity or prepend canonical names to a pronoun instruction', () => {
    const instruction = 'Show her left hand pointing at one key; keep her face outside the frame.';
    const result = parseAnalysisResponse(JSON.stringify({
        edit_instruction: instruction,
        preserve: '',
        exclude: ['林岚 face and torso', 'a second key'],
        thought_bubble_instruction: '',
    }), 3, { latestStory: '林岚只有左手入镜，指着一把钥匙。', expectedCharacterNames: ['林岚'] });
    assert.equal(result.edit_instruction, instruction);
    assert.deepEqual(result.exclude, ['林岚 face and torso', 'a second key']);
});

for (const empty of ['', '   ', null]) {
    test(`a truly empty edit instruction still blocks generation (${JSON.stringify(empty)})`, () => {
        assert.throws(() => parse(empty), { code: 'ANALYSIS_INVALID_SCHEMA' });
    });
}

for (const instruction of [
    'The request was blocked.',
    'I cannot generate this request.',
    '无法生成这张图片，因为违反内容政策。',
    'Invalid API key.',
]) {
    test(`an upstream refusal or error still cannot become a usable image instruction: ${instruction}`, () => {
        assert.throws(() => parse(instruction), { code: 'ANALYSIS_REJECTED' });
    });
}

test('a structured refusal remains rejected even when it also contains a plausible named instruction', () => {
    const raw = JSON.stringify({
        edit_instruction: 'Show 林岚 holding one key.',
        preserve: '',
        exclude: [],
        refusal: 'I cannot generate this request.',
    });
    assert.throws(() => parseAnalysisResponse(raw, 3, {
        latestStory: '林岚拿着钥匙。', expectedCharacterNames: ['林岚'],
    }), { code: 'ANALYSIS_REJECTED' });
});
