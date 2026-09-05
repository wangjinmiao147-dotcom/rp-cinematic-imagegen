// ============================================================
// RP 电影配图 - LLM 调用模块
// ============================================================

import {
    combineAbortSignals,
    isAbortError,
    normalizeBackendUrl,
    raceWithAbort,
    scrubSensitiveText,
    throwIfAborted,
    timeoutSignal,
} from './utils.js';

export function extractChatCompletionText(data) {
    const flatten = (value) => {
        if (typeof value === 'string') return value.trim();
        if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join('\n').trim();
        if (!value || typeof value !== 'object') return '';
        if (typeof value.text === 'string') return value.text.trim();
        if (typeof value.content === 'string' || Array.isArray(value.content)) return flatten(value.content);
        if (typeof value.final_prompt === 'string' || typeof value.prompt === 'string') return JSON.stringify(value);
        return '';
    };

    const choice = data?.choices?.[0];
    return flatten(choice?.message?.content)
        || flatten(choice?.text)
        || flatten(data?.output_text)
        || flatten(data?.response)
        || '';
}

/**
 * 统一 LLM 调用
 * @param {string} system 
 * @param {string} user 
 * @param {object} settings 
 * @param {Function} [getContextFn] 
 * @returns {Promise<string>}
 */
export async function callLLM(system, user, settings, getContextFn, options = {}) {
    const s = settings || {};
    const signal = options.signal;
    throwIfAborted(signal);
    const context = typeof getContextFn === 'function' ? getContextFn() : null;

    if (s.llmSource === 'tavern') {
        // 1. 复用酒馆当前 LLM：使用酒馆公开的 generateQuietPrompt 对象参数接口
        const quietGen = context?.generateQuietPrompt
            || (typeof window !== 'undefined' && window.generateQuietPrompt);

        if (typeof quietGen === 'function') {
            const fullPrompt = `${system}\n\n${user}`;
            const result = await raceWithAbort(quietGen({
                quietPrompt: fullPrompt,
                quietToLoud: false,
                skipWIAN: false,
            }), signal);

            if (typeof result === 'string' && result.trim()) {
                return result.trim();
            }
            if (result && typeof result === 'object' && typeof result.text === 'string' && result.text.trim()) {
                return result.text.trim();
            }
            throw new Error('酒馆 LLM 返回内容为空');
        }

        throw new Error('当前酒馆环境未提供 generateQuietPrompt 接口，请在扩展设置中切换为「扩展内独立配置」LLM');
    }

    // 2. 独立配置：OpenAI-compatible /chat/completions 接口
    let base = normalizeBackendUrl(s.llmUrl);
    if (!/\/v\d+$/.test(base)) {
        base += '/v1';
    }

    const model = (s.llmModel || '').trim();
    if (!model) {
        throw new Error('未配置 LLM 模型名称');
    }

    const key = (s.llmKey || '').trim();
    const headers = { 'Content-Type': 'application/json' };
    if (key && key !== 'none') {
        headers['Authorization'] = `Bearer ${key}`;
    }

    const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user || '' },
    ];

    const requestCompletion = async (jsonMode) => fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: headers,
            body: JSON.stringify({
                model: model,
                messages: messages,
                temperature: 0.7,
                ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
            }),
            signal: combineAbortSignals(signal, timeoutSignal(120000)),
        });

    let res;
    try {
        res = await requestCompletion(options.jsonMode === true);
        if (!res.ok && options.jsonMode === true && (res.status === 400 || res.status === 422)) {
            res = await requestCompletion(false);
        }
    } catch (netErr) {
        if (isAbortError(netErr)) throw netErr;
        throw new Error(`LLM 连接失败：${scrubSensitiveText(netErr.message, [key])}`);
    }

    if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`LLM HTTP ${res.status}: ${scrubSensitiveText(errText, [key]).slice(0, 300)}`);
    }

    const data = await res.json();
    const content = extractChatCompletionText(data);
    if (!content) {
        throw new Error('LLM 返回内容为空');
    }
    return content;
}
