import { isLocalQwen } from './qwen.js';

/** Explicit local pixels. This settings helper never submits generation jobs. */
export function createLocalPixelsUI({ $, getSettings, getParameters, saveSettings = () => {}, onChange = () => {} }) {
    const element = $('<div class="rpig-local-pixels rpig-subcard"></div>');
    element.append($('<b></b>').text('本地绘制像素'));
    const presets = $('<select aria-label="常用本地像素"></select>')
        .append('<option value="">自定义 / 当前设置</option><option value="512x288">512×288 横屏轻量</option><option value="288x512">288×512 竖屏轻量</option><option value="512x512">512×512 方形</option><option value="768x448">768×448 横屏</option>');
    const width = $('<input type="number" min="256" max="2048" step="32" aria-label="本地绘制宽度">');
    const height = $('<input type="number" min="256" max="2048" step="32" aria-label="本地绘制高度">');
    const status = $('<div class="rpig-hint" role="status" aria-live="polite"></div>');
    const reset = $('<button type="button" class="menu_button">使用画幅 / 工作流默认像素</button>');
    const row = (label, control) => $('<div class="rpig-row"></div>').append($('<label></label>').text(label), control);
    element.append(row('常用像素', presets), row('宽度（像素）', width), row('高度（像素）', height), status, reset,
        $('<div class="rpig-hint"></div>').text('填写后按这些像素直接绘制，关闭自动升档。宽高须为32的倍数；自定义像素优先于画幅档位。步数在下方单独设置。'));
    let disposed = false;
    const actual = () => getParameters(getSettings(), [{ kind: 'identity-primary' }]);
    function refresh() {
        if (disposed) return;
        const s = getSettings();
        let parameters;
        try { parameters = actual(); status.text(parameters?.description || ''); }
        catch (error) { status.text(error.message); }
        const supported = isLocalQwen(s) || s.backend === 'sd' || (s.backend === 'comfyui' && s.comfyPreset && s.comfyPreset !== 'custom');
        element.toggle(supported);
        width.val(s.localImageWidth !== '' && s.localImageWidth != null ? s.localImageWidth : parameters?.size?.[0] || '');
        height.val(s.localImageHeight !== '' && s.localImageHeight != null ? s.localImageHeight : parameters?.size?.[1] || '');
        presets.val('');
    }
    function commit() {
        if (disposed) return;
        const s = getSettings();
        s.localImageWidth = String(width.val() ?? '').trim();
        s.localImageHeight = String(height.val() ?? '').trim();
        s.qwenSceneDetail = false;
        s.qwenIdentityDetailBoost = false;
        saveSettings();
        onChange();
        refresh();
    }
    width.on('input change', commit);
    height.on('input change', commit);
    presets.on('change', () => {
        if (!presets.val()) return;
        const [w, h] = presets.val().split('x');
        width.val(w); height.val(h); commit();
    });
    reset.on('click', () => { width.val(''); height.val(''); commit(); });
    refresh();
    return { element, refresh, destroy() { disposed = true; width.off(); height.off(); presets.off(); reset.off(); } };
}
