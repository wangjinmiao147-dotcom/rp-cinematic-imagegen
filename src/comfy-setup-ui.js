import { getComfyPreset, readComfyCapabilities, inspectComfyCapabilities } from './comfy-presets.js';
import { safeRequestUrl, scrubSensitiveText } from './utils.js';

const DESCRIPTIONS = {
    custom: '保留并使用高级设置里的自定义 API 工作流；不会覆盖原 JSON 或节点 ID。',
    'sd-text': '基础文生图，仅使用文字与 LoRA；忽略参考图，不做身份图编辑。',
    'sd-img2img': '基础图生图，使用一张参考图重绘；重绘幅度越高，画面改动越大。',
    'sd-cast': '实验模式：按参考图顺序，将2–4个人物从左到右排布并分区提示。适合3:4全身立绘，不是精准锁脸或多人LoRA；动作与人物一致性需查看成图。',
    'qwen-edit': 'Qwen Image Edit Plus 支持 1–3 张参考图，使用对应人物参考图理解编辑目标；模型和依赖需先安装。',
};
const MODEL_FIELDS = [
    ['checkpoints', 'comfyCheckpoint', 'Checkpoint 模型'],
    ['unets', 'comfyUnet', '扩散模型'],
    ['clips', 'comfyClip', '文本编码器'],
    ['vaes', 'comfyVae', 'VAE'],
];
const PARAMETER_FIELDS = [
    ['comfySteps', '步数', 1, 150, 1],
    ['comfyCfg', '提示词引导强度', 0, 30, 0.1],
    ['comfySeed', '随机种子（-1 为随机）', -1, Number.MAX_SAFE_INTEGER, 1],
    ['comfyDenoise', '参考图改动幅度', 0, 1, 0.05],
];
const emptyModels = () => ({ checkpoints: [], unets: [], clips: [], vaes: [], loras: [] });
const strings = values => [...new Set((Array.isArray(values) ? values : []).filter(value => typeof value === 'string' && value.trim()))];
const publicUrl = value => safeRequestUrl(value).replace(/\/+$/, '');
const isSdPreset = id => ['sd-text','sd-img2img','sd-cast'].includes(id);

/** Settings-only controls. Reading the server never submits an image job. */
export function createComfySetupUI({
    $, settings, getSettings, saveSettings = () => {}, onChange = () => {},
    readCapabilities = readComfyCapabilities, inspectCapabilities = inspectComfyCapabilities,
} = {}) {
    if (typeof $ !== 'function') throw new TypeError('ComfyUI 配置界面需要宿主的 jQuery');
    const current = () => getSettings?.() || settings || {};
    const identity = () => {
        const s = current();
        return JSON.stringify([s.backend, String(s.backendUrl || '').trim(), s.comfyPreset || 'custom',
            isSdPreset(s.comfyPreset) ? s.comfySamplingProfile || 'standard' : null]);
    };
    const preset = () => {
        try { return getComfyPreset(current()); }
        catch {
            const s = current();
            if (isSdPreset(s.comfyPreset)) {
                try { return getComfyPreset({ ...s, comfySamplingProfile: 'standard' }); } catch { /* Keep malformed presets recoverable in the UI. */ }
            }
            return getComfyPreset('custom');
        }
    };
    const row = (label, control, hint = '') => {
        const wrapper = $('<div class="rpig-row"></div>');
        if (label) wrapper.append($('<label></label>').text(label));
        wrapper.append(control);
        if (hint) wrapper.append($('<div class="rpig-hint"></div>').text(hint));
        return wrapper;
    };

    const element = $('<div class="rpig-comfy-setup rpig-subcard" id="rpig-comfy-setup" style="display:flex;flex-direction:column;gap:8px;"></div>');
    const presetSelect = $('<select id="rpig-comfy-preset" aria-label="ComfyUI 工作流"></select>');
    for (const id of ['custom', 'sd-text', 'sd-img2img', 'sd-cast', 'qwen-edit']) {
        presetSelect.append($('<option></option>').val(id).text(getComfyPreset(id).label));
    }
    const description = $('<div class="rpig-hint" id="rpig-comfy-description"></div>');
    const styleNotice = $('<div class="rpig-hint" id="rpig-comfy-style-notice"></div>');
    const qwenNotice = $('<div class="rpig-hint" id="rpig-comfy-qwen-notice"></div>');
    qwenNotice.append($('<span></span>').text('需要单独安装扩散模型、文本编码器和 VAE。模型文件较大，对显存和内存要求较高；请先对照官方说明准备：'));
    qwenNotice.append($('<a target="_blank" rel="noopener noreferrer" href="https://docs.comfy.org/tutorials/image/qwen/qwen-image-edit">官方教程</a>'));
    qwenNotice.append($('<span></span>').text(' · '));
    qwenNotice.append($('<a target="_blank" rel="noopener noreferrer" href="https://github.com/Comfy-Org/workflow_templates/blob/main/templates/image_qwen_image_edit_2509.json">Plus / 2509 模板与模型下载说明</a>'));
    const checkButton = $('<button type="button" class="menu_button" id="rpig-comfy-check">检测连接并读取模型</button>');
    const status = $('<div class="rpig-hint" id="rpig-comfy-status" role="status" aria-live="polite"></div>');
    element.append(row('ComfyUI 工作流', presetSelect), description, styleNotice, qwenNotice);
    element.append(row('', checkButton, '只读取服务器信息，不上传图片或提交生成任务。'), status);

    const samplingProfile = $('<select id="rpig-comfy-sampling-profile" aria-label="Checkpoint 采样方式"></select>')
        .append($('<option></option>').val('standard').text('普通 SD'))
        .append($('<option></option>').val('lcm').text('LCM 快速模型'));
    const samplingProfileRow = row('Checkpoint 采样方式', samplingProfile,
        '请选择与实际 Checkpoint 匹配的模式。LCM 快速模型需要对应的 LCM 权重（例如 DreamShaper8_LCM），不会自动加速普通 SD 模型。已有步数和引导强度会保留，留空才使用模式默认值。');

    const modelControls = new Map();
    for (const [catalog, key, label] of MODEL_FIELDS) {
        const select = $(`<select id="rpig-${key}" aria-label="${label}"></select>`);
        const wrapper = row(label, select);
        modelControls.set(key, { catalog, select, wrapper });
        element.append(wrapper);
        if (key === 'comfyCheckpoint') element.append(samplingProfileRow);
        select.on('change', () => {
            if (disposed) return;
            current()[key] = String(select.val() || '');
            saveSettings();
            refresh();
            onChange({ key, preset: preset().id });
        });
    }
    const parameters = $('<details class="rpig-comfy-parameters"></details>');
    parameters.append($('<summary></summary>').text('采样参数（留空使用工作流默认值）'));
    const parameterBody = $('<div style="display:flex;flex-direction:column;gap:8px;margin-top:8px;"></div>');
    parameters.append(parameterBody);
    const parameterControls = new Map();
    for (const [key, label, min, max, step] of PARAMETER_FIELDS) {
        const input = $(`<input type="number" id="rpig-${key}" aria-label="${label}">`)
            .attr('min', min).attr('max', max).attr('step', step);
        const wrapper = row(label, input);
        parameterControls.set(key, { input, wrapper });
        if (key === 'comfySteps') element.append(wrapper);
        else parameterBody.append(wrapper);
        input.on('input change', () => {
            if (disposed) return;
            const raw = String(input.val() ?? '').trim();
            if (raw !== '' && !Number.isFinite(Number(raw))) return;
            let value = raw === '' ? '' : Math.max(min, Math.min(max, Number(raw)));
            if (value !== '' && step === 1) value = Math.floor(value);
            current()[key] = value;
            saveSettings();
            onChange({ key, preset: preset().id });
        });
    }
    element.append(parameters);

    let disposed = false;
    let requestSequence = 0;
    let activeRequest = null;
    let capabilityInfo = null;
    let capabilityUrl = '';
    let availableModels = emptyModels();
    let lastError = '';
    let viewIdentity = identity();

    function stopReading() {
        requestSequence++;
        activeRequest?.controller.abort();
        activeRequest = null;
        checkButton.prop('disabled', false).text('检测连接并读取模型');
    }

    function renderModels(control, selected) {
        const names = availableModels[control.catalog];
        control.select.empty().append($('<option value=""></option>').text(capabilityInfo
            ? (names.length ? '请选择已安装模型' : '服务器没有此类模型')
            : '先点击“检测连接并读取模型”'));
        if (selected && !names.includes(selected)) {
            control.select.append($('<option></option>').val(selected).text(`${selected}（${capabilityInfo ? '服务器未找到' : '已保存，待检测'}）`));
        }
        for (const name of names) control.select.append($('<option></option>').val(name).text(name));
        control.select.val(selected || '');
    }

    function refresh() {
        if (disposed) return;
        const s = current(), selectedPreset = preset();
        const url = String(s.backendUrl || '').trim();
        if (viewIdentity !== identity()) { viewIdentity = identity(); lastError = ''; }
        if (activeRequest && activeRequest.identity !== identity()) stopReading();
        if (capabilityInfo && capabilityUrl !== url) {
            capabilityInfo = null;
            availableModels = emptyModels();
            lastError = '';
        }
        element.toggle(s.backend === 'comfyui');
        presetSelect.val(selectedPreset.id);
        samplingProfileRow.toggle(isSdPreset(selectedPreset.id));
        samplingProfile.val(s.comfySamplingProfile === 'lcm' ? 'lcm' : 'standard');
        description.text(DESCRIPTIONS[selectedPreset.id]);
        qwenNotice.toggle(selectedPreset.id === 'qwen-edit');
        styleNotice.toggle(selectedPreset.id === 'sd-text');
        styleNotice.text(s.stylePreset === 'reference'
            ? '基础文生图不做身份图编辑。请在“画风偏好”中自行切换为“跟随角色卡画风”，再使用此工作流；其他参考图设置保持你的选择。'
            : '此工作流忽略参考图，仅按文字与 LoRA 绘制。预置会自动构建工作流，无需手填 JSON。');
        if (selectedPreset.id !== 'custom' && selectedPreset.id !== 'sd-text') {
            description.text(`${DESCRIPTIONS[selectedPreset.id]} 预置会自动构建工作流，无需手填 JSON。`);
        }
        let inspection;
        if (capabilityInfo) {
            try {
                inspection = inspectCapabilities(capabilityInfo, s, { loras: [] });
                availableModels = Object.fromEntries(Object.keys(emptyModels()).map(key => [key, strings(inspection.models?.[key])]));
            } catch (error) {
                lastError = scrubSensitiveText(error?.message || String(error), [s.backendKey]);
            }
        }
        for (const [key, control] of modelControls) {
            control.wrapper.toggle(selectedPreset.id === 'qwen-edit' ? key !== 'comfyCheckpoint'
                : isSdPreset(selectedPreset.id) && key === 'comfyCheckpoint');
            renderModels(control, String(s[key] || ''));
        }
        const defaults = selectedPreset.id === 'qwen-edit'
            ? { comfySteps: 20, comfyCfg: 4, comfySeed: -1, comfyDenoise: 1 }
            : { comfySteps: isSdPreset(selectedPreset.id) && s.comfySamplingProfile === 'lcm' ? 8 : 28,
                comfyCfg: isSdPreset(selectedPreset.id) && s.comfySamplingProfile === 'lcm' ? 2 : 7, comfySeed: -1, comfyDenoise: 0.6 };
        if (Number.isFinite(selectedPreset.defaultSteps)) defaults.comfySteps = selectedPreset.defaultSteps;
        if (Number.isFinite(selectedPreset.defaultCfg)) defaults.comfyCfg = selectedPreset.defaultCfg;
        parameters.toggle(selectedPreset.id !== 'custom');
        for (const [key, control] of parameterControls) {
            control.input.val(s[key] ?? '').attr('placeholder', defaults[key]);
            control.wrapper.toggle(selectedPreset.id !== 'custom' && (key !== 'comfyDenoise' || ['sd-img2img','sd-cast','qwen-edit'].includes(selectedPreset.id)));
        }
        if (activeRequest) status.text('正在检测连接并读取已安装模型…');
        else if (lastError) status.text(`检测未完成：${lastError}`);
        else if (!capabilityInfo) status.text('选好工作流后点击检测；已有模型选择会保留，检测不会自动改选。');
        else if (inspection?.ready) status.text(selectedPreset.id === 'custom'
            ? '已连接并读取模型；自定义工作流仍按高级设置中的 JSON 校验。'
            : '已连接，所选工作流的节点与模型已就绪。');
        else {
            const missing = [];
            if (inspection?.missingNodes?.length) missing.push(`缺少节点或输入：${inspection.missingNodes.join('、')}。请安装或升级对应 ComfyUI 节点后重新检测。`);
            if (inspection?.missingModels?.length) missing.push(`缺少或未选择模型：${inspection.missingModels.join('、')}。请安装模型并从下拉框选择。`);
            status.text(`已连接，工作流尚未就绪。${missing.join(' ')}`);
        }
    }

    function publishModels(s) {
        const node = element[0], document = node?.ownerDocument;
        const CustomEventType = document?.defaultView?.CustomEvent || globalThis.CustomEvent;
        if (!node?.dispatchEvent || !CustomEventType) return;
        node.dispatchEvent(new CustomEventType('rpig:comfy-models', {
            bubbles: true,
            detail: { url: publicUrl(s.backendUrl), models: Object.fromEntries(Object.entries(availableModels).map(([key, names]) => [key, [...names]])) },
        }));
    }

    presetSelect.on('change', () => {
        if (disposed) return;
        const s = current();
        s.comfyPreset = String(presetSelect.val() || 'custom');
        lastError = '';
        stopReading();
        saveSettings();
        refresh();
        onChange({ key: 'comfyPreset', preset: preset().id });
    });
    samplingProfile.on('change', () => {
        if (disposed || !isSdPreset(preset().id)) return;
        const value = String(samplingProfile.val() || 'standard');
        if (value !== 'standard' && value !== 'lcm') return;
        current().comfySamplingProfile = value;
        lastError = '';
        stopReading();
        saveSettings();
        refresh();
        onChange({ key: 'comfySamplingProfile', preset: preset().id });
    });
    checkButton.on('click', async () => {
        if (disposed || current().backend !== 'comfyui') return false;
        stopReading();
        lastError = '';
        const request = { sequence: ++requestSequence, identity: identity(), controller: new AbortController() };
        activeRequest = request;
        checkButton.prop('disabled', true).text('检测中…');
        refresh();
        const s = { ...current() };
        const isCurrent = () => !disposed && activeRequest === request && request.sequence === requestSequence
            && request.identity === identity() && !request.controller.signal.aborted;
        const discardObsoleteRequest = () => {
            if (!disposed && activeRequest === request) { stopReading(); refresh(); }
            return false;
        };
        try {
            const info = await readCapabilities(s, { signal: request.controller.signal });
            if (!isCurrent()) return discardObsoleteRequest();
            capabilityInfo = info;
            capabilityUrl = String(s.backendUrl || '').trim();
            activeRequest = null;
            refresh();
            publishModels(s);
            return true;
        } catch (error) {
            if (!isCurrent()) return discardObsoleteRequest();
            lastError = scrubSensitiveText(error?.message || String(error), [s.backendKey]);
            capabilityInfo = null;
            availableModels = emptyModels();
            activeRequest = null;
            refresh();
            return false;
        } finally {
            if (!disposed && request.sequence === requestSequence) {
                checkButton.prop('disabled', false).text('检测连接并读取模型');
            }
        }
    });
    refresh();
    return {
        element, refresh,
        get presetId() { return preset().id; },
        get models() { return Object.fromEntries(Object.entries(availableModels).map(([key, names]) => [key, [...names]])); },
        destroy() { disposed = true; stopReading(); element.remove(); },
    };
}
