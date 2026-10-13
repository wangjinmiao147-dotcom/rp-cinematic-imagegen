import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDiagnosticReport } from '../src/diagnostic-report.js';

const exportedAt = '2026-10-11T16:05:00.000Z';
const report = overrides => buildDiagnosticReport({ version: '2.9.60', exportedAt, ...overrides });
const privateMarkers = {
    story: 'PRIVATE_STORY_THE_MOON_WAS_CRIMSON',
    character: 'PRIVATE_CHARACTER_ALICE',
    prompt: 'PRIVATE_PROMPT_WIDE_SHOT_WITH_DETAILS',
    image: 'data:image/png;base64,UElWQVRFX0lNQUdFX0JZVEVT',
    model: 'PRIVATE_MODEL_FINETUNED_CHARACTER',
    url: 'https://private.example/person/PRIVATE_CHARACTER_ALICE?token=PRIVATE_API_TOKEN',
    session: 'PRIVATE_SESSION_CHARACTER_AND_CHAT',
    path: 'C:\\Users\\PRIVATE_USERNAME\\models\\secret-model.safetensors',
    key: 'PRIVATE_API_KEY_123456789',
};

function assertAbsent(result, values) {
    const strings = [];
    const visit = value => {
        if (typeof value === 'string') strings.push(value);
        else if (value && typeof value === 'object') {
            for (const [key, child] of Object.entries(value)) { strings.push(key); visit(child); }
        }
    };
    visit(result);
    for (const value of values) {
        assert.equal(strings.some(text => text.includes(value)), false, `Leaked private value: ${value}`);
    }
}

test('default error reports export operational metadata while excluding story, identities, images and raw server errors', () => {
    const m = privateMarkers;
    const raw = {
        requestId: m.session, status: 'failed', stage: 'image-request', errorCode: 'NETWORK_FAILED',
        timestamp: '2026-10-11T16:00:00.000Z', finishedAt: '2026-10-11T16:01:00.000Z',
        referenceCount: 2, requestedSize: [1024, 1024], outputSize: [1024, 1024],
        error: Object.values(m).join(' '), stack: m.path,
        step1Raw: m.story, step1Parsed: { current_scene: m.story },
        step2Raw: m.character, step2Parsed: { characters: [m.character] },
        step3Raw: m.prompt, step3Parsed: { final_prompt: m.prompt },
        sentPrompt: m.prompt, sourceUrl: m.url, sourceSessionKey: m.session,
        references: [{ identityId: m.session, identityName: m.character, label: m.character, url: m.url, dataUrl: m.image, hash: m.key }],
        referenceFailures: [{ ref: m.url, reason: m.story }], conflicts: [m.character],
        appearanceChanges: [{ character: m.character, state: m.story }],
        psychologicalReactions: [{ character: m.character, thought: m.story }],
        castReferenceMatches: [{ actorName: m.character, label: m.character }],
        localFallbackStages: [{ stage: 'facts', reason: m.story }],
        engine: { job_id: m.session, model: m.model, path: m.path, message: m.story },
        bridge: { version: m.key, model: m.model, root: m.path, capabilities: { output: m.image } },
        authorization: m.key, backendKey: m.key, unknownFutureField: m.story,
    };
    const result = report({ diagnostics: [raw] });
    assert.equal(result.privacy.includesTextDiagnostics, false);
    assert.equal(result.privacy.includesImages, false);
    assert.equal(result.records.length, 1);
    assert.equal(result.records[0].status, 'failed');
    assert.equal(result.records[0].stage, 'image-request');
    assert.equal(result.records[0].errorCode, 'NETWORK_FAILED');
    assert.equal(result.records[0].referenceCount, 2);
    assert.deepEqual(result.records[0].requestedSize, [1024, 1024]);
    assert.equal(typeof result.records[0].summary, 'string');
    assertAbsent(result, Object.values(m));
    assert.equal(Object.hasOwn(result.records[0], 'textDiagnostics'), false);
    assert.equal(Object.hasOwn(result.records[0], 'requestId'), false);
    assert.equal(Object.hasOwn(result.records[0], 'error'), false);
});

test('configuration reports omit endpoints, model names, workflow bodies, anchors and all API credentials', () => {
    const m = privateMarkers;
    const result = report({ settings: {
        backend: 'openai', backendUrl: m.url, backendModel: m.model, backendKey: m.key,
        llmUrl: m.url, llmModel: m.model, llmKey: m.key, finalLlmKey: m.key,
        characterAnchors: { [m.character]: m.story }, comfyWorkflow: m.prompt,
        customPrompt: m.prompt, outputPath: m.path, unknownSetting: m.story,
        stylePreset: 'reference', shotMode: 'snapshot', imageSize: '16:9', promptFormat: 'natural',
        autoMode: true, llmFallbackEnabled: false,
    } });
    assert.equal(result.configuration.backend, 'openai');
    assert.equal(result.configuration.imageSize, '16:9');
    assertAbsent(result, Object.values(m));
});

test('arbitrary strings cannot bypass the whitelist through enum fields or an uppercase error code', () => {
    const marker = 'PRIVATE_ROLE_NAME_AND_TOKEN_ABC123';
    const result = report({ settings: {
        backend: marker, stylePreset: marker, shotMode: marker, promptFormat: marker,
        imageSize: marker, llmSource: marker, finalLlmSource: marker,
    }, diagnostics: [{ status: marker, mode: marker, stage: marker, errorCode: marker, summary: marker }] });
    assertAbsent(result, [marker]);
});

test('malformed numeric and date fields are omitted without copying their text or nested objects', () => {
    const marker = 'PRIVATE_NUMERIC_OR_TIME_CONTENT';
    const result = report({ diagnostics: [{
        status: 'failed', timestamp: marker, finishedAt: marker, durationMs: marker,
        referenceCount: marker, requestedSize: [marker, 512], outputSize: [512, { secret: marker }],
        referenceSelection: { supplied: marker, sent: Infinity, generated: NaN },
        errorCode: 'NETWORK_FAILED', referenceFailures: [{ secret: marker }],
    }] });
    assertAbsent(result, [marker]);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('Infinity'), false);
    assert.equal(serialized.includes('NaN'), false);
});

test('default report ignores arbitrary and cyclic nested metadata instead of serializing it', () => {
    const raw = { status: 'failed', errorCode: 'NETWORK_FAILED' };
    raw.engine = raw;
    raw.unknownFutureField = raw;
    const result = report({ diagnostics: [raw] });
    assert.doesNotThrow(() => JSON.stringify(result));
    assert.equal(result.records.length, 1);
    assert.equal(Object.hasOwn(raw, 'engine'), true, 'Reporting must not mutate saved diagnostic metadata');
    assert.equal(Object.hasOwn(result.records[0], 'engine'), false);
});

test('malformed and empty diagnostic collections remain exportable without disclosing primitive values', () => {
    const marker = 'PRIVATE_PRIMITIVE_DIAGNOSTIC';
    for (const diagnostics of [undefined, null, marker, {}, [null, marker, 42, [], {}]]) {
        const result = report({ diagnostics });
        assert.doesNotThrow(() => JSON.stringify(result));
        assert.ok(Array.isArray(result.records));
        assertAbsent(result, [marker]);
    }
});

test('opt-in text never includes configured credentials, their percent-encoded values, URLs or inline images', () => {
    const key = 'private+key/with?encoded=parts&123456';
    const encodedKey = encodeURIComponent(key);
    const llmKey = 'private-key-with-"quote\\backslash-987654';
    const escapedLlmKey = JSON.stringify(llmKey).slice(1, -1);
    const error = `HTTP diagnostic ${key} ${encodedKey} ${llmKey} ${escapedLlmKey} `
        + 'https://username:password@private.example/path/secret?api_key=something '
        + `${privateMarkers.image} data:image/svg+xml,%3Csvg%3E%3C%2Fsvg%3E `
        + 'blob:https://private.example/1234-5678';
    const result = report({ includeText: true, settings: { backendKey: key, llmKey }, diagnostics: [{
        textRedactionVersion: 1, status: 'failed', errorCode: 'NETWORK_FAILED', error,
    }] });
    assert.equal(result.privacy.includesTextDiagnostics, true);
    assert.equal(result.privacy.includesImages, false);
    assertAbsent(result, [key, encodedKey, llmKey, escapedLlmKey, 'username:password',
        'private.example', privateMarkers.image, 'data:image/svg+xml', 'blob:https:']);
    assert.ok(JSON.stringify(result).includes('[REDACTED]') || JSON.stringify(result).includes('[URL OMITTED]'));
});

test('text opt-in does not export arbitrary future fields or image and identity metadata', () => {
    const marker = 'PRIVATE_UNSELECTED_METADATA';
    const result = report({ includeText: true, diagnostics: [{ textRedactionVersion: 1, status: 'failed', error: 'Network unavailable',
        unknownFutureField: marker, sourceSessionKey: marker, sourceUrl: marker,
        references: [{ identityName: marker, label: marker, dataUrl: privateMarkers.image }],
        engine: { message: marker }, bridge: { root: marker },
    }] });
    assertAbsent(result, [marker, privateMarkers.image]);
});

test('untrusted plugin version values cannot become an additional text disclosure field', () => {
    const marker = 'PRIVATE_VERSION_WITH_AUTHORIZATION_VALUE';
    const result = report({ version: marker, diagnostics: [] });
    assertAbsent(result, [marker]);
});

test('opt-in text removes URLs whose slashes were escaped by an upstream JSON serializer', () => {
    const privateUrl = 'https:\\/\\/username:password@private.example\\/secret\\/reference.png?key=abc123';
    const result = report({ includeText: true, diagnostics: [{ textRedactionVersion: 1, status: 'failed', error: `Download failed: ${privateUrl}` }] });
    assertAbsent(result, ['private.example', 'username:password', 'reference.png']);
});

test('opt-in text removes alternate percent and mixed JSON escape representations of configured keys', () => {
    const key = 'private+key/with?encoded=parts&123456';
    const lowerPercent = encodeURIComponent(key).replace(/%[A-F\d]{2}/g, value => value.toLowerCase());
    const slashEscape = key.replace(/\//g, '\\/');
    const unicodeEscape = key.replace('i', '\\u0069');
    const result = report({ includeText: true, settings: { backendKey: key }, diagnostics: [{
        textRedactionVersion: 1, status: 'failed', error: `Server returned ${lowerPercent} ${slashEscape} ${unicodeEscape}`,
    }] });
    assertAbsent(result, [key, lowerPercent, slashEscape, unicodeEscape]);
});

test('malformed Unicode credential values cannot prevent the user from exporting a report', () => {
    const key = 'private-key-\uD800-secret12345';
    const result = report({ includeText: true, settings: { backendKey: key }, diagnostics: [{
        textRedactionVersion: 1, status: 'failed', error: `Invalid credential: ${key}`,
    }] });
    assertAbsent(result, [key]);
});

test('array accessors are not executed when building reports from malformed collections', () => {
    let accessed = false;
    const diagnostics = [];
    Object.defineProperty(diagnostics, '0', { configurable: true, get() { accessed = true; throw new Error('private getter'); } });
    const result = report({ diagnostics });
    assert.equal(accessed, false);
    assert.ok(Array.isArray(result.records));
});

test('new workflow and reference errors export known codes and counts without model or identity text', () => {
    for (const code of ['COMFY_PRESET_UNAVAILABLE', 'REFERENCE_BUDGET_EXCEEDED', 'CHARACTER_LORA_STRENGTH_INVALID']) {
        const result = report({ diagnostics: [{ status: 'failed', errorCode: code, loraCount: 1,
            referenceSelection: { supplied: 4, omitted: [{ identityName: 'private-person', label: 'private-model' }] },
            characterLoras: [{ name: 'private-model', identityId: 'private-person' }] }] });
        assert.equal(result.records[0].errorCode, code);
        assert.equal(result.records[0].loraCount, 1);
        assert.equal(result.records[0].referenceSuppliedCount, 4);
        assert.equal(result.records[0].referenceOmittedCount, 1);
        assertAbsent(result, ['private-person', 'private-model']);
    }
});
