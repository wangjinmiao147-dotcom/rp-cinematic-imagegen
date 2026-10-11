import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { scrubSensitiveText } from '../src/utils.js';

const source = await readFile(new URL('../index.js', import.meta.url), 'utf8');

function between(start, end) {
    const from = source.indexOf(start);
    const to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0 && to > from, `Production source markers must exist: ${start}`);
    return source.slice(from, to);
}

const handlerSource = between('async function exportErrorReport()', 'function loadSettings()');
const reportUiSource = between('    const reportCard = createCard(', '    container.append(grid);');
const floatingBinding = source.split('\n').find(line => line.includes("$('#rpig-export-error-report').on('click'"));
assert.ok(floatingBinding, 'Floating export must use the production handler');

// Run the actual handler and report controls with host adapters. The download
// boundary is intercepted here; report serialization/browser downloads have
// separate module tests, and these tests must never contact an image backend.
function fixture({ includeText, result = { filename: 'report.json', recordCount: 3, failedCount: 1 }, failure } = {}) {
    const settings = { backendKey: 'secret-backend-key', llmKey: 'secret-llm-key', finalLlmKey: 'secret-final-key' };
    if (includeText !== undefined) settings.errorReportIncludeText = includeText;
    const chat = [{ mes: 'Private story' }];
    const state = { calls: [], toasts: [], saves: 0, elements: [] };
    const controls = new Map();
    const adapter = html => {
        if (controls.has(html)) return controls.get(html);
        const control = {
            html, properties: {}, handlers: {}, children: [],
            prop(name, value) {
                if (arguments.length === 1) return this.properties[name];
                this.properties[name] = value;
                return this;
            },
            on(event, callback) { this.handlers[event] = callback; return this; },
            append(...items) { this.children.push(...items); return this; },
        };
        controls.set(html, control);
        state.elements.push(control);
        return control;
    };
    const host = {
        getSettings: () => settings,
        getContext: () => ({ chat }),
        scrubSensitiveText,
        pluginVersion: '2.9.61',
        downloadDiagnosticReport: async options => {
            state.calls.push(options);
            if (failure) throw failure;
            return result;
        },
        toastr: Object.fromEntries(['success', 'info', 'error'].map(type => [type, (message, title, options) => {
            state.toasts.push({ type, message, title, options });
        }])),
        fetch: () => { throw new Error('Report export must not send network requests'); },
        $: adapter,
        s: settings,
        createCard: (title, icon) => ({ card: adapter(title), body: adapter(icon) }),
        switchRow: (label, control, hint) => ({ label, control, hint }),
        row: (label, control, hint) => ({ label, control, hint }),
        grid: adapter('grid'),
        saveSettingsDebounced: () => { state.saves++; },
    };
    runInNewContext(`${handlerSource}\n${reportUiSource}\n${floatingBinding}\nglobalThis.runReport = exportErrorReport;`, host);
    return {
        settings, chat, state,
        runReport: host.runReport,
        checkbox: state.elements.find(element => element.html.includes('rpig-error-report-include-text')),
        settingsButton: state.elements.find(element => element.html.includes('rpig-settings-export-error-report')),
        floatingButton: controls.get('#rpig-export-error-report'),
    };
}

test('fresh installations default to a report without story or prompt text', async () => {
    assert.match(between('const defaultSettings = {', 'function getSettings()'), /errorReportIncludeText:\s*false/);
    const f = fixture();
    assert.equal(f.checkbox.prop('checked'), false);
    assert.strictEqual(f.settingsButton.handlers.click, f.runReport);
    assert.strictEqual(f.floatingButton.handlers.click, f.runReport);
    await f.settingsButton.handlers.click();
    const exported = f.state.calls[0];
    assert.equal(exported.includeText, false);
    assert.equal(exported.version, '2.9.61');
    assert.strictEqual(exported.settings, f.settings);
    assert.strictEqual(exported.chat, f.chat);
    assert.equal(f.state.toasts[0].type, 'success');
    assert.match(f.state.toasts[0].message, /3 条诊断.*1 条失败/);
});

test('only explicitly selecting the text checkbox enables text diagnostics for either export button', async () => {
    const f = fixture();
    f.checkbox.prop('checked', true);
    f.checkbox.handlers.change();
    assert.equal(f.settings.errorReportIncludeText, true);
    assert.equal(f.state.saves, 1);
    await f.floatingButton.handlers.click();
    assert.equal(f.state.calls[0].includeText, true);
    f.checkbox.prop('checked', false);
    f.checkbox.handlers.change();
    await f.settingsButton.handlers.click();
    assert.equal(f.state.calls[1].includeText, false);
    assert.equal(f.state.saves, 2);
});

for (const value of ['true', 1, {}, false]) {
    test(`a non-boolean saved text option (${typeof value}) stays disabled`, async () => {
        const f = fixture({ includeText: value });
        assert.equal(f.checkbox.prop('checked'), false);
        await f.runReport();
        assert.equal(f.state.calls[0].includeText, false);
    });
}

test('a report without diagnostics explains that it contains environment information', async () => {
    const f = fixture({ result: { filename: 'report.json', recordCount: 0, failedCount: 0 } });
    assert.equal((await f.runReport()).recordCount, 0);
    assert.equal(f.state.calls.length, 1);
    assert.equal(f.state.toasts[0].type, 'info');
    assert.match(f.state.toasts[0].message, /暂无生成诊断.*环境报告.*再次导出/);
});

test('download failures show a readable recovery message with credentials redacted and HTML escaped', async () => {
    const f = fixture({ failure: new Error('<img src=x onerror=alert(1)> secret-backend-key secret-llm-key secret-final-key Bearer abcdefghijk') });
    assert.equal(await f.runReport(), null);
    const toast = f.state.toasts[0];
    assert.equal(toast.type, 'error');
    assert.match(toast.message, /错误报告导出失败.*允许下载.*重试/);
    assert.equal(toast.options.escapeHtml, true, 'The host must render any error details as text');
    assert.doesNotMatch(toast.message, /secret-backend-key|secret-llm-key|secret-final-key|abcdefghijk/);
});
