// Used both when saving diagnostics and when explicitly exporting their text.
// Redact at capture time so a later configuration change cannot reveal old keys.
export function normalizeDiagnosticText(value) {
    let text = value;
    for (let pass = 0; pass < 3; pass++) {
        text = text.replace(/\\u([\da-f]{4})|\\x([\da-f]{2})|\\\//gi,
            (match, unicode, hex) => unicode || hex ? String.fromCharCode(parseInt(unicode || hex, 16)) : '/')
            .replace(/(?:%[\da-f]{2})+/gi, match => {
                try { return decodeURIComponent(match); } catch { return '[ENCODED TEXT OMITTED]'; }
            }).replace(/\\\\/g, '\\');
    }
    return text;
}

export function redactDiagnosticCredentials(value, keys = []) {
    let text = normalizeDiagnosticText(value);
    for (const key of keys) {
        if (typeof key !== 'string' || !key) continue;
        const variants = new Set([key, normalizeDiagnosticText(key), normalizeDiagnosticText(JSON.stringify(key).slice(1, -1))]);
        for (const variant of variants) {
            if (variant) text = text.split(variant).join('[REDACTED]');
        }
    }
    return text.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, '[REDACTED]')
        .replace(/((?:api[_-]?key|access[_-]?token|authorization|password|secret|token)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[REDACTED]')
        .replace(/\bsk-[a-z0-9_-]{8,}/gi, '[REDACTED]');
}
