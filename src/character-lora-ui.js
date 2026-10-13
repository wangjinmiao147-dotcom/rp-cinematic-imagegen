import { getCharacterLoraKey, readCharacterLora, saveCharacterLora } from './character-lora.js';
import { safeRequestUrl } from './utils.js';

function serverKey(url) { return typeof url === 'string' && url.trim() ? safeRequestUrl(url.trim()).replace(/\/+$/, '') : ''; }

export function createCharacterLoraUI({ $, getSettings, getCharacterIdentifier, getSelectedCharacter, saveSettings }) {
    if (typeof $ !== 'function') throw new TypeError('Character LoRA controls require the host UI adapter');
    const element = $('<div class="rpig-character-lora"></div>');
    const title = $('<div class="rpig-sheet-header"></div>').text('角色 LoRA · 单人入镜时自动加载');
    const target = $('<div data-rpig-lora="target" class="rpig-char-summary-name"></div>');
    const notice = $('<div class="rpig-notice"></div>').text('普通 LoRA 会影响整张图；仅单人入镜且使用 ComfyUI 内置工作流时加载，多人入镜自动跳过。请将权重放入 ComfyUI/models/loras，不会上传权重。');
    const enabled = $('<input type="checkbox" data-rpig-lora="enabled">');
    const name = $('<input type="text" data-rpig-lora="name" maxlength="240" placeholder="角色/模型文件.safetensors">');
    const modelList = $('<select data-rpig-lora="models"></select>');
    const modelsStatus = $('<div data-rpig-lora="models-status" class="rpig-notice"></div>');
    const strengthModel = $('<input type="number" data-rpig-lora="strengthModel" min="0" max="2" step="0.05">');
    const strengthClip = $('<input type="number" data-rpig-lora="strengthClip" min="0" max="2" step="0.05">');
    const triggerWords = $('<textarea data-rpig-lora="triggerWords" maxlength="200" rows="2" placeholder="可选，模型说明中的触发词"></textarea>');
    const family = $('<select data-rpig-lora="family"></select>')
        .append($('<option></option>').val('sd').text('SD / SDXL'))
        .append($('<option></option>').val('qwen').text('Qwen Image'));
    const save = $('<button type="button" class="menu_button" data-rpig-lora="save"></button>').text('保存此角色 LoRA');
    const status = $('<div data-rpig-lora="status" role="status"></div>');
    const inputs = { enabled, name, strengthModel, strengthClip, triggerWords, family };
    function row(label, control) {
        return $('<label class="rpig-row"></label>').append($('<span></span>').text(label)).append(control);
    }
    element.append(title, target, notice,
        row('启用此角色 LoRA', enabled), row('相对模型文件名', name), row('从服务器列表选择（可选）', modelList), modelsStatus,
        row('模型强度（0–2）', strengthModel), row('文本强度（0–2）', strengthClip),
        row('触发词（最多 200 字符）', triggerWords), row('模型类别', family), save, status);
    let boundId = null, destroyed = false, modelCache = { url: '', loras: [] };

    function refreshModels() {
        const currentUrl = serverKey(getSettings()?.backendUrl);
        const available = currentUrl && modelCache.url === currentUrl ? modelCache.loras : [];
        modelList.empty().append($('<option></option>').val('').text(available.length ? '选择一个已安装的 LoRA' : '暂无匹配服务器的模型列表，可手动填写文件名'));
        for (const model of available) modelList.append($('<option></option>').val(model).text(model));
        modelList.val('');
        modelList.prop('disabled', !boundId || !available.length);
        modelsStatus.text(available.length ? `已读取 ${available.length} 个 LoRA；列表不代表与当前底模兼容，请核对模型类别。` : '可在 ComfyUI 设置中读取模型列表，或填写 models/loras 下已有的相对文件名。');
    }

    function persist() {
        if (destroyed || !boundId) return;
        // Capture the displayed binding before any host save or role-selection change.
        const capturedId = boundId;
        const next = {
            enabled: enabled.prop('checked') === true, name: name.val(),
            strengthModel: String(strengthModel.val()).trim() ? Number(strengthModel.val()) : NaN,
            strengthClip: String(strengthClip.val()).trim() ? Number(strengthClip.val()) : NaN,
            triggerWords: triggerWords.val(), family: family.val(),
        };
        try {
            saveCharacterLora(getSettings(), capturedId, next);
            saveSettings?.();
            status.text('已保存当前绑定的角色 LoRA。');
        } catch (error) {
            // Error messages are static validation text; role/model data never become markup.
            status.text(error?.message || '保存失败，请检查 LoRA 配置。');
        }
    }

    function refresh() {
        if (destroyed) return;
        const character = getSelectedCharacter?.();
        boundId = getCharacterLoraKey(character, getCharacterIdentifier);
        const value = readCharacterLora(getSettings(), boundId);
        target.text(character === 'user' ? '当前绑定：User' : boundId ? `当前绑定：${character?.name || '角色'}` : '请先选择有稳定头像标识的角色或 User。');
        for (const [key, control] of Object.entries(inputs)) {
            if (key === 'enabled') control.prop('checked', value.enabled);
            else control.val(value[key]);
            control.prop('disabled', !boundId);
        }
        save.prop('disabled', !boundId);
        status.text('');
        refreshModels();
    }

    function setModels({ url, loras } = {}) {
        if (destroyed) return;
        const candidates = Array.isArray(loras) ? loras.slice(0, 500) : [];
        modelCache = { url: serverKey(url), loras: [...new Set(candidates
            .filter(model => typeof model === 'string' && model.trim() && model.length <= 240 && !/[\u0000-\u001f\u007f]/.test(model))
            .map(model => model.trim()))] };
        refreshModels();
    }

    for (const control of Object.values(inputs)) control.on('change', persist);
    save.on('click', persist);
    modelList.on('change', () => {
        const selected = modelList.val();
        if (!selected) return;
        name.val(selected);
        persist();
    });
    const events = globalThis.document ? $(globalThis.document) : null;
    const onModels = event => {
        const detail = event?.detail || event?.originalEvent?.detail;
        if (detail) setModels({ url: detail.url, loras: detail.models?.loras });
    };
    events?.on('rpig:comfy-models', onModels);
    refresh();
    return { element, refresh, setModels, destroy() {
        if (destroyed) return;
        destroyed = true;
        boundId = null;
        events?.off('rpig:comfy-models', onModels);
        for (const control of [...Object.values(inputs), save, modelList]) control.off();
        element.remove();
    } };
}
