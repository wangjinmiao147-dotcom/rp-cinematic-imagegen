import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createAbortError, isAbortError, throwIfAborted, scrubSensitiveText } from '../src/utils.js';
import * as taskContext from '../src/task-context.js';
import { redactDiagnosticCredentials } from '../src/diagnostic-text.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');
const diagnosticSource = await readFile(new URL('../src/diagnostics.js', import.meta.url), 'utf8');

function between(text, start, end) {
    const from = text.indexOf(start);
    const to = text.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Production source markers must exist: ${start}`);
    return text.slice(from, to);
}

// Run the production queue, cancellation handlers and local-detail task body.
// Only the host UI and expensive generation endpoints are replaced with adapters.
const queueSource = [
    between(source, 'let rpigGenerating = false;', 'const rpigDetailEditorControllers'),
    between(source, 'function cancelCurrentGeneration(', 'function reviewFinalPrompt('),
    between(source, 'function generateForMessage(', 'async function executeGenerationTask('),
    between(source, 'async function generateCharacterSheetFlow(', 'async function renderCharacterSheetFlow('),
    diagnosticSource.replace(/^import[^\n]+\n/gm, '').replace(/^export /gm, ''),
    `globalThis.api = {
        generateForMessage, generateCharacterSheetFlow, queueLocalDetailEdit, processGenerationQueue,
        cancelCurrentGeneration, cancelQueuedGeneration, clearQueuedGenerations,
        getState: () => ({ active: rpigActiveTask, waiting: [...rpigGenerationQueue], generating: rpigGenerating }),
    };`,
].join('\n');

const png = 'data:image/png;base64,YWJj';
const plain = value => JSON.parse(JSON.stringify(value));

function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function fixture() {
    const settings = { backend: 'gemini', backendUrl: 'http://127.0.0.1:7861', backendModel: 'qwen-image',
        backendKey: 'private-backend-key', llmKey: 'private-llm-key', finalLlmKey: 'private-final-key', imageSize: '512:288' };
    const originalDiagnostic = { requestId: 'ordinary-original', status: 'success', stage: 'complete', references: ['original'] };
    const rpigInfo = { outputUrl: '/original.png', prompt: 'Original story prompt', diagnostics: originalDiagnostic };
    const message = { mes: 'Current story.', extra: { rpigInfo, media: [{ url: '/original.png' }] } };
    const context = { chatId: 'chat-one', chat: [message, { mes: 'Second story.' }] };
    const snapshot = { sourceUrl: '/original.png', sessionKey: 'chat-one', messageIndex: 0 };
    const values = new Map([['rpig-recent-diagnostics', JSON.stringify([originalDiagnostic])]]);
    const state = { calls: [], events: [], statuses: [], activeRequests: 0, peakRequests: 0, uiUpdates: 0 };

    function begin(kind, label, signal) {
        const pending = deferred();
        const call = { kind, label, signal, ...pending };
        state.calls.push(call);
        state.events.push(`start:${label}`);
        state.activeRequests++;
        state.peakRequests = Math.max(state.peakRequests, state.activeRequests);
        const onAbort = () => pending.reject(signal.reason || createAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        call.finish = () => {
            signal.removeEventListener('abort', onAbort);
            state.activeRequests--;
            state.events.push(`finish:${label}`);
        };
        return call;
    }

    const dependencies = {
        AbortController, createAbortError, isAbortError, throwIfAborted, scrubSensitiveText, redactDiagnosticCredentials, ...taskContext,
        getContext: () => context,
        getSettings: () => settings,
        getCurrentCharacter: () => ({ name: 'Test', avatar: 'test.png' }),
        updateGenerationQueueUI: () => { state.uiUpdates++; },
        setGenStatus: (phase, text) => state.statuses.push({ phase, text }),
        toastr: { info: () => {} },
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        executeGenerationTask: async task => {
            const call = begin('ordinary', `ordinary-${task.messageIndex}`, task.controller.signal);
            try { return await call.promise; } finally { call.finish(); }
        },
        renderCharacterSheetFlow: async (_options, { signal }) => {
            const call = begin('character-sheet', 'sheet', signal);
            try { return await call.promise; } finally { call.finish(); }
        },
        generateLocalDetailEdit: async (passedSettings, instruction, patchDataUrl, options) => {
            const call = begin('local-detail', 'detail', options.signal);
            Object.assign(call, { settings: passedSettings, instruction, patchDataUrl, options });
            try {
                const result = await call.promise;
                Object.assign(options.diagnostics, { status: 'success', stage: 'complete',
                    note: `Backend ${passedSettings.backendKey}`, dataUrl: patchDataUrl, authorization: passedSettings.backendKey });
                return result;
            } finally { call.finish(); }
        },
    };
    runInNewContext(queueSource, dependencies, { filename: 'production-local-detail-queue.js' });
    const api = dependencies.api;
    return { api, state, settings, snapshot, message, context, rpigInfo, originalDiagnostic,
        diagnostics: () => JSON.parse(values.get('rpig-recent-diagnostics')),
        enqueueDetail: (signal, instruction = 'Refine the selected visible contour.') => api.queueLocalDetailEdit({
            signal, instruction, patchDataUrl: png, region: { x: 120, y: 80, width: 25, height: 25 },
        }, settings, snapshot),
    };
}

function assertIdle(f) {
    assert.equal(f.api.getState().active, null);
    assert.equal(f.api.getState().waiting.length, 0);
    assert.equal(f.api.getState().generating, false);
    assert.equal(f.state.activeRequests, 0);
}

test('independent detail editing uses only its patch and produces separate sanitized diagnostics', async () => {
    const f = fixture();
    const before = structuredClone(f.message);
    const originalSettings = structuredClone(f.settings);
    const editor = new AbortController();
    const resultPromise = f.enqueueDetail(editor.signal);
    const call = f.state.calls[0];
    assert.equal(call.kind, 'local-detail');
    assert.equal(call.patchDataUrl, png);
    assert.equal(call.instruction, 'Refine the selected visible contour.');
    assert.deepEqual(Array.from(call.options.patchSize), [256, 256]);
    assert.strictEqual(call.signal, f.api.getState().active.controller.signal);
    assert.notStrictEqual(call.signal, editor.signal);
    call.resolve({ dataUrl: png, model: 'qwen', usedPrompt: call.instruction });
    const result = await resultPromise;

    assert.equal(result.dataUrl, png);
    assert.equal(result.diagnostics.mode, 'local-detail-edit');
    assert.equal(result.diagnostics.sourceUrl, f.snapshot.sourceUrl);
    assert.equal(result.diagnostics.sourceSessionKey, f.snapshot.sessionKey);
    assert.deepEqual(plain(result.diagnostics.region), { x: 120, y: 80, width: 25, height: 25 });
    assert.match(result.diagnostics.requestId, /^rpig_detail_\d+_1$/);
    assert.equal(result.diagnostics.status, 'success');
    assert.equal(result.diagnostics.backend, 'gemini');
    assert.equal(result.diagnostics.stage, 'complete');
    assert.equal(result.diagnostics.errorCode, null);
    assert.ok(Number.isFinite(Date.parse(result.diagnostics.timestamp)));
    assert.ok(Number.isFinite(Date.parse(result.diagnostics.finishedAt)));
    assert.equal('dataUrl' in result.diagnostics, false);
    assert.equal('authorization' in result.diagnostics, false);
    assert.ok(!JSON.stringify(result.diagnostics).includes(f.settings.backendKey));
    const stored = f.diagnostics();
    assert.equal(stored[0].requestId, result.diagnostics.requestId);
    assert.ok(stored[0].finishedAt);
    assert.equal(stored[0].timestamp, result.diagnostics.timestamp);
    assert.equal(stored[0].finishedAt, result.diagnostics.finishedAt);
    assert.deepEqual(stored[1], f.originalDiagnostic);
    assert.strictEqual(f.message.extra.rpigInfo, f.rpigInfo);
    assert.strictEqual(f.message.extra.rpigInfo.diagnostics, f.originalDiagnostic);
    assert.deepEqual(f.message, before);
    assert.deepEqual(f.settings, originalSettings);
    assert.equal(f.state.calls.length, 1);
    assertIdle(f);
});

test('ordinary generation and local detail edits share one FIFO queue without overlapping requests', async () => {
    const f = fixture();
    const first = f.api.generateForMessage(0);
    const detail = f.enqueueDetail(new AbortController().signal);
    const last = f.api.generateForMessage(1);
    await f.api.processGenerationQueue();
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.api.getState().waiting.length, 2);
    f.state.calls[0].resolve({ success: true });
    await first;
    assert.equal(f.state.calls[1].kind, 'local-detail');
    assert.equal(f.state.calls.length, 2);
    f.state.calls[1].resolve({ dataUrl: png });
    await detail;
    assert.equal(f.state.calls[2].label, 'ordinary-1');
    f.state.calls[2].resolve({ success: true });
    await last;
    assert.equal(f.state.peakRequests, 1);
    assert.deepEqual(f.state.events, ['start:ordinary-0', 'finish:ordinary-0', 'start:detail',
        'finish:detail', 'start:ordinary-1', 'finish:ordinary-1']);
    assertIdle(f);
});

test('aborting a queued editor removes only that detail task and preserves the active ordinary task', async () => {
    const f = fixture();
    const ordinary = f.api.generateForMessage(0);
    const editor = new AbortController();
    const detail = f.enqueueDetail(editor.signal);
    const rejection = assert.rejects(detail, { name: 'AbortError' });
    editor.abort(createAbortError('Editor closed'));
    await rejection;
    assert.equal(f.api.getState().waiting.length, 0);
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.calls[0].signal.aborted, false);
    assert.equal(f.api.getState().active.messageIndex, 0);
    f.state.calls[0].resolve({ success: true });
    await ordinary;
    assert.equal(f.diagnostics().length, 1, 'A removed task must not request or persist model diagnostics');
    assertIdle(f);
});

test('the shared queue cancel button cancels a queued detail edit while retaining the other queued generation', async () => {
    const f = fixture();
    const ordinary = f.api.generateForMessage(0);
    const detail = f.enqueueDetail(new AbortController().signal);
    const last = f.api.generateForMessage(1);
    const rejection = assert.rejects(detail, { name: 'AbortError' });
    f.api.cancelQueuedGeneration(f.api.getState().waiting[0].id);
    await rejection;
    assert.equal(f.api.getState().waiting.length, 1);
    assert.equal(f.api.getState().waiting[0].messageIndex, 1);
    assert.equal(f.state.calls[0].signal.aborted, false);
    f.state.calls[0].resolve({ success: true });
    await ordinary;
    assert.equal(f.state.calls[1].label, 'ordinary-1');
    f.state.calls[1].resolve({ success: true });
    await last;
    assert.equal(f.state.calls.some(call => call.kind === 'local-detail'), false);
    assertIdle(f);
});

test('clearing the mixed waiting queue resolves ordinary cancellation and rejects detail cancellation without aborting the active task', async () => {
    const f = fixture();
    const ordinary = f.api.generateForMessage(0);
    const detail = f.enqueueDetail(new AbortController().signal);
    const last = f.api.generateForMessage(1);
    const rejection = assert.rejects(detail, { name: 'AbortError' });
    f.api.clearQueuedGenerations();
    await rejection;
    assert.deepEqual(plain(await last), { cancelled: true, queued: true });
    assert.equal(f.api.getState().waiting.length, 0);
    assert.equal(f.state.calls[0].signal.aborted, false);
    f.state.calls[0].resolve({ success: true });
    await ordinary;
    assert.equal(f.state.calls.length, 1);
    assertIdle(f);
});

for (const trigger of ['current-task button', 'editor signal']) {
    test(`cancelling an active detail edit through the ${trigger} forwards abort and releases the queue`, async () => {
        const f = fixture();
        const editor = new AbortController();
        const detail = f.enqueueDetail(editor.signal);
        const last = f.api.generateForMessage(1);
        const call = f.state.calls[0];
        const rejection = assert.rejects(detail, { name: 'AbortError' });
        if (trigger === 'current-task button') f.api.cancelCurrentGeneration();
        else editor.abort(createAbortError('Editor closed'));
        assert.equal(call.signal.aborted, true);
        await rejection;
        assert.equal(f.state.calls[1].label, 'ordinary-1');
        assert.equal(f.state.calls[1].signal.aborted, false);
        assert.equal(f.diagnostics()[0].mode, 'local-detail-edit');
        assert.equal(f.diagnostics()[0].status, 'cancelled');
        assert.equal(f.diagnostics()[0].backend, 'gemini');
        assert.equal(f.diagnostics()[0].stage, 'region-edit');
        assert.equal(f.diagnostics()[0].errorCode, createAbortError().code || null);
        f.state.calls[1].resolve({ success: true });
        await last;
        assert.equal(f.state.peakRequests, 1);
        assertIdle(f);
    });
}

test('a failed local detail request preserves the original and releases the queue for the next ordinary task', async () => {
    const f = fixture();
    const before = structuredClone(f.message);
    const detail = f.enqueueDetail(new AbortController().signal);
    const last = f.api.generateForMessage(1);
    const failure = new Error(`Backend failed: ${f.settings.backendKey}`);
    const rejection = assert.rejects(detail, error => error === failure);
    f.state.calls[0].reject(failure);
    await rejection;
    assert.equal(f.state.calls[1].label, 'ordinary-1');
    assert.equal(f.state.calls[1].signal.aborted, false);
    const diagnostic = f.diagnostics()[0];
    assert.equal(diagnostic.status, 'failed');
    assert.equal(diagnostic.mode, 'local-detail-edit');
    assert.equal(diagnostic.error, 'Backend failed: [REDACTED]');
    assert.equal(diagnostic.backend, 'gemini');
    assert.equal(diagnostic.stage, 'region-edit');
    assert.equal(diagnostic.errorCode, null);
    assert.ok(Number.isFinite(Date.parse(diagnostic.timestamp)));
    assert.ok(diagnostic.finishedAt);
    assert.deepEqual(f.message, before);
    assert.strictEqual(f.message.extra.rpigInfo, f.rpigInfo);
    assert.deepEqual(f.diagnostics()[1], f.originalDiagnostic);
    f.state.calls[1].resolve({ success: true });
    await last;
    assert.equal(f.state.peakRequests, 1);
    assertIdle(f);
});

test('an already-aborted detail request cannot enter the queue or issue a model request', () => {
    const f = fixture();
    const editor = new AbortController();
    editor.abort(createAbortError());
    assert.throws(() => f.enqueueDetail(editor.signal), { name: 'AbortError' });
    assert.equal(f.state.calls.length, 0);
    assert.equal(f.diagnostics().length, 1);
    assertIdle(f);
});

test('a coded local-detail failure persists its error code with task timing and backend', async () => {
    const f = fixture();
    const detail = f.enqueueDetail(new AbortController().signal);
    const error = Object.assign(new Error('Unsupported editor protocol'), { code: 'LOCAL_DETAIL_BACKEND_UNSUPPORTED' });
    const rejection = assert.rejects(detail, failure => failure === error);
    f.state.calls[0].reject(error);
    await rejection;
    const diagnostic = f.diagnostics()[0];
    assert.equal(diagnostic.errorCode, 'LOCAL_DETAIL_BACKEND_UNSUPPORTED');
    assert.equal(diagnostic.status, 'failed');
    assert.equal(diagnostic.stage, 'region-edit');
    assert.equal(diagnostic.backend, 'gemini');
    assert.ok(Date.parse(diagnostic.finishedAt) >= Date.parse(diagnostic.timestamp));
    assertIdle(f);
});

test('character-sheet success persists a separate completed diagnostic without altering story metadata', async () => {
    const f = fixture();
    const sheet = f.api.generateCharacterSheetFlow({ type: 'three_views' });
    const image = { imageUrl: '/saved-sheet.png', type: 'three_views' };
    f.state.calls[0].resolve(image);
    assert.strictEqual(await sheet, image);
    const diagnostic = f.diagnostics()[0];
    assert.match(diagnostic.requestId, /^rpig_sheet_\d+_1$/);
    assert.equal(diagnostic.mode, 'character-sheet');
    assert.equal(diagnostic.status, 'success');
    assert.equal(diagnostic.stage, 'complete');
    assert.equal(diagnostic.backend, 'gemini');
    assert.equal(diagnostic.errorCode, null);
    assert.ok(Date.parse(diagnostic.finishedAt) >= Date.parse(diagnostic.timestamp));
    assert.deepEqual(f.diagnostics()[1], f.originalDiagnostic);
    assert.strictEqual(f.message.extra.rpigInfo.diagnostics, f.originalDiagnostic);
    assertIdle(f);
});

for (const code of [undefined, 'GEMINI_IMAGE_HTTP']) {
    test(`character-sheet ${code || 'uncoded'} failure is persisted with sanitized error metadata`, async () => {
        const f = fixture();
        const sheet = f.api.generateCharacterSheetFlow({ type: 'three_views' });
        const error = Object.assign(new Error(`Sheet backend failed: ${f.settings.backendKey}`), code ? { code } : {});
        const rejection = assert.rejects(sheet, failure => failure === error);
        f.state.calls[0].reject(error);
        await rejection;
        const diagnostic = f.diagnostics()[0];
        assert.equal(diagnostic.mode, 'character-sheet');
        assert.equal(diagnostic.status, 'failed');
        assert.equal(diagnostic.stage, 'image-request');
        assert.equal(diagnostic.backend, 'gemini');
        assert.equal(diagnostic.errorCode, code || null);
        assert.equal(diagnostic.error, 'Sheet backend failed: [REDACTED]');
        assert.ok(Date.parse(diagnostic.finishedAt) >= Date.parse(diagnostic.timestamp));
        assert.equal(f.state.statuses.at(-1).text, diagnostic.error);
        assertIdle(f);
    });
}

test('a queued message shifted by deletion cannot generate for its replacement index', async () => {
    const f = fixture();
    f.context.chat.push({ mes: 'Replacement at index one.' });
    const first = f.api.generateForMessage(0);
    const waiting = f.api.generateForMessage(1);
    f.context.chat.splice(1, 1);
    f.state.calls[0].resolve({ success: true });
    await first;
    assert.equal((await waiting).stale, true);
    assert.equal(f.state.calls.length, 1);
    assertIdle(f);
});

test('editing history while a task waits invalidates its captured analysis source', async () => {
    const f = fixture();
    const first = f.api.generateForMessage(0);
    const waiting = f.api.generateForMessage(1);
    f.context.chat[0].mes = 'An edited earlier scene.';
    f.state.calls[0].resolve({ success: true });
    await first;
    assert.equal((await waiting).stale, true);
    assert.equal(f.state.calls.length, 1);
    assertIdle(f);
});

test('character sheets share the ordinary queue and current-task cancellation', async () => {
    const f = fixture();
    const first = f.api.generateForMessage(0);
    const sheet = f.api.generateCharacterSheetFlow({ type: 'three_views' });
    const last = f.api.generateForMessage(1);
    const rejection = assert.rejects(sheet, { name: 'AbortError' });
    assert.equal(f.state.calls.length, 1);
    f.state.calls[0].resolve({ success: true });
    await first;
    assert.equal(f.state.calls[1].kind, 'character-sheet');
    f.api.cancelCurrentGeneration();
    await rejection;
    const diagnostic = f.diagnostics()[0];
    assert.equal(diagnostic.mode, 'character-sheet');
    assert.equal(diagnostic.status, 'cancelled');
    assert.equal(diagnostic.stage, 'image-request');
    assert.equal(diagnostic.backend, 'gemini');
    assert.equal(diagnostic.errorCode, createAbortError().code || null);
    assert.ok(Date.parse(diagnostic.finishedAt) >= Date.parse(diagnostic.timestamp));
    assert.equal(f.state.calls[2].kind, 'ordinary');
    f.state.calls[2].resolve({ success: true });
    await last;
    assert.equal(f.state.peakRequests, 1);
    assertIdle(f);
});

test('a queued character sheet cannot start in a replacement chat', async () => {
    const f = fixture();
    const first = f.api.generateForMessage(0);
    const sheet = f.api.generateCharacterSheetFlow();
    const rejection = assert.rejects(sheet, { name: 'AbortError' });
    f.context.chat = [{ mes: 'A new chat.' }];
    f.context.chatId = 'new-chat';
    f.state.calls[0].resolve({ success: true });
    await first;
    await rejection;
    assert.equal(f.state.calls.length, 1);
    assertIdle(f);
});
