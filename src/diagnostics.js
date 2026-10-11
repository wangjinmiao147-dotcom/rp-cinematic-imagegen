import { scrubSensitiveText } from './utils.js';
import { redactDiagnosticCredentials } from './diagnostic-text.js';

const DIAGNOSTIC_STORAGE_KEY = 'rpig-recent-diagnostics';
let recentDiagnostics = [];

function recentRecords(value) {
    return Array.isArray(value) ? value.filter(item => item && typeof item === 'object' && !Array.isArray(item)).slice(0, 5) : [];
}

// Memory remains available when a browser denies or fills localStorage.
export function readRecentGenerationDiagnostics() {
    let saved = [], storageStatus = 'unavailable';
    try {
        const storage = globalThis.localStorage;
        if (storage) {
            const raw = storage.getItem(DIAGNOSTIC_STORAGE_KEY);
            if (raw && raw.length > 1000000) storageStatus = 'invalid';
            else {
                saved = recentRecords(JSON.parse(raw || '[]'));
                storageStatus = 'available';
            }
        }
    } catch { storageStatus = 'unavailable'; }
    const records = [];
    const seen = new Set();
    for (const record of [...recentDiagnostics, ...saved]) {
        const id = typeof record.requestId === 'string' ? record.requestId : record;
        if (seen.has(id)) continue;
        seen.add(id);
        records.push(record);
        if (records.length === 5) break;
    }
    return { records, storageStatus };
}

export function sanitizeDiagnostics(diagnostic, keys = []) {
    const clean = JSON.parse(JSON.stringify(diagnostic, (key, value) => {
        if (/^(?:dataUrl|inlineData|authorization|backendKey|llmKey|finalLlmKey)$/i.test(key)) return undefined;
        if (typeof value !== 'string') return value;
        return redactDiagnosticCredentials(value, keys).replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE OMITTED]');
    }));
    if (clean && typeof clean === 'object' && !Array.isArray(clean)) clean.textRedactionVersion = 1;
    return clean;
}

export function persistGenerationDiagnostics(diagnostic, keys = []) {
    const clean = sanitizeDiagnostics(diagnostic, keys);
    recentDiagnostics = [clean, ...recentDiagnostics.filter(d => d.requestId !== clean.requestId)].slice(0, 5);
    try {
        const storage = globalThis.localStorage;
        if (storage) {
            let previous;
            try { previous = JSON.parse(storage.getItem(DIAGNOSTIC_STORAGE_KEY) || '[]'); } catch { previous = []; }
            let items = [clean, ...recentRecords(previous).filter(d => d.requestId !== clean.requestId)].slice(0, 5);
            while (items.length > 1 && JSON.stringify(items).length > 1000000) items.pop();
            storage.setItem(DIAGNOSTIC_STORAGE_KEY, JSON.stringify(items));
        }
    } catch (error) { console.warn('[RP-Diag] 本机诊断存储失败', scrubSensitiveText(error.message, keys)); }
    return clean;
}
