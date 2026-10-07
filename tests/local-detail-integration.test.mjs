import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { createAbortError, isAbortError, throwIfAborted, scrubSensitiveText } from '../src/utils.js';

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
    diagnosticSource.replace(/^import[^\n]+\n/m, '').replace(/^export /gm, ''),
    `globalThis.api = {
        generateForMessage, queueLocalDetailEdit, processGenerationQueue,
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
    const context = { chatId: 'chat-one', chat: [message] };
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
        AbortController, createAbortError, isAbortError, throwIfAborted, scrubSensitiveText,
        getContext: () => context,
        updateGenerationQueueUI: () => { state.uiUpdates++; },
        setGenStatus: (phase, text) => state.statuses.push({ phase, text }),
        toastr: { info: () => {} },
        localStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) },
        executeGenerationTask: async task => {
            const call = begin('ordinary', `ordinary-${task.messageIndex}`, task.controller.signal);
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
    return { api, state, settings, snapshot, message, rpigInfo, originalDiagnostic,
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
    assert.equal('dataUrl' in result.diagnostics, false);
    assert.equal('authorization' in result.diagnostics, false);
    assert.ok(!JSON.stringify(result.diagnostics).includes(f.settings.backendKey));
    const stored = f.diagnostics();
    assert.equal(stored[0].requestId, result.diagnostics.requestId);
    assert.ok(stored[0].finishedAt);
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
