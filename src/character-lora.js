import { RpigError } from './utils.js';

export const DEFAULT_CHARACTER_LORA = Object.freeze({
    enabled: false, name: '', strengthModel: 0.8, strengthClip: 0.8, triggerWords: '', family: 'sd',
});

function own(value, key) {
    if (!value || typeof value !== 'object') return undefined;
    try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function record(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function identity(value) {
    return typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value)
        && (value === 'user' || (value.startsWith('character:') && value.length > 10));
}
function relativeName(value) {
    if (typeof value !== 'string') return false;
    const name = value.trim();
    return name.length <= 240 && !/[\u0000-\u001f\u007f<>"|?*]/.test(name)
        && !/^(?:[a-z][a-z\d+.-]*:|[\\/])/i.test(name)
        && !name.split(/[\\/]/).some(part => part === '..' || part === '.');
}
function strength(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 2; }

// Character display names never identify a LoRA binding: renamed or same-name cards remain isolated.
export function getCharacterLoraKey(character, getCharacterIdentifier = value => value?.avatar || value) {
    if (character === 'user') return 'user';
    if (!character || (typeof character === 'object' && (typeof own(character, 'avatar') !== 'string' || !own(character, 'avatar').trim()))) return null;
    let identifier;
    try { identifier = getCharacterIdentifier(character); } catch { return null; }
    if (typeof identifier !== 'string' || !identifier || identifier === 'default') return null;
    const key = `character:${identifier}`;
    return identity(key) ? key : null;
}

export function readCharacterLora(settings, identityId) {
    const source = identity(identityId) ? own(own(settings, 'characterLoras'), identityId) : undefined;
    if (!record(source)) return { ...DEFAULT_CHARACTER_LORA };
    const name = own(source, 'name');
    const triggerWords = own(source, 'triggerWords');
    return {
        enabled: own(source, 'enabled') === true,
        name: relativeName(name) ? name.trim() : '',
        strengthModel: strength(own(source, 'strengthModel')) ? own(source, 'strengthModel') : 0.8,
        strengthClip: strength(own(source, 'strengthClip')) ? own(source, 'strengthClip') : 0.8,
        triggerWords: typeof triggerWords === 'string' ? triggerWords.slice(0, 200) : '',
        family: own(source, 'family') === 'qwen' ? 'qwen' : 'sd',
    };
}

function validated(value) {
    if (!record(value)) throw new RpigError('CHARACTER_LORA_INVALID', '角色 LoRA 配置无效，请重新填写');
    const result = {};
    for (const key of Object.keys(DEFAULT_CHARACTER_LORA)) {
        const supplied = own(value, key);
        result[key] = supplied === undefined ? DEFAULT_CHARACTER_LORA[key] : supplied;
    }
    if (typeof result.enabled !== 'boolean' || !relativeName(result.name)) {
        throw new RpigError('CHARACTER_LORA_INVALID', 'LoRA 名称须为 ComfyUI models/loras 下的相对文件名，不能使用网址或绝对路径');
    }
    result.name = result.name.trim();
    if (result.enabled && !result.name) throw new RpigError('CHARACTER_LORA_NAME_REQUIRED', '角色 LoRA 已启用，但未填写模型文件名；请填写后再启用');
    if (!strength(result.strengthModel) || !strength(result.strengthClip)) {
        throw new RpigError('CHARACTER_LORA_STRENGTH_INVALID', 'LoRA 的模型强度与文本强度须为 0–2 之间的有限数字');
    }
    if (typeof result.triggerWords !== 'string' || result.triggerWords.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(result.triggerWords)) {
        throw new RpigError('CHARACTER_LORA_TRIGGER_INVALID', 'LoRA 触发词须为不超过 200 字符的普通文本');
    }
    result.triggerWords = result.triggerWords.trim();
    if (!['sd', 'qwen'].includes(result.family)) throw new RpigError('CHARACTER_LORA_FAMILY_INVALID', '请选择 LoRA 对应的 SD 或 Qwen 类别');
    return result;
}

export function saveCharacterLora(settings, identityId, value) {
    if (!record(settings) || !identity(identityId)) throw new RpigError('CHARACTER_LORA_IDENTITY_INVALID', '未找到稳定角色标识，请先选择角色或 User');
    const result = validated(value);
    const current = own(settings, 'characterLoras');
    settings.characterLoras = { ...(record(current) ? current : {}), [identityId]: { ...result } };
    return { ...result };
}

// Ordinary LoRAs affect the complete frame, so only a single visible identity may load one.
export function selectCharacterLoras(settings, actors, { backend = own(settings, 'backend'), preset = own(settings, 'comfyPreset') } = {}) {
    const visible = [], seen = new Set();
    for (const actor of Array.isArray(actors) ? actors : []) {
        if (!record(actor) || own(actor, 'visible') === false || own(actor, 'present') === false) continue;
        const id = own(actor, 'identityId');
        const name = own(actor, 'identityName');
        const marker = identity(id) ? id : typeof name === 'string' && name.trim() ? `unmatched:${name.trim()}` : actor;
        if (seen.has(marker)) continue;
        seen.add(marker);
        visible.push({ identityId: identity(id) ? id : null });
    }
    const enabled = visible.filter(actor => own(own(own(settings, 'characterLoras'), actor.identityId), 'enabled') === true);
    if (!enabled.length) return { loras: [], warnings: [] };
    if (visible.length !== 1) return { loras: [], warnings: ['本场景有多位人物入镜，普通 LoRA 会影响整张图；本次跳过角色 LoRA，避免人物混用。'] };
    if (backend !== 'comfyui' || !['sd-text', 'sd-img2img', 'qwen-edit'].includes(preset)) {
        return { loras: [], warnings: ['角色 LoRA 目前仅支持 ComfyUI 内置工作流；本次未加载，继续普通生图。'] };
    }
    const identityId = enabled[0].identityId;
    let lora;
    try { lora = validated(own(own(settings, 'characterLoras'), identityId)); }
    catch (error) { return { loras: [], warnings: [error.message] }; }
    const family = preset === 'qwen-edit' ? 'qwen' : 'sd';
    if (lora.family !== family) return { loras: [], warnings: ['当前工作流与角色 LoRA 的 SD/Qwen 类别不一致；本次跳过，请选用与底模匹配的 LoRA。'] };
    return { loras: [{ ...lora, identityId }], warnings: [] };
}
