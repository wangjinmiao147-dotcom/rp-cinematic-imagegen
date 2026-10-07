import { createAbortError, fetchToDataUrl, isAbortError, raceWithAbort, scrubSensitiveText, throwIfAborted } from './utils.js';
import { fitViewportOverlay } from './floating-ui.js';

export const LOCAL_DETAIL_PRESETS = Object.freeze({
    general: { label: '通用细节', instruction: 'Improve the clarity of existing local contours, small forms and textures without changing their arrangement.' },
    chest: { label: '成年人体胸部', instruction: 'Refine only the already visible nipple and areola on the normal adult chest: distinguish the small central nipple form from its broader softly pigmented areola, with a compact base contour, restrained tip highlight and subtle relief shadow following the existing chest plane. Keep the original natural size, location, perspective and occlusion. Do not reveal covered anatomy.' },
    hands: { label: '手部', instruction: 'Refine the existing hand anatomy and its current task: naturally connected joints, one thumb and four fingers per human hand, respecting the existing occlusion and contact.' },
    feet: { label: '脚部', instruction: 'Refine the existing foot anatomy: connected ankle, heel and arch, and five proportionate toes per human foot, respecting the existing occlusion and contact.' },
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const finite = value => Number.isFinite(Number(value));

/** Convert displayed pointer coordinates to the decoded image's pixel space. */
export function localDetailPoint(clientX, clientY, bounds, width, height) {
    if (!(bounds?.width > 0 && bounds?.height > 0 && width > 0 && height > 0)) throw new Error('图片尚未显示，请稍后重试');
    return {
        x: clamp((clientX - bounds.left) / bounds.width * width, 0, width),
        y: clamp((clientY - bounds.top) / bounds.height * height, 0, height),
    };
}

/** Region bounds are integer, half-open coordinates in the source image. */
export function normalizeLocalDetailRegion(start, end, width, height, minSize = 12) {
    if (![width, height, start?.x, start?.y, end?.x, end?.y].every(finite) || width < 1 || height < 1) throw new Error('选区无效，请重新选择');
    const x = clamp(Math.floor(Math.min(start.x, end.x)), 0, width);
    const y = clamp(Math.floor(Math.min(start.y, end.y)), 0, height);
    const right = clamp(Math.ceil(Math.max(start.x, end.x)), 0, width);
    const bottom = clamp(Math.ceil(Math.max(start.y, end.y)), 0, height);
    if (right - x < minSize || bottom - y < minSize) {
        const error = new Error('选区太小，请扩大一些');
        error.code = 'LOCAL_DETAIL_REGION_SMALL';
        throw error;
    }
    return { x, y, width: right - x, height: bottom - y };
}

/** A square context crop keeps its aspect ratio; any missing edges are padded. */
export function createLocalDetailPlan(width, height, region, { contextScale = 1.5, minContext = 64, targetSize = 256, feather = 6 } = {}) {
    const checked = normalizeLocalDetailRegion(region, { x: region.x + region.width, y: region.y + region.height }, width, height, 1);
    const size = Math.max(1, Math.ceil(Math.max(checked.width, checked.height) * Math.max(1, Number(contextScale) || 1.5)), Math.round(Number(minContext) || 64));
    const position = (center, dimension) => {
        const proposed = Math.floor(center - size / 2);
        return size <= dimension ? clamp(proposed, 0, dimension - size) : clamp(proposed, dimension - size, 0);
    };
    const x = position(checked.x + checked.width / 2, width);
    const y = position(checked.y + checked.height / 2, height);
    const sourceRect = { x: Math.max(0, x), y: Math.max(0, y), width: Math.min(width, x + size) - Math.max(0, x), height: Math.min(height, y + size) - Math.max(0, y) };
    const target = Math.max(1, Math.round(Number(targetSize) || 256));
    return {
        sourceWidth: width, sourceHeight: height, region: checked,
        square: { x, y, size }, sourceRect, targetSize: target,
        padding: { left: sourceRect.x - x, top: sourceRect.y - y, right: x + size - sourceRect.x - sourceRect.width, bottom: y + size - sourceRect.y - sourceRect.height },
        regionInPatch: { x: (checked.x - x) / size * target, y: (checked.y - y) / size * target, width: checked.width / size * target, height: checked.height / size * target },
        feather: clamp(Math.round(Number(feather) || 0), 0, Math.floor(Math.min(checked.width, checked.height) / 2)),
    };
}

export function buildLocalDetailInstruction(preset = 'general', supplement = '') {
    const selected = LOCAL_DETAIL_PRESETS[preset] || LOCAL_DETAIL_PRESETS.general;
    const extra = String(supplement || '').trim().replace(/\s+/g, ' ').slice(0, 240);
    return `Edit this small crop of an existing illustration. ${selected.instruction} Preserve the current pose, perspective, silhouette, colors, lighting, artwork medium and linework. Keep all surrounding forms and objects in place. Make a subtle local refinement without redesigning the figure or adding objects, text or panels.${extra ? ` Additional local instruction: ${extra}` : ''}`;
}

/** Bilinear sampling and an inward feather touch only pixels inside the ROI. */
export function blendLocalDetailPixels(sourcePixels, patchPixels, width, height, plan, { patchWidth = plan.targetSize, patchHeight = plan.targetSize } = {}) {
    if (sourcePixels.length !== width * height * 4 || patchPixels.length !== patchWidth * patchHeight * 4 || patchWidth < 1 || patchHeight < 1) throw new Error('图片数据无效，原图已保留');
    const region = normalizeLocalDetailRegion(plan.region, { x: plan.region.x + plan.region.width, y: plan.region.y + plan.region.height }, width, height, 1);
    const output = new Uint8ClampedArray(sourcePixels);
    const sample = (px, py, channel) => {
        const sx = clamp(px, 0, patchWidth - 1), sy = clamp(py, 0, patchHeight - 1);
        const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(x0 + 1, patchWidth - 1), y1 = Math.min(y0 + 1, patchHeight - 1);
        const dx = sx - x0, dy = sy - y0;
        const at = (x, y) => patchPixels[(y * patchWidth + x) * 4 + channel];
        return (at(x0, y0) * (1 - dx) + at(x1, y0) * dx) * (1 - dy) + (at(x0, y1) * (1 - dx) + at(x1, y1) * dx) * dy;
    };
    for (let y = region.y; y < region.y + region.height; y++) {
        for (let x = region.x; x < region.x + region.width; x++) {
            const distance = Math.min(x - region.x, y - region.y, region.x + region.width - 1 - x, region.y + region.height - 1 - y);
            const t = plan.feather > 0 ? clamp(distance / plan.feather, 0, 1) : 1;
            const weight = t * t * (3 - 2 * t);
            if (!weight) continue;
            const px = (x - plan.square.x + 0.5) / plan.square.size * patchWidth - 0.5;
            const py = (y - plan.square.y + 0.5) / plan.square.size * patchHeight - 0.5;
            const offset = (y * width + x) * 4;
            for (let channel = 0; channel < 4; channel++) output[offset + channel] = sourcePixels[offset + channel] * (1 - weight) + sample(px, py, channel) * weight;
        }
    }
    return output;
}

function canvasFor(doc, width, height) {
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function putPixels(canvas, pixels) {
    const context = canvas.getContext('2d');
    const imageData = context.createImageData(canvas.width, canvas.height);
    imageData.data.set(pixels);
    context.putImageData(imageData, 0, 0);
}

function makeContextPatch(image, plan, doc) {
    const canvas = canvasFor(doc, plan.targetSize, plan.targetSize);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const source = plan.sourceRect, scale = plan.targetSize / plan.square.size;
    const dx = plan.padding.left * scale, dy = plan.padding.top * scale;
    const dw = source.width * scale, dh = source.height * scale;
    const right = plan.targetSize - dx - dw, bottom = plan.targetSize - dy - dh;
    // Extend the nearest source edge into padding rather than distort the crop.
    if (dx > 0) ctx.drawImage(image, source.x, source.y, 1, source.height, 0, dy, dx, dh);
    if (right > 0) ctx.drawImage(image, source.x + source.width - 1, source.y, 1, source.height, dx + dw, dy, right, dh);
    if (dy > 0) ctx.drawImage(image, source.x, source.y, source.width, 1, dx, 0, dw, dy);
    if (bottom > 0) ctx.drawImage(image, source.x, source.y + source.height - 1, source.width, 1, dx, dy + dh, dw, bottom);
    for (const [sx, sy, tx, ty, tw, th] of [
        [source.x, source.y, 0, 0, dx, dy],
        [source.x + source.width - 1, source.y, dx + dw, 0, right, dy],
        [source.x, source.y + source.height - 1, 0, dy + dh, dx, bottom],
        [source.x + source.width - 1, source.y + source.height - 1, dx + dw, dy + dh, right, bottom],
    ]) if (tw > 0 && th > 0) ctx.drawImage(image, sx, sy, 1, 1, tx, ty, tw, th);
    ctx.drawImage(image, source.x, source.y, source.width, source.height, dx, dy, dw, dh);
    return canvas.toDataURL('image/png');
}

function decodeImage(url, signal, ImageType) {
    throwIfAborted(signal);
    return raceWithAbort(new Promise((resolve, reject) => {
        const image = new ImageType();
        image.onload = () => { image.onload = null; image.onerror = null; resolve(image); };
        image.onerror = () => { image.onload = null; image.onerror = null; reject(new Error('图片无法读取，原图已保留')); };
        image.src = url;
    }), signal);
}

/**
 * Opens a manual ROI editor. Generation never persists; only the save button
 * calls onSave. Resolves with {saved:true,...} or {cancelled:true} on close.
 * onGenerate receives patchDataUrl/instruction/signal/plan; onSave receives
 * dataUrl/sourceUrl/region/plan/instruction/generationResult/signal. onSave owns
 * the persistence transaction: check validity before commit and settle with its
 * actual result after commit. A session close waits for an in-flight save.
 */
export function openLocalDetailEditor(options = {}) {
    const { sourceUrl, onGenerate, onSave } = options;
    if (!sourceUrl || typeof onGenerate !== 'function' || typeof onSave !== 'function') return Promise.reject(new Error('局部精修尚未就绪'));
    const doc = options.document || globalThis.document;
    const win = doc.defaultView || globalThis.window;
    const ImageType = options.Image || win.Image;
    const fetchImage = options.fetchToDataUrl || fetchToDataUrl;
    const controller = new AbortController();
    const signal = controller.signal;
    const focusBefore = doc.activeElement;
    const overlay = doc.createElement('div');
    overlay.className = 'rpig-local-detail-overlay';
    overlay.innerHTML = `<section class="rpig-local-detail-dialog" role="dialog" aria-modal="true" aria-label="局部精修">
        <div class="rpig-local-detail-header"><h3>局部精修</h3><button type="button" class="rpig-local-detail-close" aria-label="关闭局部精修">✕</button></div>
        <p class="rpig-local-detail-hint">拖选需要调整的部分，生成后可另存一张。</p>
        <div class="rpig-local-detail-stage"><div class="rpig-local-detail-image-wrap"><canvas class="rpig-local-detail-canvas" aria-label="拖动选择精修区域"></canvas><div class="rpig-local-detail-selection" hidden></div></div></div>
        <div class="rpig-local-detail-controls"><label>精修方向<select class="rpig-local-detail-preset"></select></label><label>补充要求<textarea class="rpig-local-detail-note" rows="2" maxlength="240" placeholder="可选：写一句希望改善的细节"></textarea></label></div>
        <div class="rpig-local-detail-status" role="status" aria-live="polite">正在读取图片…</div>
        <div class="rpig-local-detail-actions"><button type="button" class="rpig-local-detail-cancel">取消</button><button type="button" class="rpig-local-detail-compare" hidden>查看原图</button><button type="button" class="rpig-local-detail-generate" disabled>生成候选</button><button type="button" class="rpig-local-detail-save" disabled>另存候选</button></div>
    </section>`;
    const find = selector => overlay.querySelector(`.rpig-local-detail-${selector}`);
    const canvas = find('canvas'), selection = find('selection'), preset = find('preset'), note = find('note'), status = find('status');
    const generateButton = find('generate'), saveButton = find('save'), compareButton = find('compare');
    canvas.style.touchAction = 'none';
    for (const [key, value] of Object.entries(LOCAL_DETAIL_PRESETS)) {
        const option = doc.createElement('option'); option.value = key; option.textContent = value.label; preset.append(option);
    }
    preset.value = 'general';
    let sourceImage, sourcePixels, region = null, candidate = null, showCandidate = false;
    let busy = false, saving = false, pendingExternalClose = false, closed = false, drag = null, releaseViewport = () => {};
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const setStatus = message => { status.textContent = message; };
    const updateControls = () => {
        preset.disabled = note.disabled = busy || saving;
        generateButton.disabled = !sourcePixels || !region || busy || saving;
        saveButton.disabled = !candidate || busy || saving;
        compareButton.hidden = !candidate;
        compareButton.disabled = busy || saving;
        compareButton.textContent = showCandidate ? '查看原图' : '查看候选';
        find('close').disabled = find('cancel').disabled = saving;
    };
    const drawSelection = value => {
        selection.hidden = !value;
        if (!value) return;
        Object.assign(selection.style, { left: `${value.x / canvas.width * 100}%`, top: `${value.y / canvas.height * 100}%`, width: `${value.width / canvas.width * 100}%`, height: `${value.height / canvas.height * 100}%` });
    };
    const render = () => {
        if (sourcePixels) putPixels(canvas, showCandidate && candidate ? candidate.pixels : sourcePixels);
        drawSelection(region);
        updateControls();
    };
    const invalidateCandidate = () => { candidate = null; showCandidate = false; render(); };
    const onExternalAbort = () => {
        if (saving) {
            pendingExternalClose = true;
            setStatus('正在完成候选保存…');
            return;
        }
        controller.abort(options.signal?.reason || createAbortError('已取消局部精修'));
        finish({ cancelled: true });
    };
    const close = () => {
        if (closed || saving) return;
        controller.abort(createAbortError('已取消局部精修'));
        finish({ cancelled: true });
    };
    const finish = value => {
        if (closed) return;
        closed = true;
        options.signal?.removeEventListener('abort', onExternalAbort);
        doc.removeEventListener('keydown', onKeyDown, true);
        releaseViewport();
        overlay.remove();
        focusBefore?.focus?.();
        resolveFinished(value);
    };
    const onKeyDown = event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
        if (event.key === 'Tab') {
            const focusable = Array.from(overlay.querySelectorAll('button, select, textarea')).filter(element => !element.disabled && !element.hidden);
            const first = focusable[0], last = focusable[focusable.length - 1];
            if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    };
    const showError = error => {
        if (closed || isAbortError(error)) return;
        setStatus(scrubSensitiveText(error?.message || String(error)));
        try { options.onError?.(error); } catch { /* The original stays available. */ }
    };
    const dataUrlFor = async url => {
        throwIfAborted(signal);
        return String(url).startsWith('data:') ? url : raceWithAbort(fetchImage(url, { signal }), signal);
    };
    const point = event => localDetailPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), canvas.width, canvas.height);
    canvas.addEventListener('pointerdown', event => {
        if (!sourcePixels || busy || saving || (event.button !== undefined && event.button !== 0) || drag) return;
        event.preventDefault();
        invalidateCandidate();
        drag = { id: event.pointerId, start: point(event), previousRegion: region };
        canvas.setPointerCapture?.(event.pointerId);
        drawSelection(null);
    });
    canvas.addEventListener('pointermove', event => {
        if (!drag || event.pointerId !== drag.id) return;
        event.preventDefault();
        const end = point(event);
        drawSelection({ x: Math.min(drag.start.x, end.x), y: Math.min(drag.start.y, end.y), width: Math.abs(drag.start.x - end.x), height: Math.abs(drag.start.y - end.y) });
    });
    const endDrag = event => {
        if (!drag || event.pointerId !== drag.id) return;
        const current = drag; drag = null;
        try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* Capture may already be released. */ }
        if (event.type === 'pointercancel') { region = current.previousRegion; render(); return; }
        try {
            region = normalizeLocalDetailRegion(current.start, point(event), canvas.width, canvas.height, options.minRegionSize ?? 12);
            setStatus('已选好区域，可以开始精修。');
        } catch (error) { region = current.previousRegion; showError(error); }
        render();
    };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);
    preset.addEventListener('change', invalidateCandidate);
    note.addEventListener('input', invalidateCandidate);
    compareButton.addEventListener('click', () => { showCandidate = !showCandidate; render(); });
    overlay.addEventListener('click', event => { if (event.target === overlay) close(); });
    find('close').addEventListener('click', close);
    find('cancel').addEventListener('click', close);
    generateButton.addEventListener('click', async () => {
        if (!region || busy || saving) return;
        invalidateCandidate();
        busy = true; updateControls(); setStatus('正在精修选中部分…');
        try {
            const plan = createLocalDetailPlan(canvas.width, canvas.height, region, { ...options.cropOptions, targetSize: 256 });
            const patchDataUrl = makeContextPatch(sourceImage, plan, doc);
            const instruction = buildLocalDetailInstruction(preset.value, note.value);
            const result = await raceWithAbort(onGenerate({ patchDataUrl, instruction, signal, sourceUrl, region: { ...region }, plan, preset: preset.value, targetSize: 256 }), signal);
            throwIfAborted(signal);
            if (result?.cancelled) throw createAbortError();
            if (result?.error) throw result.error;
            const returnedUrl = typeof result === 'string' ? result : result?.dataUrl || result?.imageUrl;
            if (!returnedUrl) throw new Error('没有生成候选图片，原图已保留');
            const edited = await decodeImage(await dataUrlFor(returnedUrl), signal, ImageType);
            const patch = canvasFor(doc, edited.naturalWidth || edited.width, edited.naturalHeight || edited.height);
            patch.getContext('2d').drawImage(edited, 0, 0);
            const patchPixels = patch.getContext('2d').getImageData(0, 0, patch.width, patch.height).data;
            const pixels = blendLocalDetailPixels(sourcePixels, patchPixels, canvas.width, canvas.height, plan, { patchWidth: patch.width, patchHeight: patch.height });
            throwIfAborted(signal);
            const output = canvasFor(doc, canvas.width, canvas.height);
            putPixels(output, pixels);
            candidate = { dataUrl: output.toDataURL('image/png'), sourceUrl, region: { ...region }, plan, preset: preset.value, instruction, generationResult: result, pixels };
            showCandidate = true;
            setStatus('候选已生成，可对照原图后另存。');
        } catch (error) {
            candidate = null; showCandidate = false;
            if (!closed && isAbortError(error)) setStatus('已取消精修，原图已保留。');
            else showError(error);
        } finally {
            busy = false;
            if (!closed) render();
        }
    });
    saveButton.addEventListener('click', async () => {
        if (!candidate || busy || saving) return;
        if (signal.aborted || options.signal?.aborted) { onExternalAbort(); return; }
        saving = true; updateControls(); setStatus('正在另存候选…');
        try {
            throwIfAborted(signal);
            const { pixels: _pixels, ...payload } = candidate;
            const result = await onSave({ ...payload, signal });
            if (result?.cancelled) throw createAbortError();
            if (result?.error) throw result.error;
            finish({ saved: true, ...payload, result, ...(pendingExternalClose ? { staleAfterSave: true } : {}) });
        } catch (error) {
            if (pendingExternalClose) {
                controller.abort(options.signal?.reason || createAbortError('已取消局部精修'));
                finish({ cancelled: true });
            } else if (!closed && isAbortError(error)) setStatus('候选未保存，原图已保留。');
            else showError(error);
        }
        finally { saving = false; if (!closed) updateControls(); }
    });
    doc.addEventListener('keydown', onKeyDown, true);
    doc.body.append(overlay);
    releaseViewport = (options.fitViewportOverlay || fitViewportOverlay)(overlay, win) || (() => {});
    find('close').focus();
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted) onExternalAbort();
    void (async () => {
        try {
            sourceImage = await decodeImage(await dataUrlFor(sourceUrl), signal, ImageType);
            throwIfAborted(signal);
            canvas.width = sourceImage.naturalWidth || sourceImage.width;
            canvas.height = sourceImage.naturalHeight || sourceImage.height;
            canvas.getContext('2d').drawImage(sourceImage, 0, 0);
            sourcePixels = new Uint8ClampedArray(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
            setStatus('拖动选择要精修的部分。'); render();
        } catch (error) { showError(error); }
    })();
    return finished;
}
