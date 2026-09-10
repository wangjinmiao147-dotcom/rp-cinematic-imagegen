// ============================================================
// RP 电影配图 - 工具函数模块
// ============================================================

/**
 * 转义 HTML 特殊字符，防止 XSS 注入
 * @param {*} value 
 * @returns {string}
 */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    const str = String(value);
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * 剥离文本中的 HTML 标签
 * @param {string} html 
 * @returns {string}
 */
export function stripHtml(html) {
    if (typeof html !== 'string') return '';
    if (typeof document !== 'undefined' && document.createElement) {
        const div = document.createElement('div');
        div.innerHTML = html;
        return (div.textContent || div.innerText || '').trim();
    }
    // Node.js / 测试环境 fallback
    return html
        .replace(/<\/?(?:br|p|div|tr|li|h[1-6])[^>]*>/gi, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

export function hasConfiguredGenerationSettings(settings) {
    if (!settings || typeof settings !== 'object') return false;
    return [
        settings.backendUrl,
        settings.backendKey,
        settings.backendModel,
        settings.llmUrl,
        settings.llmKey,
        settings.llmModel,
        settings.comfyWorkflow,
    ].some(value => typeof value === 'string' && value.trim())
        || Boolean(settings.characterAnchors && Object.keys(settings.characterAnchors).length);
}

/**
 * 从 LLM 返回文本中安全提取 JSON 对象
 * @param {string} text 
 * @returns {object|null}
 */
export function extractJson(text) {
    if (typeof text !== 'string') return null;
    let t = text.replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return null;
    const jsonStr = t.slice(start, end + 1);

    try {
        return JSON.parse(jsonStr);
    } catch {
        // 正则降级解析
        const get = (key) => {
            const m = jsonStr.match(new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 'i'));
            if (m && m[1] !== undefined) {
                try {
                    return JSON.parse(`"${m[1]}"`);
                } catch {
                    return m[1];
                }
            }
            return undefined;
        };
        const sceneMatch = /"scene_changed"\s*:\s*(true|false)/i.exec(jsonStr);
        return {
            scene_changed: sceneMatch ? sceneMatch[1].toLowerCase() === 'true' : undefined,
            reason: get('reason'),
            style: get('style'),
            shot: get('shot'),
            scene_anchor: get('scene_anchor'),
            final_prompt: get('final_prompt'),
            avoid: get('avoid'),
        };
    }
}

/**
 * 规范化后端 URL，去除多余末尾斜杠
 * @param {string} raw 
 * @param {string} [fallback] 
 * @returns {string}
 */
export function normalizeBackendUrl(raw, fallback = '') {
    let url = (raw || fallback || '').trim().replace(/\/+$/, '');
    if (!url) {
        throw new Error('未配置后端接口地址');
    }
    return url;
}

/**
 * 脱敏错误文本与日志，防止 API Key、Token 泄露到前端/控制台
 * @param {string} text 
 * @param {string[]} [sensitiveKeys] 
 * @returns {string}
 */
export function scrubSensitiveText(text, sensitiveKeys = []) {
    if (typeof text !== 'string') return String(text || '');
    let result = text;

    // 清理 URL 中的 key 参数
    result = result.replace(/([?&](?:key|token|api_key|access_token|signature|sig|X-Amz-[\w-]+)=)[^& \n\r"']+/gi, '$1[REDACTED]');
    // 清理 Bearer token
    result = result.replace(/(Bearer\s+)[A-Za-z0-9_\-\.]{6,}/gi, '$1[REDACTED]');

    // 清理显式传入的 key
    for (const k of sensitiveKeys) {
        if (typeof k === 'string' && k.trim().length >= 4) {
            const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            result = result.replace(new RegExp(escaped, 'g'), '[REDACTED]');
        }
    }
    return result;
}

export class RpigError extends Error {
    constructor(code, message, details = {}) {
        super(`[${code}] ${message}`);
        this.name = 'RpigError';
        this.code = code;
        this.details = details;
    }
}

export function upstreamErrorMessage(body, sensitiveKeys = []) {
    let message = body;
    try {
        const parsed = JSON.parse(body);
        message = parsed?.error?.message || parsed?.message || body;
    } catch { /* Non-JSON error bodies are also useful diagnostics. */ }
    return scrubSensitiveText(String(message), sensitiveKeys).slice(0, 500);
}

export function safeRequestUrl(raw) {
    try { const url = new URL(raw, globalThis.location?.href || 'http://localhost'); return url.origin + url.pathname; }
    catch { return '[无效地址]'; }
}

export function requestFailure(error, url, stage, sensitiveKeys = []) {
    if (isAbortError(error) || error instanceof RpigError) return error;
    const detail = scrubSensitiveText(error?.message || String(error), sensitiveKeys);
    const endpoint = safeRequestUrl(url);
    const timeout = error?.name === 'TimeoutError';
    return new RpigError(timeout ? 'REQUEST_TIMEOUT' : 'NETWORK_FAILED',
        `${stage}：${endpoint}；${detail}。${timeout ? '请求超时。' : '浏览器未提供可读的 HTTP 响应；可能是 CORS、DNS/TLS、混合内容或网络连接问题，须结合 Console / Network 确认，不能据此判断接口不支持 edits。'}`,
        { stage, endpoint });
}

/**
 * Blob 转 Base64 Data URL
 * @param {Blob} blob 
 * @returns {Promise<string>}
 */
export async function blobToDataUrl(blob) {
    if (typeof FileReader !== 'undefined') {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }
    // Node.js 环境兼容
    if (blob && typeof blob.arrayBuffer === 'function') {
        const buffer = Buffer.from(await blob.arrayBuffer());
        const mime = blob.type || 'image/png';
        return `data:${mime};base64,${buffer.toString('base64')}`;
    }
    throw new Error('FileReader / Blob arrayBuffer 不可用');
}

/**
 * Base64 Data URL 转 Blob
 * @param {string} dataUrl 
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
    if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) {
        throw new Error('无效的 Data URL');
    }
    const parts = dataUrl.split(',');
    const mimeMatch = parts[0].match(/:(.*?);/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    const binary = atob(parts[1]);
    const array = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        array[i] = binary.charCodeAt(i);
    }
    return new Blob([array], { type: mime });
}

/**
 * 请求网络 URL 并转换为 Data URL
 * @param {string} url 
 * @param {number} [timeoutMs=30000] 
 * @returns {Promise<string>}
 */
export function createAbortError(message = '任务已取消') {
    try {
        return new DOMException(message, 'AbortError');
    } catch {
        const error = new Error(message);
        error.name = 'AbortError';
        return error;
    }
}

export function isAbortError(error) {
    return error?.name === 'AbortError' || /任务已取消|aborted|aborterror/i.test(error?.message || '');
}

export function throwIfAborted(signal) {
    if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : createAbortError();
    }
}

export function timeoutSignal(ms) {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
        return AbortSignal.timeout(ms);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
        const error = new Error('请求超时'); error.name = 'TimeoutError';
        controller.abort(error);
    }, ms);
    timer?.unref?.();
    return controller.signal;
}

export function combineAbortSignals(...signals) {
    const validSignals = signals.filter(Boolean);
    if (validSignals.length === 0) return undefined;
    if (validSignals.length === 1) return validSignals[0];
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
        return AbortSignal.any(validSignals);
    }

    const controller = new AbortController();
    for (const signal of validSignals) {
        if (signal.aborted) {
            controller.abort(signal.reason);
            break;
        }
        signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
    }
    return controller.signal;
}

export function raceWithAbort(promise, signal) {
    if (!signal) return Promise.resolve(promise);
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : createAbortError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(
            value => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            error => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}

/**
 * 请求网络 URL 并转换为 Data URL
 * @param {string} url
 * @param {number|object} [timeoutOrOptions=30000]
 * @returns {Promise<string>}
 */
export async function fetchToDataUrl(url, timeoutOrOptions = 30000) {
    const options = typeof timeoutOrOptions === 'object' && timeoutOrOptions !== null
        ? timeoutOrOptions
        : { timeoutMs: timeoutOrOptions };
    const timeoutMs = Number(options.timeoutMs) || 30000;
    const signal = combineAbortSignals(options.signal, timeoutSignal(timeoutMs));
    try {
        const res = await fetch(url, { signal });
        if (!res.ok) throw new RpigError('IMAGE_DOWNLOAD_HTTP', `图片下载 HTTP ${res.status}：${safeRequestUrl(url)}`, { status: res.status });
        const blob = await res.blob();
        if (!blob.size || !/^image\//i.test(blob.type)) {
            throw new RpigError('IMAGE_DOWNLOAD_INVALID', '下载结果为空或不是图片，请检查地址、登录状态或临时链接是否过期');
        }
        return await blobToDataUrl(blob);
    } catch (error) { throw requestFailure(error, url, '图片下载'); }
}

/**
 * 异步睡眠
 * @param {number} ms 
 * @returns {Promise<void>}
 */
export function sleep(ms, signal) {
    if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason instanceof Error ? signal.reason : createAbortError());
        };
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * 解析提示词格式偏好
 * @param {object} settings 
 * @returns {'natural'|'tags'}
 */
export function resolvePromptFormat(settings) {
    const s = settings || {};
    if (s.promptFormat === 'natural') return 'natural';
    if (s.promptFormat === 'tags') return 'tags';
    if (s.backend === 'sd' || s.backend === 'comfyui' || s.backend === 'tavern-sd') {
        return 'tags';
    }
    return 'natural';
}

/**
 * 根据角色设定提取性别标签（避免形象工作台硬编码 1girl）
 * @param {string} text 
 * @returns {string}
 */
export function detectGenderTag(text) {
    if (typeof text !== 'string' || !text.trim()) {
        return '1person, solo';
    }
    const femaleRegex = /1girl|female|woman|lady|girl|she|her|少女|女性|女|小姐|姑娘|姐姐|妹妹|妻子|娘/i;
    const maleRegex = /1boy|male|man|guy|boy|he|his|him|少年|男性|男|先生|公子|哥哥|弟弟|丈夫|大叔/i;

    const isFemale = femaleRegex.test(text);
    const isMale = maleRegex.test(text);

    if (isFemale && !isMale) return '1girl, solo';
    if (isMale && !isFemale) return '1boy, solo';
    return '1person, solo';
}

/**
 * 从后向前查找最新一条有效的 AI 助手消息下标
 * 排除用户消息、系统消息、空白消息
 * @param {Array} chat 
 * @returns {number} 找到的下标，未找到返回 -1
 */
export function findLatestAssistantMessageIndex(chat) {
    if (!Array.isArray(chat) || chat.length === 0) return -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg) continue;
        if (msg.is_user || msg.is_system) continue;
        if (msg.extra && (msg.extra.type === 'system' || msg.extra.type === 'quiet')) continue;
        const text = typeof msg.mes === 'string' ? msg.mes.trim() : '';
        if (text.length > 0) {
            return i;
        }
    }
    return -1;
}

/**
 * 去重合并多个负面提示词字符串，保留顺序与权重语法
 * @param {...string} negatives 
 * @returns {string}
 */
export function mergeNegativePrompts(...negatives) {
    const seen = new Set();
    const result = [];

    for (const neg of negatives) {
        if (!neg || typeof neg !== 'string') continue;
        // 只在括号外切分，避免破坏 `(worst quality, low quality:1.4)` 这类权重组。
        const parts = [];
        let current = '';
        let depth = 0;
        for (const char of neg) {
            if (char === '(' || char === '[' || char === '{') depth++;
            if (char === ')' || char === ']' || char === '}') depth = Math.max(0, depth - 1);
            if ((char === ',' || char === '，' || char === '\n' || char === '\r') && depth === 0) {
                if (current.trim()) parts.push(current.trim());
                current = '';
                continue;
            }
            current += char;
        }
        if (current.trim()) parts.push(current.trim());

        for (const rawPart of parts) {
            const part = rawPart.trim();
            if (!part) continue;
            // 归一化用于去重比较（忽略大小写和多余空格）
            const key = part.toLowerCase().replace(/\s+/g, ' ');
            if (!seen.has(key)) {
                seen.add(key);
                result.push(part);
            }
        }
    }
    return result.join(', ');
}

