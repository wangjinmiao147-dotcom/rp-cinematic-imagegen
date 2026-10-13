import { createAbortError, isAbortError, raceWithAbort, throwIfAborted, RpigError } from './utils.js';
import { fitViewportOverlay } from './floating-ui.js';

export const MAX_REFERENCE_SOURCE_PIXELS = 40_000_000;
export const MAX_REFERENCE_OUTPUT_EDGE = 2048;
const MAX_SOURCE_DATA_LENGTH = 112_000_000;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const fail = (code, message) => { throw new RpigError(code, message); };

function assertCurrent({ signal, isCurrent } = {}) {
    throwIfAborted(signal);
    if (isCurrent && !isCurrent()) throw createAbortError('参考图或会话已更改');
}

function sourceDimensions(width, height) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
        fail('REFERENCE_IMAGE_INVALID', '图片尺寸无效，请重新选择图片');
    }
    if (width * height > MAX_REFERENCE_SOURCE_PIXELS || width > 40000 || height > 40000) {
        fail('REFERENCE_IMAGE_TOO_LARGE', '原图尺寸过大，请缩小后再标注（最多 4000 万像素）');
    }
}

/** Clip a normalized rectangle and round its edges to original image pixels. */
export function clampCropBounds(bounds, sourceWidth, sourceHeight, minSize = 2) {
    sourceDimensions(sourceWidth, sourceHeight);
    if (![bounds?.x, bounds?.y, bounds?.width, bounds?.height].every(finite)
        || bounds.width <= 0 || bounds.height <= 0) fail('REFERENCE_CROP_INVALID', '裁切范围无效，请重新框选');
    const left = clamp(Math.floor(clamp(bounds.x, 0, 1) * sourceWidth + 1e-8), 0, sourceWidth);
    const top = clamp(Math.floor(clamp(bounds.y, 0, 1) * sourceHeight + 1e-8), 0, sourceHeight);
    const right = clamp(Math.ceil(clamp(bounds.x + bounds.width, 0, 1) * sourceWidth - 1e-8), 0, sourceWidth);
    const bottom = clamp(Math.ceil(clamp(bounds.y + bounds.height, 0, 1) * sourceHeight - 1e-8), 0, sourceHeight);
    const minimum = Math.max(2, Math.floor(Number(minSize) || 2));
    if (right - left < minimum || bottom - top < minimum) fail('REFERENCE_CROP_TOO_SMALL', '选区太小，宽和高至少需要 2 个原图像素');
    return { x: left / sourceWidth, y: top / sourceHeight, width: (right - left) / sourceWidth, height: (bottom - top) / sourceHeight };
}

/** Drag endpoints use natural-image coordinates; the returned bounds are 0–1. */
export function normalizeCropRect(start, end, sourceWidth, sourceHeight, minSize = 2) {
    sourceDimensions(sourceWidth, sourceHeight);
    if (![start?.x, start?.y, end?.x, end?.y].every(finite)) fail('REFERENCE_CROP_INVALID', '裁切范围无效，请重新框选');
    return clampCropBounds({
        x: Math.min(start.x, end.x) / sourceWidth,
        y: Math.min(start.y, end.y) / sourceHeight,
        width: Math.abs(end.x - start.x) / sourceWidth,
        height: Math.abs(end.y - start.y) / sourceHeight,
    }, sourceWidth, sourceHeight, minSize);
}

export function referenceAnnotationPoint(clientX, clientY, rect, sourceWidth, sourceHeight) {
    sourceDimensions(sourceWidth, sourceHeight);
    if (![clientX, clientY, rect?.left, rect?.top, rect?.width, rect?.height].every(finite)
        || rect.width <= 0 || rect.height <= 0) fail('REFERENCE_CROP_INVALID', '图片尚未显示，请稍后再框选');
    return {
        x: clamp((clientX - rect.left) / rect.width * sourceWidth, 0, sourceWidth),
        y: clamp((clientY - rect.top) / rect.height * sourceHeight, 0, sourceHeight),
    };
}

function validateDataUrl(dataUrl) {
    if (typeof dataUrl !== 'string' || dataUrl.length > MAX_SOURCE_DATA_LENGTH
        || !/^data:image\/(?:png|jpe?g|webp|gif|bmp|avif);base64,[A-Za-z0-9+/]+={0,2}$/i.test(dataUrl)) {
        fail('REFERENCE_IMAGE_INVALID', '请使用完整的本地图片数据重新标注');
    }
}

function decodeSource(dataUrl, { signal, ImageType, isCurrent } = {}) {
    assertCurrent({ signal, isCurrent });
    validateDataUrl(dataUrl);
    if (typeof ImageType !== 'function') fail('REFERENCE_IMAGE_INVALID', '当前浏览器无法读取图片');
    return new Promise((resolve, reject) => {
        const image = new ImageType();
        const cleanup = () => {
            image.onload = image.onerror = null;
            signal?.removeEventListener('abort', abort);
        };
        const abort = () => {
            cleanup();
            image.src = '';
            reject(signal.reason instanceof Error ? signal.reason : createAbortError());
        };
        image.onload = () => {
            cleanup();
            try {
                assertCurrent({ signal, isCurrent });
                sourceDimensions(image.naturalWidth, image.naturalHeight);
                resolve(image);
            } catch (error) { reject(error); }
        };
        image.onerror = () => { cleanup(); reject(new RpigError('REFERENCE_IMAGE_INVALID', '图片无法解码，请重新选择图片')); };
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        try { image.src = dataUrl; } catch {
            cleanup(); reject(new RpigError('REFERENCE_IMAGE_INVALID', '图片无法读取，请重新选择图片'));
        }
    });
}

/** Draw only original pixels on a fresh canvas, never the annotated preview. */
export async function cropReferenceImage(dataUrl, bounds, options = {}) {
    assertCurrent(options);
    validateDataUrl(dataUrl);
    const doc = options.document || globalThis.document;
    const ImageType = options.ImageType || doc?.defaultView?.Image || globalThis.Image;
    const image = options.sourceImage || await decodeSource(dataUrl, { ...options, ImageType });
    assertCurrent(options);
    if (options.sourceImage && image.src !== dataUrl) fail('REFERENCE_IMAGE_INVALID', '原图数据已更改，请重新打开标注');
    const sourceWidth = image.naturalWidth, sourceHeight = image.naturalHeight;
    const checked = clampCropBounds(bounds, sourceWidth, sourceHeight);
    const x = Math.round(checked.x * sourceWidth), y = Math.round(checked.y * sourceHeight);
    const cropWidth = Math.round(checked.width * sourceWidth), cropHeight = Math.round(checked.height * sourceHeight);
    const maxEdge = clamp(Math.floor(Number(options.maxEdge) || MAX_REFERENCE_OUTPUT_EDGE), 1, MAX_REFERENCE_OUTPUT_EDGE);
    const scale = Math.min(1, maxEdge / cropWidth, maxEdge / cropHeight);
    const width = Math.max(1, Math.round(cropWidth * scale)), height = Math.max(1, Math.round(cropHeight * scale));
    const canvas = doc?.createElement('canvas');
    if (!canvas) fail('REFERENCE_CROP_CANVAS_UNAVAILABLE', '当前浏览器无法裁切图片');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) fail('REFERENCE_CROP_CANVAS_UNAVAILABLE', '当前浏览器无法裁切图片');
    assertCurrent(options);
    let cropped;
    try {
        context.imageSmoothingEnabled = true;
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, x, y, cropWidth, cropHeight, 0, 0, width, height);
        assertCurrent(options);
        cropped = canvas.toDataURL('image/png');
    } catch (error) {
        if (isAbortError(error)) throw error;
        fail('REFERENCE_CROP_FAILED', '裁切未完成，请重新选择区域后重试');
    }
    assertCurrent(options);
    if (!/^data:image\/png;base64,/.test(cropped)) fail('REFERENCE_CROP_FAILED', '裁切未生成有效图片，请重试');
    return { dataUrl: cropped, bounds: checked, sourceWidth, sourceHeight, width, height };
}

/** onSave owns persistence and must honor the second argument before commit. */
export function openReferenceAnnotation(options = {}) {
    const { dataUrl, label = '', sourceRefId = null, onSave } = options;
    const targets = (Array.isArray(options.targets) ? options.targets : []).filter(target =>
        target && (typeof target.id === 'string' || typeof target.id === 'number') && String(target.id).trim());
    if (!targets.length || typeof onSave !== 'function') return Promise.reject(new Error('请先选择参考图所属人物'));
    if (options.signal?.aborted || options.isCurrent?.() === false) return Promise.resolve({ cancelled: true });
    const doc = options.document || globalThis.document;
    const win = doc?.defaultView || globalThis.window;
    const ImageType = options.ImageType || win?.Image;
    if (!doc?.body) return Promise.reject(new Error('当前浏览器无法打开图片标注'));
    const controller = new AbortController(), signal = controller.signal;
    const focusBefore = doc.activeElement;
    const overlay = doc.createElement('div');
    overlay.className = 'rpig-local-detail-overlay rpig-reference-annotation-overlay';
    overlay.innerHTML = `<section class="rpig-local-detail-dialog rpig-reference-annotation-dialog" role="dialog" aria-modal="true" aria-label="标注角色参考图">
        <div class="rpig-local-detail-header"><h3>标注角色参考图</h3><button type="button" class="rpig-reference-annotation-close" aria-label="关闭图片标注">✕</button></div>
        <p class="rpig-reference-annotation-source"></p>
        <p class="rpig-local-detail-hint">拖动框选一名角色。照片上只保留所选角色，群像请分别另存；编号和姓名仅在预览显示，不会写进图片。原图保留。</p>
        <div class="rpig-local-detail-stage"><div class="rpig-local-detail-image-wrap"><canvas class="rpig-local-detail-canvas rpig-reference-annotation-canvas" aria-label="拖动选择角色区域"></canvas><div class="rpig-local-detail-selection rpig-reference-annotation-selection" hidden><span class="rpig-reference-annotation-badge"></span></div></div></div>
        <div class="rpig-local-detail-controls rpig-reference-annotation-controls"><label>归属人物<select class="rpig-reference-annotation-target"></select></label><label>参考图名称<input class="rpig-reference-annotation-label" type="text" maxlength="80"></label><label>参考图类型<select class="rpig-reference-annotation-type"></select></label></div>
        <label class="rpig-reference-annotation-primary-label"><input class="rpig-reference-annotation-primary" type="checkbox">设为该角色主图</label>
        <div class="rpig-local-detail-status rpig-reference-annotation-status" role="status" aria-live="polite">正在读取原图…</div>
        <div class="rpig-local-detail-actions"><button type="button" class="rpig-reference-annotation-cancel">取消</button><button type="button" class="rpig-reference-annotation-reset">重新框选</button><button type="button" class="rpig-reference-annotation-save" disabled>另存角色参考图</button></div>
    </section>`;
    const find = name => overlay.querySelector(`.rpig-reference-annotation-${name}`);
    const canvas = find('canvas'), selection = find('selection'), badge = find('badge'), status = find('status');
    const targetSelect = find('target'), labelInput = find('label'), typeSelect = find('type'), primary = find('primary');
    const saveButton = find('save');
    find('source').textContent = String(label || '当前参考图').slice(0, 160);
    for (const target of targets) {
        const option = doc.createElement('option'); option.value = String(target.id); option.textContent = String(target.name || target.id); targetSelect.append(option);
    }
    targetSelect.value = targets.some(target => String(target.id) === String(options.initialTargetId)) ? String(options.initialTargetId) : String(targets[0].id);
    for (const [value, text] of [['single', '人物区域'], ['full_body', '完整角色'], ['face_crop', '面部特写']]) {
        const option = doc.createElement('option'); option.value = value; option.textContent = text; typeSelect.append(option);
    }
    typeSelect.value = 'single'; primary.checked = true;
    labelInput.value = String(label || `${targets.find(target => String(target.id) === targetSelect.value)?.name || '角色'} · 裁切参考`).slice(0, 80);
    const listeners = [];
    let sourceImage = null, bounds = null, drag = null, busy = false, closed = false, releaseViewport = () => {};
    let resolveFinished;
    const finished = new Promise(resolve => { resolveFinished = resolve; });
    const listen = (target, type, callback, settings) => {
        target?.addEventListener(type, callback, settings);
        listeners.push(() => target?.removeEventListener(type, callback, settings));
    };
    const current = () => !closed && !signal.aborted && options.isCurrent?.() !== false;
    function finish(result) {
        if (closed) return;
        closed = true;
        controller.abort(createAbortError('图片标注已关闭'));
        for (const remove of listeners.splice(0)) remove();
        releaseViewport(); overlay.remove();
        if (sourceImage) sourceImage.src = '';
        if (focusBefore?.isConnected !== false) focusBefore?.focus?.();
        resolveFinished(result);
    }
    const guard = () => {
        if (current()) return true;
        finish({ cancelled: true }); return false;
    };
    const setStatus = text => { if (!closed) status.textContent = text; };
    function updateControls() {
        saveButton.disabled = !sourceImage || !bounds || busy;
        find('reset').disabled = !sourceImage || busy;
        for (const control of [targetSelect, labelInput, typeSelect, primary]) control.disabled = busy;
    }
    function drawSelection(value = bounds) {
        selection.hidden = !value;
        if (value) Object.assign(selection.style, { left: `${value.x * 100}%`, top: `${value.y * 100}%`, width: `${value.width * 100}%`, height: `${value.height * 100}%` });
        const target = targets.find(item => String(item.id) === targetSelect.value);
        badge.textContent = `1 · ${String(target?.name || target?.id || '')}`;
        updateControls();
    }
    const point = event => referenceAnnotationPoint(event.clientX, event.clientY, canvas.getBoundingClientRect(), sourceImage.naturalWidth, sourceImage.naturalHeight);
    const start = event => {
        if (!guard() || !sourceImage || busy || drag || (event.button != null && event.button !== 0 && event.pointerType !== 'touch')) return;
        event.preventDefault();
        try {
            drag = { id: event.pointerId, start: point(event), previous: bounds };
            bounds = null; drawSelection();
            try { canvas.setPointerCapture?.(event.pointerId); } catch { /* Pointer capture is optional on older browsers. */ }
        } catch { setStatus('图片尚未显示，请稍后再框选'); }
    };
    const move = event => {
        if (!drag || drag.id !== event.pointerId || !guard()) return;
        event.preventDefault();
        try { bounds = normalizeCropRect(drag.start, point(event), sourceImage.naturalWidth, sourceImage.naturalHeight); drawSelection(); }
        catch { bounds = null; drawSelection(); }
    };
    const end = event => {
        if (!drag || drag.id !== event.pointerId || !guard()) return;
        move(event);
        try { canvas.releasePointerCapture?.(event.pointerId); } catch { /* Optional native capability. */ }
        drag = null;
        setStatus(bounds ? '选区已就绪；确认归属人物后另存。原图保留。' : '选区太小，请重新框选，宽和高至少需要 2 个原图像素。');
        updateControls();
    };
    const cancelDrag = event => {
        if (!drag || drag.id !== event.pointerId) return;
        bounds = drag.previous; drag = null; drawSelection();
    };
    if (win?.PointerEvent) {
        listen(canvas, 'pointerdown', start);
        listen(doc, 'pointermove', move);
        listen(doc, 'pointerup', end);
        listen(doc, 'pointercancel', cancelDrag);
    } else {
        const mouse = handler => event => handler({ pointerId: 'mouse', pointerType: 'mouse', button: event.button,
            clientX: event.clientX, clientY: event.clientY, preventDefault: () => event.preventDefault() });
        const touch = handler => event => {
            const touches = [...(event.changedTouches || event.touches || [])];
            const selected = drag ? touches.find(item => `touch:${item.identifier}` === drag.id) : touches[0];
            if (selected) handler({ pointerId: `touch:${selected.identifier}`, pointerType: 'touch',
                clientX: selected.clientX, clientY: selected.clientY, preventDefault: () => event.preventDefault() });
        };
        listen(canvas, 'mousedown', mouse(start)); listen(doc, 'mousemove', mouse(move)); listen(doc, 'mouseup', mouse(end));
        listen(canvas, 'touchstart', touch(start), { passive: false }); listen(doc, 'touchmove', touch(move), { passive: false });
        listen(doc, 'touchend', touch(end), { passive: false }); listen(doc, 'touchcancel', touch(cancelDrag), { passive: false });
    }
    listen(targetSelect, 'change', () => { if (guard()) drawSelection(); });
    listen(find('reset'), 'click', () => { if (guard() && !busy) { bounds = null; drag = null; drawSelection(); setStatus('请重新拖动框选一名角色。'); } });
    for (const name of ['close', 'cancel']) listen(find(name), 'click', () => finish({ cancelled: true }));
    listen(overlay, 'click', event => { if (event.target === overlay) finish({ cancelled: true }); });
    listen(doc, 'keydown', event => {
        if (event.key === 'Escape') { event.preventDefault(); finish({ cancelled: true }); }
        if (event.key === 'Tab') {
            const controls = [...overlay.querySelectorAll('button, select, input')].filter(control => !control.disabled && !control.hidden);
            const first = controls[0], last = controls.at(-1);
            if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
    });
    listen(options.signal, 'abort', () => finish({ cancelled: true }));
    listen(saveButton, 'click', async () => {
        if (!guard() || busy || !sourceImage || !bounds) return;
        const target = targets.find(item => String(item.id) === targetSelect.value);
        if (!target) { setStatus('请选择参考图所属人物'); return; }
        const snapshot = { bounds: { ...bounds }, targetId: target.id,
            label: String(labelInput.value || '').trim().slice(0, 80) || `${String(target.name || '角色')} · 裁切参考`,
            viewType: ['single', 'full_body', 'face_crop'].includes(typeSelect.value) ? typeSelect.value : 'single',
            isPrimaryIdentity: primary.checked === true };
        busy = true; updateControls(); setStatus('正在裁切并另存角色参考图…');
        try {
            const cropped = await cropReferenceImage(dataUrl, snapshot.bounds, { document: doc, ImageType, sourceImage, signal, isCurrent: current });
            if (!guard()) return;
            const result = { dataUrl: cropped.dataUrl, targetId: snapshot.targetId, label: snapshot.label,
                viewType: snapshot.viewType, isPrimaryIdentity: snapshot.isPrimaryIdentity,
                annotation: { version: 1, sourceRefId: typeof sourceRefId === 'string' || typeof sourceRefId === 'number' ? sourceRefId : null,
                    bounds: cropped.bounds, sourceWidth: cropped.sourceWidth, sourceHeight: cropped.sourceHeight } };
            assertCurrent({ signal, isCurrent: current });
            await raceWithAbort(onSave(result, { signal, isCurrent: current }), signal);
            if (!guard()) return;
            finish(result);
        } catch (error) {
            if (isAbortError(error) || !current()) { finish({ cancelled: true }); return; }
            setStatus('另存未完成，请重试；原图和选区仍保留。');
        } finally { if (!closed) { busy = false; updateControls(); } }
    });
    doc.body.append(overlay);
    try { releaseViewport = (options.fitViewportOverlay || fitViewportOverlay)(overlay, win); } catch { /* The dialog remains usable with host CSS. */ }
    find('close').focus?.();
    Promise.resolve().then(async () => {
        try {
            sourceImage = await decodeSource(dataUrl, { signal, ImageType, isCurrent: current });
            if (!guard()) return;
            const scale = Math.min(1, MAX_REFERENCE_OUTPUT_EDGE / sourceImage.naturalWidth, MAX_REFERENCE_OUTPUT_EDGE / sourceImage.naturalHeight);
            canvas.width = Math.max(1, Math.round(sourceImage.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(sourceImage.naturalHeight * scale));
            const context = canvas.getContext('2d');
            if (!context) fail('REFERENCE_CROP_CANVAS_UNAVAILABLE', '当前浏览器无法显示图片');
            context.drawImage(sourceImage, 0, 0, canvas.width, canvas.height);
            if (!guard()) return;
            updateControls(); setStatus('拖动框选一名角色，再确认归属人物和参考图类型。');
        } catch (error) {
            if (isAbortError(error) || !current()) { finish({ cancelled: true }); return; }
            sourceImage = null; updateControls(); setStatus('图片无法读取或尺寸过大，请关闭后重新选择；原图保留。');
        }
    });
    return finished;
}
