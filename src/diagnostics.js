import { scrubSensitiveText } from './utils.js';

export function sanitizeDiagnostics(diagnostic, keys = []) {
    return JSON.parse(JSON.stringify(diagnostic, (key, value) => {
        if (/^(?:dataUrl|inlineData|authorization|backendKey|llmKey|finalLlmKey)$/i.test(key)) return undefined;
        if (typeof value !== 'string') return value;
        return scrubSensitiveText(value, keys).replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/g, '[IMAGE OMITTED]');
    }));
}

export function persistGenerationDiagnostics(diagnostic, keys = []) {
    const clean = sanitizeDiagnostics(diagnostic, keys);
    try {
        const storage = globalThis.localStorage;
        if (storage) {
            let previous;
            try { previous = JSON.parse(storage.getItem('rpig-recent-diagnostics') || '[]'); } catch { previous = []; }
            let items = [clean, ...(Array.isArray(previous) ? previous : []).filter(d => d.requestId !== clean.requestId)].slice(0, 5);
            while (items.length > 1 && JSON.stringify(items).length > 1000000) items.pop();
            storage.setItem('rpig-recent-diagnostics', JSON.stringify(items));
        }
    } catch (error) { console.warn('[RP-Diag] 本机诊断存储失败', scrubSensitiveText(error.message, keys)); }
    return clean;
}
