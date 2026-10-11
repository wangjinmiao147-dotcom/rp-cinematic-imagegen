import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAutoDetection, getChatSessionKey, resetAutoDetectState, shouldTriggerAutoDetect } from '../src/auto.js';

const noChange = JSON.stringify({ scene_changed: false, reason: 'same scene' });
const changed = JSON.stringify({ scene_changed: true, final_prompt: 'The character sits at the desk under a warm lamp.' });

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture(t) {
    resetAutoDetectState();
    t.after(() => resetAutoDetectState());
    const previousStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const saved = new Map();
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
        getItem: key => saved.get(key) ?? null,
        setItem: (key, value) => { saved.set(key, value); },
    } });
    t.after(() => {
        if (previousStorage) Object.defineProperty(globalThis, 'localStorage', previousStorage);
        else delete globalThis.localStorage;
    });
    const message = { name: 'Test', mes: 'The character sits at a desk.', swipe_id: 0 };
    const context = { characterId: 1, chatId: 'one', chat: [message], name1: 'Player', name2: 'Test' };
    const state = { context, calls: [], statuses: [], notices: [], generations: [] };
    const settings = { autoMode: true, autoCooldown: 1, autoWindow: 12, shotMode: 'snapshot', backend: 'openai',
        backendKey: 'auto-backend-private-key', llmKey: 'auto-llm-private-key', finalLlmKey: 'auto-final-private-key' };
    const options = {
        messageIndex: 0, message, messageType: 'normal',
        character: { name: 'Test', avatar: 'test.png', description: 'An adult character.' },
        settings, getContextFn: () => state.context,
        callLLMFn: (...args) => {
            const pending = deferred();
            state.calls.push({ args, pending });
            return pending.promise;
        },
        generateForMessageFn: async (...args) => { state.generations.push(args); },
        onStatusChange: (...args) => state.statuses.push(args),
        onNotify: (...args) => state.notices.push(args),
    };
    return { state, options, message, context, settings,
        diagnostics: () => JSON.parse(saved.get('rpig-recent-diagnostics') || '[]') };
}

test('automatic detection passes an abort signal and requests JSON to the LLM', async t => {
    const f = fixture(t);
    const detection = executeAutoDetection(f.options);
    assert.equal(f.state.calls.length, 1);
    const requestOptions = f.state.calls[0].args[4];
    assert.ok(requestOptions.signal instanceof AbortSignal);
    assert.equal(requestOptions.jsonMode, true);
    f.state.calls[0].pending.resolve(noChange);
    await detection;
    assert.equal(f.state.generations.length, 0);
    assert.equal(f.state.statuses.at(-1)[0], 'done');
    assert.deepEqual(f.diagnostics(), [], 'A no-change success must not replace recent failures');
});

test('reset aborts pending automatic detection even when an adapter ignores cancellation', async t => {
    const f = fixture(t);
    const detection = executeAutoDetection(f.options);
    const request = f.state.calls[0];
    resetAutoDetectState();
    assert.equal(request.args[4].signal.aborted, true);
    await detection;
    request.pending.resolve(changed);
    await Promise.resolve();
    assert.equal(f.state.generations.length, 0);
    assert.deepEqual(f.state.statuses.map(x => x[0]), ['working']);
    assert.equal(f.state.notices.length, 0);
    assert.deepEqual(f.diagnostics(), [], 'A reset cancellation must not be recorded as a failure');
});

test('old run cleanup cannot release the busy lock of a replacement run for the same chat', async t => {
    const f = fixture(t);
    const oldRun = executeAutoDetection(f.options);
    resetAutoDetectState(getChatSessionKey(f.context));
    const newRun = executeAutoDetection(f.options);
    assert.equal(f.state.calls.length, 2);
    await oldRun;
    // Use a later index so the cooldown cannot hide a missing busy lock.
    assert.equal(shouldTriggerAutoDetect(1, f.message, f.settings, f.context, 'normal'), false);
    f.state.calls[0].pending.resolve(changed);
    await Promise.resolve();
    assert.equal(f.state.generations.length, 0);
    f.state.calls[1].pending.resolve(noChange);
    await newRun;
    assert.equal(shouldTriggerAutoDetect(1, f.message, f.settings, f.context, 'normal'), true);
    assert.deepEqual(f.diagnostics(), []);
});

test('a failed stale LLM cannot overwrite another chat status or report an error', async t => {
    const f = fixture(t);
    t.mock.method(console, 'error', () => { throw new Error('stale failure must stay quiet'); });
    const detection = executeAutoDetection(f.options);
    f.state.context = { ...f.context, chatId: 'two', chat: [] };
    f.state.calls[0].pending.reject(new Error('old network failure'));
    await detection;
    assert.deepEqual(f.state.statuses.map(x => x[0]), ['working']);
    assert.equal(f.state.generations.length, 0);
    assert.deepEqual(f.diagnostics(), [], 'A stale failed run must not enter the failure history');
});

test('turning automatic mode off while analysis runs prevents image generation', async t => {
    const f = fixture(t);
    const detection = executeAutoDetection(f.options);
    f.settings.autoMode = false;
    f.state.calls[0].pending.resolve(changed);
    await detection;
    assert.equal(f.state.generations.length, 0);
    assert.equal(f.state.statuses.at(-1)[0], 'idle');
    assert.deepEqual(f.diagnostics(), []);
});

for (const [name, mutate] of [
    ['edited text', f => { f.message.mes = 'The character leaves the room.'; }],
    ['changed swipe', f => { f.message.swipe_id = 1; }],
    ['replaced chat array', f => { f.state.context = { ...f.context, chat: [...f.context.chat] }; }],
]) {
    test(`automatic detection does not generate from ${name}`, async t => {
        const f = fixture(t);
        const detection = executeAutoDetection(f.options);
        mutate(f);
        f.state.calls[0].pending.resolve(changed);
        await detection;
        assert.equal(f.state.generations.length, 0);
        assert.deepEqual(f.state.statuses.map(x => x[0]), ['working']);
        assert.deepEqual(f.diagnostics(), []);
    });
}

test('valid scene changes still queue automatic image generation', async t => {
    const f = fixture(t);
    const detection = executeAutoDetection(f.options);
    f.state.calls[0].pending.resolve(changed);
    await detection;
    assert.equal(f.state.generations.length, 1);
    assert.equal(f.state.generations[0][4].automatic, true);
    assert.equal(f.state.generations[0][4].sceneChanged, true);
    assert.deepEqual(f.diagnostics(), [], 'Successful scene detection must not displace generation errors');
});

for (const code of [undefined, 'NETWORK_FAILED']) {
    test(`current automatic analysis ${code || 'uncoded'} failure stores timed sanitized diagnostics`, async t => {
        const f = fixture(t);
        const logs = [];
        t.mock.method(console, 'error', (...args) => { logs.push(args); });
        const initialKeys = [f.settings.backendKey, f.settings.llmKey, f.settings.finalLlmKey];
        const startedAfter = Date.now();
        const detection = executeAutoDetection(f.options);
        const startedBefore = Date.now();
        f.settings.backend = 'sd';
        f.settings.backendKey = 'replacement-backend-key';
        const error = Object.assign(new Error(`Automatic failure: ${initialKeys.join(' / ')}`), code ? { code } : {});
        f.state.calls[0].pending.reject(error);
        await detection;
        const diagnostic = f.diagnostics()[0];
        assert.equal(f.diagnostics().length, 1);
        assert.equal(diagnostic.mode, 'auto-detect');
        assert.equal(diagnostic.stage, 'facts');
        assert.equal(diagnostic.status, 'failed');
        assert.equal(diagnostic.backend, 'openai', 'The record must identify the backend when this run started');
        assert.equal(diagnostic.errorCode, code || null);
        assert.match(diagnostic.requestId, /^rpig_auto_\d+_/);
        assert.ok(Date.parse(diagnostic.timestamp) >= startedAfter);
        assert.ok(Date.parse(diagnostic.timestamp) <= startedBefore);
        assert.ok(Date.parse(diagnostic.finishedAt) >= Date.parse(diagnostic.timestamp));
        assert.equal(diagnostic.error, 'Automatic failure: [REDACTED] / [REDACTED] / [REDACTED]');
        for (const key of initialKeys) {
            assert.ok(!JSON.stringify(diagnostic).includes(key));
            assert.ok(!JSON.stringify(f.state.statuses).includes(key));
            assert.ok(!JSON.stringify(logs).includes(key));
        }
        assert.equal(f.state.statuses.at(-1)[0], 'error');
        assert.equal(f.state.generations.length, 0);
    });
}

test('invalid automatic scene schema is recorded with its validation error code', async t => {
    const f = fixture(t);
    t.mock.method(console, 'error', () => {});
    const detection = executeAutoDetection(f.options);
    f.state.calls[0].pending.resolve(JSON.stringify({ scene_changed: 'yes' }));
    await detection;
    assert.equal(f.diagnostics().length, 1);
    assert.equal(f.diagnostics()[0].errorCode, 'ANALYSIS_INVALID_SCHEMA');
    assert.equal(f.diagnostics()[0].stage, 'facts');
    assert.equal(f.state.generations.length, 0);
});

test('an aborted analysis failure cannot write a diagnostic after a new same-chat run starts', async t => {
    const f = fixture(t);
    const first = executeAutoDetection(f.options);
    const oldRequest = f.state.calls[0];
    resetAutoDetectState(getChatSessionKey(f.context));
    const replacement = executeAutoDetection(f.options);
    oldRequest.pending.reject(Object.assign(new Error('old transport error'), { code: 'NETWORK_FAILED' }));
    await first;
    f.state.calls[1].pending.resolve(noChange);
    await replacement;
    assert.deepEqual(f.diagnostics(), []);
});
