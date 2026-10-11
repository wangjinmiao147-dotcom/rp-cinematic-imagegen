import test from 'node:test';
import assert from 'node:assert/strict';
import { downloadDiagnosticReport, buildDiagnosticReport } from '../src/diagnostic-report.js';
import { persistGenerationDiagnostics, readRecentGenerationDiagnostics } from '../src/diagnostics.js';

function browserFixture({ failClick = false } = {}) {
    const state = { blobs: [], anchors: [], removed: 0, revoked: [], timers: [] };
    return { state, browser: {
        Blob,
        document: {
            body: { appendChild(anchor) { state.anchors.push(anchor); } },
            createElement(type) {
                assert.equal(type, 'a');
                return { style: {}, click() { if (failClick) throw new Error('Download denied'); }, remove() { state.removed++; } };
            },
        },
        urlApi: { createObjectURL(blob) { state.blobs.push(blob); return 'blob:local-report'; },
            revokeObjectURL(url) { state.revoked.push(url); } },
        setTimeout(callback, delay) { state.timers.push({ callback, delay }); },
    } };
}

test('download builds a local JSON Blob, merges chat failures and cleans up browser resources', async () => {
    const f = browserFixture();
    const privateText = 'Private story and private-backend-key';
    const diagnostic = { requestId: 'download-request-one', status: 'failed', mode: 'story', stage: 'image-request',
        errorCode: 'NETWORK_FAILED', timestamp: '2026-10-12T00:00:00.000Z', finishedAt: '2026-10-12T00:00:03.000Z',
        error: privateText, step1Raw: privateText };
    const result = downloadDiagnosticReport({ version: '2.9.61', settings: { backend: 'openai', backendKey: 'private-backend-key' },
        chat: [{ mes: privateText, extra: { rpigLastAttempt: diagnostic, rpigInfo: { diagnostics: diagnostic } } }], browser: f.browser });
    assert.equal(result.recordCount, 1);
    assert.equal(result.failedCount, 1);
    assert.match(result.filename, /^rpig-error-report-v2\.9\.61-\d{8}T\d{6}Z\.json$/);
    assert.equal(f.state.blobs[0].type, 'application/json;charset=utf-8');
    const content = await f.state.blobs[0].text();
    const report = JSON.parse(content);
    assert.equal(report.records[0].durationMs, 3000);
    assert.equal(report.records[0].errorCode, 'NETWORK_FAILED');
    assert.equal(report.privacy.includesTextDiagnostics, false);
    assert.doesNotMatch(content, /Private story|private-backend-key|download-request-one/);
    assert.equal(f.state.anchors[0].download, result.filename);
    assert.equal(f.state.removed, 1);
    assert.equal(f.state.revoked.length, 0);
    assert.equal(f.state.timers[0].delay, 1000);
    f.state.timers[0].callback();
    assert.deepEqual(f.state.revoked, ['blob:local-report']);
});

test('failed downloads still remove the anchor and release the object URL', () => {
    const f = browserFixture({ failClick: true });
    assert.throws(() => downloadDiagnosticReport({ version: '2.9.61', browser: f.browser }), /Download denied/);
    assert.equal(f.state.removed, 1);
    f.state.timers[0].callback();
    assert.deepEqual(f.state.revoked, ['blob:local-report']);
});

test('denied local storage keeps the recent diagnostic available for export', async () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalWarn = console.warn;
    try {
        console.warn = () => {};
        Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Storage disabled'); } });
        persistGenerationDiagnostics({ requestId: 'memory-request', mode: 'character-sheet', status: 'failed', errorCode: 'REFERENCE_AVATAR_FAILED' });
        const recent = readRecentGenerationDiagnostics();
        assert.equal(recent.storageStatus, 'unavailable');
        assert.equal(recent.records[0].requestId, 'memory-request');
        const f = browserFixture();
        downloadDiagnosticReport({ version: '2.9.61', browser: f.browser });
        const report = JSON.parse(await f.state.blobs[0].text());
        assert.equal(report.records[0].errorCode, 'REFERENCE_AVATAR_FAILED');
        assert.equal(report.storageStatus, 'unavailable');
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
        else delete globalThis.localStorage;
        console.warn = originalWarn;
    }
});

test('broken saved records cannot stop report construction or consume an unbounded report', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    try {
        for (const raw of ['invalid JSON', '{"unexpected":true}', '[null,42,"PRIVATE",{}]', 'x'.repeat(1000001)]) {
            Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => raw } });
            assert.doesNotThrow(() => readRecentGenerationDiagnostics());
        }
        const report = buildDiagnosticReport({ version: '2.9.61', includeText: true,
            diagnostics: Array.from({ length: 500 }, () => ({ textRedactionVersion: 1, status: 'failed', error: 'x'.repeat(100001) })) });
        assert.equal(report.records.length, 10);
        assert.ok(JSON.stringify(report).length < 10000);
    } finally {
        if (original) Object.defineProperty(globalThis, 'localStorage', original);
        else delete globalThis.localStorage;
    }
});
