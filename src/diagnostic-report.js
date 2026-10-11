import { readRecentGenerationDiagnostics } from './diagnostics.js';
import { redactDiagnosticCredentials } from './diagnostic-text.js';

const MAX_RECORDS = 10;
const MAX_TEXT_LENGTH = 4000;
const ENUMS = {
    backend: ['openai', 'gemini', 'sd', 'comfyui', 'tavern-sd'],
    stylePreset: ['reference', 'character', 'anime', 'realistic'],
    shotMode: ['snapshot', 'portrait'], promptFormat: ['natural', 'tags', 'auto'],
    imageSize: ['16:9', '2.39:1', '1:1', '9:16'],
    llmSource: ['tavern', 'custom', 'local'], finalLlmSource: ['tavern', 'custom', 'local', 'same'],
    status: ['running', 'failed', 'cancelled', 'success'],
    mode: ['story', 'local-detail-edit', 'character-sheet', 'auto-detect'],
    stage: ['start', 'facts', 'relations', 'instruction', 'references', 'image-request', 'persist-image', 'complete', 'region-edit'],
};
// Codes must be enumerated: accepting arbitrary uppercase strings could export names or credentials.
const ERROR_CODES = new Set(`ANALYSIS_EMPTY ANALYSIS_REJECTED ANALYSIS_INVALID_JSON ANALYSIS_INVALID_SCHEMA
ANALYSIS_NO_FRAME ANALYSIS_NO_SUBJECT ANALYSIS_EMPTY_CAST ANALYSIS_UNRESOLVED_CONFLICT ANALYSIS_IDENTITY_MISMATCH
REQUEST_TIMEOUT NETWORK_FAILED DETAIL_PATCH_SIZE_INVALID DETAIL_LOCAL_BACKEND_REQUIRED DETAIL_PATCH_REQUIRED
REFERENCE_MISSING PRIMARY_REFERENCE_READ_FAILED REFERENCE_DOWNLOAD_FAILED REFERENCE_INVALID REFERENCE_IDENTITY_CONFLICT
REFERENCE_LIMIT IDENTITY_REFERENCE_REQUIRED REFERENCE_BACKEND_UNSUPPORTED MULTI_REFERENCE_UNSUPPORTED
CHAT_IMAGE_HTTP CHAT_IMAGE_EMPTY EDITS_EMPTY_RESPONSE EDITS_UNSUPPORTED EDITS_NOT_FOUND EDITS_HTTP
GEMINI_IMAGE_PROTOCOL_MISMATCH BRIDGE_VERSION_MISMATCH QWEN_IMAGE_HTTP GEMINI_IMAGE_HTTP QWEN_IMAGE_INVALID GEMINI_IMAGE_INVALID
COMFY_PROMPT_NODE_CONFLICT COMFY_NEGATIVE_NODE_INVALID COMFY_REFERENCE_NODE_INVALID COMFY_REFERENCE_UPLOAD_HTTP
COMFY_REFERENCE_UPLOAD_EMPTY COMFY_EXECUTION_FAILED COMFY_IMAGE_EMPTY REFERENCE_AVATAR_FAILED USER_REFERENCE_REQUIRED
CAST_REFERENCE_REQUIRED TEMP_IMAGE_DOWNLOAD_FAILED IMAGE_DOWNLOAD_HTTP IMAGE_DOWNLOAD_INVALID
GALLERY_STORAGE_BLOCKED GALLERY_STORAGE_READ_FAILED GALLERY_STORAGE_WRITE_FAILED GALLERY_CHAT_SAVE_FAILED
REFERENCE_STORAGE_BLOCKED REFERENCE_STORAGE_READ_FAILED REFERENCE_STORAGE_WRITE_FAILED
LOCAL_DETAIL_SOURCE_CHANGED LOCAL_DETAIL_SOURCE_INVALID LOCAL_DETAIL_GALLERY_SAVE_FAILED LOCAL_DETAIL_SAVE_INVALID
LOCAL_DETAIL_CHAT_SAVE_FAILED LOCAL_DETAIL_FILE_SAVE_FAILED SCENE_RESIZE_UNAVAILABLE SCENE_RESIZE_DECODE SCENE_RENDER_SIZE_MISMATCH
REFERENCE_IMPORT_INVALID REFERENCE_ARCHIVE_INVALID REFERENCE_ARCHIVE_TOO_LARGE`.split(/\s+/));

function own(object, key) {
    if (!object || typeof object !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(object, key)?.value; } catch { return undefined; }
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function arrayItems(value, limit, reverse = false) {
    if (!Array.isArray(value)) return [];
    const length = own(value, 'length');
    if (!Number.isSafeInteger(length) || length < 0) return [];
    const items = [];
    for (let offset = 0; offset < Math.min(length, limit); offset++) {
        items.push(own(value, String(reverse ? length - 1 - offset : offset)));
    }
    return items;
}
function enumValue(key, value) { return ENUMS[key].includes(value) ? value : 'unknown'; }
function integer(value, max = 10000) { return Number.isInteger(value) && value >= 0 && value <= max ? value : undefined; }
function isoDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d[:]\d\d[:]\d\d(?:\.\d{3})?Z$/.test(value)) return undefined;
    const time = Date.parse(value);
    return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
function versionValue(value) { return typeof value === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(value) ? value : 'unknown'; }
function sizeValue(value) {
    if (!Array.isArray(value) || value.length !== 2) return undefined;
    const width = integer(own(value, '0'), 16384), height = integer(own(value, '1'), 16384);
    return width > 0 && height > 0 ? [width, height] : undefined;
}
function count(value) { return Array.isArray(value) ? Math.min(value.length, 10000) : undefined; }
function summary(status, code) {
    if (status === 'success') return '生成成功';
    if (status === 'cancelled') return '任务已取消或来源已变化';
    if (status === 'running') return '任务尚未完成';
    if (code === 'NETWORK_FAILED') return '网络请求失败，请检查服务连接和浏览器 Network';
    if (code === 'REQUEST_TIMEOUT') return '请求超时';
    if (code.startsWith('ANALYSIS_')) return '剧情分析结果未通过校验';
    if (/REFERENCE|EDITS/.test(code)) return '参考图读取、校验或编辑请求失败';
    if (/STORAGE|SAVE|DOWNLOAD|RESIZE/.test(code)) return '图片读取或保存失败';
    if (code !== 'UNKNOWN_ERROR') return '图片后端或请求配置检查失败，请结合错误码排查';
    return '错误未提供已知错误码；可选择附带文字诊断进一步排查';
}

function textKeys(settings) {
    return ['backendKey', 'llmKey', 'finalLlmKey'].map(key => own(settings, key))
        .filter(value => typeof value === 'string' && value.length > 0 && value.length <= 100000);
}
function safeText(value, keys) {
    if (typeof value !== 'string') return undefined;
    if (value.length > 100000) return '[TEXT OMITTED: TOO LARGE]';
    // Redact before truncating, including keys echoed with JSON or URL escaping.
    let text = redactDiagnosticCredentials(value, keys);
    text = text.replace(/(?:blob:|data:)[^\s"'<>]+/gi, '[IMAGE OMITTED]')
        .replace(/(?:https?:\/\/|file:\/\/|www\.)[^\s"'<>]+/gi, '[URL OMITTED]')
        .replace(/(?:https?%3a%2f%2f|blob%3a|data%3a)[^\s"'<>]+/gi, '[URL OMITTED]')
        .replace(/\b[A-Z]:\\[^\r\n"<>]+/gi, '[PATH OMITTED]');
    return text.slice(0, MAX_TEXT_LENGTH);
}

function reportRecord(raw, index, includeText, keys) {
    const status = enumValue('status', own(raw, 'status'));
    const suppliedCode = own(raw, 'errorCode');
    const errorCode = ERROR_CODES.has(suppliedCode) ? suppliedCode : status === 'failed' ? 'UNKNOWN_ERROR' : null;
    const startedAt = isoDate(own(raw, 'startedAt')) || isoDate(own(raw, 'timestamp'));
    const finishedAt = isoDate(own(raw, 'finishedAt'));
    const elapsed = startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : undefined;
    const result = {
        index, status, mode: enumValue('mode', own(raw, 'mode')), stage: enumValue('stage', own(raw, 'stage')),
        backend: enumValue('backend', own(raw, 'backend')), errorCode, summary: summary(status, errorCode || ''),
        startedAt, finishedAt, durationMs: integer(elapsed, 86400000),
        referenceCount: integer(own(raw, 'referenceCount')),
        referenceFailureCount: count(own(raw, 'referenceFailures')), conflictCount: count(own(raw, 'conflicts')),
        requestedSize: sizeValue(own(raw, 'requestedSize')), outputSize: sizeValue(own(raw, 'outputSize')),
    };
    const selection = own(raw, 'referenceSelection');
    if (object(selection)) result.referenceSelection = Object.fromEntries(['supplied', 'sent', 'generated']
        .map(key => [key, integer(own(selection, key))]).filter(([, value]) => value !== undefined));
    const fallback = own(raw, 'localFallbackStages');
    if (Array.isArray(fallback)) result.localFallbackStages = arrayItems(fallback, 10).map(item => enumValue('stage', own(item, 'stage')));
    if (includeText && own(raw, 'textRedactionVersion') === 1) {
        result.textDiagnostics = {};
        for (const field of ['error', 'step1Raw', 'step2Raw', 'step3Raw', 'assembledPrompt', 'confirmedPrompt', 'sentPrompt', 'negativePrompt']) {
            const text = safeText(own(raw, field), keys);
            if (text) result.textDiagnostics[field] = text;
        }
    } else if (includeText) {
        result.textDiagnosticsOmitted = 'legacy-unverified';
    }
    return Object.fromEntries(Object.entries(result).filter(([, value]) => value !== undefined));
}

// Construct from selected scalar fields only; never serialize arbitrary saved metadata.
export function buildDiagnosticReport({ diagnostics = [], settings = {}, version, includeText = false, exportedAt } = {}) {
    const configuration = {};
    for (const key of ['backend', 'stylePreset', 'shotMode', 'promptFormat', 'imageSize', 'llmSource', 'finalLlmSource']) {
        configuration[key] = enumValue(key, own(settings, key));
    }
    for (const key of ['autoMode', 'llmFallbackEnabled']) {
        const value = own(settings, key);
        if (typeof value === 'boolean') configuration[key] = value;
    }
    const textEnabled = includeText === true;
    const records = arrayItems(diagnostics, 100).filter(object).slice(0, MAX_RECORDS);
    return {
        schemaVersion: 1, plugin: 'rp-cinematic-imagegen', version: versionValue(version),
        exportedAt: isoDate(exportedAt) || new Date().toISOString(),
        privacy: { includesTextDiagnostics: textEnabled, includesImages: false }, configuration,
        records: records.map((raw, index) => reportRecord(raw, index + 1, textEnabled, textKeys(settings))),
    };
}

function collectChatDiagnostics(chat) {
    if (!Array.isArray(chat)) return [];
    const records = [];
    for (const message of arrayItems(chat, 20, true)) {
        const extra = own(message, 'extra');
        for (const record of [own(extra, 'rpigLastAttempt'), own(own(extra, 'rpigInfo'), 'diagnostics')]) {
            if (object(record)) records.push(record);
        }
    }
    return records;
}
function mergeDiagnostics(records) {
    const seen = new Set();
    return records.filter(record => {
        const id = own(record, 'requestId');
        const identity = typeof id === 'string' && id ? id : record;
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    }).sort((a, b) => (Date.parse(isoDate(own(b, 'timestamp')) || isoDate(own(b, 'finishedAt'))) || 0)
        - (Date.parse(isoDate(own(a, 'timestamp')) || isoDate(own(a, 'finishedAt'))) || 0)).slice(0, MAX_RECORDS);
}

export function downloadDiagnosticReport({ version, settings, chat, includeText = false, browser = {} } = {}) {
    const recent = readRecentGenerationDiagnostics();
    const report = buildDiagnosticReport({ version, settings, includeText,
        diagnostics: mergeDiagnostics([...recent.records, ...collectChatDiagnostics(chat)]) });
    report.storageStatus = recent.storageStatus;
    const filename = `rpig-error-report-v${report.version}-${report.exportedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')}.json`;
    const doc = browser.document || globalThis.document;
    const urlApi = browser.urlApi || globalThis.URL;
    const BlobType = browser.Blob || globalThis.Blob;
    if (!doc?.createElement || !doc.body?.appendChild || !urlApi?.createObjectURL || !urlApi?.revokeObjectURL || !BlobType) {
        throw new Error('当前浏览器无法下载错误报告');
    }
    const blob = new BlobType([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = urlApi.createObjectURL(blob);
    let anchor;
    try {
        anchor = doc.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.style.display = 'none';
        doc.body.appendChild(anchor);
        anchor.click();
    } finally {
        anchor?.remove();
        // Let the browser consume the URL before releasing it (including mobile browsers).
        (browser.setTimeout || globalThis.setTimeout)(() => urlApi.revokeObjectURL(url), 1000);
    }
    return { filename, recordCount: report.records.length,
        failedCount: report.records.filter(record => record.status === 'failed').length };
}
