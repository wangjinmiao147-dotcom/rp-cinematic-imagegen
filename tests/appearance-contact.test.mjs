import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStoryFactsPrompt, buildRelationCheckerPrompt, buildEditInstructionPrompt,
    assembleUnifiedPrompt, referenceImageEditPrompt } from '../src/prompts.js';
import { generateGeminiImage } from '../src/backends.js';
import { parseAnalysisResponse } from '../src/analysis-validation.js';

test('provider blocks stay failures with an actionable explanation instead of becoming image instructions', () => {
    const raw = 'The prompt could not be submitted. The prompt contains sensitive words that violate Google\'s Generative AI Prohibited Use policy.';
    assert.throws(() => parseAnalysisResponse(raw, 1), error => error.code === 'ANALYSIS_REJECTED'
        && /上游分析接口拒绝了当前请求/.test(error.message) && /不自动重复请求/.test(error.message));
    assert.throws(() => parseAnalysisResponse('quota exceeded', 1), error => error.code === 'ANALYSIS_REJECTED'
        && /额度或限流/.test(error.message) && !/拒绝了当前请求/.test(error.message));
    assert.throws(() => parseAnalysisResponse('invalid api key', 1), error => error.code === 'ANALYSIS_REJECTED'
        && /API 密钥/.test(error.message));
});

test('ordinary analysis has a neutral context and preserves the complete source rather than rephrasing it', () => {
    const latestStory = '洛衡用右手指着桌上的地图。绯月在墙外说话，不入镜。';
    for (const build of [buildStoryFactsPrompt, buildRelationCheckerPrompt, buildEditInstructionPrompt]) {
        const request = build({ latestStory });
        assert.ok(request.userText.includes(latestStory));
        assert.doesNotMatch(request.system, /色情|性刺激|性行为|严禁道德审查/);
        assert.match(request.system, /实际语境/);
    }
    const explicit = '成年甲已脱下外套，上身赤裸，下身仍穿长裤，伸右手叩门。';
    const request = buildEditInstructionPrompt({ latestStory: explicit,
        structuredSceneState: { persistent_states: [{ character: '甲', clothing: [
            { key: 'outfit', value: '上身赤裸，下身仍穿长裤', confirmed: true } ] }] } });
    assert.ok(request.userText.includes(explicit));
    assert.match(request.userText, /上身赤裸，下身仍穿长裤/);
    assert.match(request.system, /穿戴或未穿戴的结果按实际范围正面/);
});

test('the mapped editing request preserves natural palettes and clothing without overriding an explicit new outfit', () => {
    const edit = 'Show A wearing the newly changed blue coat, handing one bookmark to B.';
    const refs = [{ identityName: 'A', kind: 'identity-primary' }, { identityName: 'B', kind: 'identity-primary' }];
    const sent = referenceImageEditPrompt(assembleUnifiedPrompt({ editInstruction: edit, preserve: 'B\'s existing long gown.' }), refs);
    assert.ok(sent.includes(edit));
    assert.match(sent, /each person's OWN base skin palette and body proportions/);
    assert.match(sent, /original silhouette, length, layers, cut/);
    assert.match(sent, /never restore a removed garment or replace verified newer clothing/);
    assert.match(sent, /Reference image 1: A/);
    assert.match(sent, /Reference image 2: B/);
});

test('asymmetric handoff and upright staff instructions survive composition without inventing a completed contact', () => {
    for (const edit of [
        'A receives one letter with her right hand; B gives that letter with his left hand.',
        'A holds the staff upright in her right hand; B rests his left hand on his sword sheath.',
        'A reaches toward one letter with her right hand without touching it yet.',
    ]) {
        const sent = assembleUnifiedPrompt({ editInstruction: edit });
        assert.ok(sent.includes(edit));
        assert.match(sent, /anatomical body, never to the image side/);
        assert.match(sent, /preserve the stated lack of contact/);
        assert.match(sent, /specified upright object upright/);
    }
});

test('actual Gemini payload assigns palette, proportions and outfit fidelity to each matching primary only', async t => {
    let payload;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const refs = [
        { identityName: 'A', kind: 'identity-primary', dataUrl: 'data:image/png;base64,YWJj' },
        { identityName: 'B', kind: 'identity-primary', dataUrl: 'data:image/png;base64,ZGVm' },
        { kind: 'continuity', dataUrl: 'data:image/png;base64,Z2hp' },
    ];
    await generateGeminiImage({ backend: 'gemini', backendUrl: 'https://image.test/v1beta', backendModel: 'fixture-image' },
        assembleUnifiedPrompt({ editInstruction: 'Show A in her new blue coat beside B.' }), '16:9', refs);
    const parts = payload.contents[0].parts;
    assert.deepEqual(parts.filter(p => p.inlineData).map(p => p.inlineData.data), ['YWJj', 'ZGVm', 'Z2hp']);
    for (const name of ['A', 'B']) {
        const instruction = parts.find(p => p.text?.includes(`PRIMARY IDENTITY reference for ${name}`))?.text;
        assert.match(instruction, /natural skin palette/);
        assert.match(instruction, /body build and head-to-body proportions/);
        assert.match(instruction, /Unless the current story establishes a wardrobe change/);
        assert.match(instruction, /pictured pose, hand tasks, held props and background are not current story evidence/);
    }
    const continuity = parts.find(p => p.text?.includes('CONTINUITY reference only'))?.text;
    assert.doesNotMatch(continuity, /PRIMARY IDENTITY|reproduce this person's compatible outfit/i);
});

test('the actual cloud story instruction comes before rendering rules once, retaining cast, current wardrobe and scoped omissions', async t => {
    let payload;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        payload = JSON.parse(options.body);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } }] } }] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    const edit = 'A holds the purple staff upright in her right hand; B rests his left hand on the scabbard.';
    const preserve = 'A\'s newly changed blue coat.';
    const prompt = assembleUnifiedPrompt({ editInstruction: edit, preserve, exclude: ['C', 'a second staff'] })
        + '\nVISIBLE CAST (2): A, B. Each listed person has one physical body.';
    const refs = [{ identityName: 'A', kind: 'identity-primary', dataUrl: 'data:image/png;base64,YWJj' },
        { identityName: 'B', kind: 'identity-primary', dataUrl: 'data:image/png;base64,ZGVm' }];
    const diagnostics = {};
    await generateGeminiImage({ backend: 'gemini', backendUrl: 'https://image.test/v1beta', backendModel: 'fixture-image' },
        prompt, '16:9', refs, { diagnostics });
    const sent = payload.contents[0].parts.at(-1).text;
    assert.ok(sent.startsWith('MAIN SCENE TO DRAW NOW:'));
    assert.equal(sent.split(edit).length, 2);
    assert.equal(sent.split(preserve).length, 2);
    assert.ok(sent.indexOf(edit) < sent.indexOf('BODY STRUCTURE AND CONTACTS:'));
    for (const detail of ['VISIBLE CAST (2): A, B', 'C; a second staff', 'Reference image 1: A', 'Reference image 2: B']) assert.ok(sent.includes(detail));
    assert.ok(diagnostics.sentPrompt.includes(sent));
});
