import test from 'node:test';
import assert from 'node:assert/strict';
import { persistGenerationDiagnostics, sanitizeDiagnostics } from '../src/diagnostics.js';
import { buildDiagnosticReport } from '../src/diagnostic-report.js';

function stringsIn(value) {
    if (typeof value === 'string') return [value];
    if (!value || typeof value !== 'object') return [];
    return Object.entries(value).flatMap(([key, child]) => [key, ...stringsIn(child)]);
}
function assertAbsent(value, secrets) {
    const strings = stringsIn(value);
    for (const secret of secrets) {
        assert.equal(strings.some(text => text.includes(secret)), false, `Credential survived redaction: ${secret}`);
    }
}

test('encoded credentials are removed when diagnostics are saved, before the user rotates API keys', () => {
    const previousKey = 'old-private+key/12345~987654';
    const encoded = encodeURIComponent(previousKey);
    const lowercaseEncoded = encoded.replace(/%[A-F\d]{2}/g, text => text.toLowerCase());
    const slashEscaped = previousKey.replace(/\//g, '\\/');
    const unicodeEscaped = previousKey.replace('i', '\\u0069');
    const raw = { requestId: 'rotated-percent-fixture', status: 'failed', errorCode: 'NETWORK_FAILED',
        error: `Service rejected credential ${encoded} ${lowercaseEncoded} ${slashEscaped} ${unicodeEscaped}`,
        step1Raw: `Credential echoed: ${encoded}`, sentPrompt: `Credential echoed: ${slashEscaped}` };
    const saved = persistGenerationDiagnostics(raw, [previousKey]);
    assert.equal(saved.textRedactionVersion, 1);
    assertAbsent(saved, [previousKey, encoded, lowercaseEncoded, slashEscaped, unicodeEscaped]);
    assert.equal(raw.error.includes(encoded), true, 'Sanitization must not mutate its input');
    const report = buildDiagnosticReport({ version: '2.9.61', diagnostics: [saved],
        settings: { backendKey: 'new-fixture-key' }, includeText: true });
    assertAbsent(report, [previousKey, encoded, lowercaseEncoded, slashEscaped, unicodeEscaped]);
    assert.ok(report.records[0].textDiagnostics.error.includes('Service rejected credential'));
    assert.equal(Object.hasOwn(report.records[0], 'textDiagnosticsOmitted'), false);
});

test('JSON-escaped historical credentials stay hidden after LLM settings are changed', () => {
    const previousKey = 'old-llm-key-with-"quote\\backslash/987654';
    const jsonEscaped = JSON.stringify(previousKey).slice(1, -1);
    const saved = persistGenerationDiagnostics({ requestId: 'rotated-json-fixture', status: 'failed',
        error: `Upstream diagnostic ${jsonEscaped}`, step2Raw: `Raw diagnostic ${jsonEscaped}` }, [previousKey]);
    assert.equal(saved.textRedactionVersion, 1);
    assertAbsent(saved, [previousKey, jsonEscaped]);
    const report = buildDiagnosticReport({ version: '2.9.61', diagnostics: [saved],
        settings: { llmKey: 'replacement-fixture-key' }, includeText: true });
    assertAbsent(report, [previousKey, jsonEscaped]);
    assert.ok(report.records[0].textDiagnostics.error.includes('Upstream diagnostic'));
});

test('legacy diagnostics without a verified text redaction policy cannot export raw text', () => {
    const previousKey = 'old-private+key/12345~987654';
    const marker = 'PRIVATE_LEGACY_STORY_OR_PROMPT';
    const raw = { status: 'failed', errorCode: 'NETWORK_FAILED', error: encodeURIComponent(previousKey),
        step1Raw: marker, sentPrompt: marker, referenceCount: 2 };
    const report = buildDiagnosticReport({ version: '2.9.61', diagnostics: [raw],
        settings: { backendKey: 'new-fixture-key' }, includeText: true });
    assert.equal(report.records[0].textDiagnosticsOmitted, 'legacy-unverified');
    assert.equal(Object.hasOwn(report.records[0], 'textDiagnostics'), false);
    assert.equal(report.records[0].errorCode, 'NETWORK_FAILED');
    assert.equal(report.records[0].referenceCount, 2);
    assertAbsent(report, [previousKey, encodeURIComponent(previousKey), marker]);
});

test('only the exact supported numeric policy marker enables opt-in diagnostic text', () => {
    for (const policy of [undefined, null, true, '1', 0, 2, {}, []]) {
        const report = buildDiagnosticReport({ version: '2.9.61', includeText: true,
            diagnostics: [{ status: 'failed', textRedactionVersion: policy, error: 'PRIVATE_UNVERIFIED_DIAGNOSTIC' }] });
        assert.equal(report.records[0].textDiagnosticsOmitted, 'legacy-unverified');
        assert.equal(Object.hasOwn(report.records[0], 'textDiagnostics'), false);
        assertAbsent(report, ['PRIVATE_UNVERIFIED_DIAGNOSTIC']);
    }
});

test('persisting fresh diagnostics replaces an untrusted policy marker with the completed redaction version', () => {
    const key = 'legacy-api+key/12345678';
    const saved = sanitizeDiagnostics({ status: 'failed', textRedactionVersion: 'attacker',
        error: `Credential ${encodeURIComponent(key)}` }, [key]);
    assert.equal(saved.textRedactionVersion, 1);
    assertAbsent(saved, [key, encodeURIComponent(key)]);
});
