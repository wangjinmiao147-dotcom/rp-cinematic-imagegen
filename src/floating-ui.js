// Use viewport coordinates, including when a transformed, zero-height <html>
// becomes the containing block for position:fixed (observed on Android Mi Browser).
export function viewportBounds(win = window) {
    const v = win.visualViewport;
    return { left: v?.offsetLeft || 0, top: v?.offsetTop || 0,
        width: v?.width || win.innerWidth, height: v?.height || win.innerHeight };
}

export function clampFloatingPoint(point, size, bounds, margin = 8) {
    return {
        left: Math.max(bounds.left + margin, Math.min(point.left, bounds.left + bounds.width - size.width - margin)),
        top: Math.max(bounds.top + margin, Math.min(point.top, bounds.top + bounds.height - size.height - margin)),
    };
}

export function placeFloatingElement(element, point, win = window, margin = 8) {
    const rect = element.getBoundingClientRect();
    const target = clampFloatingPoint(point, rect, viewportBounds(win), margin);
    const set = (k, v) => element.style.setProperty(k, v, 'important');
    set('right', 'auto'); set('bottom', 'auto');
    set('left', `${target.left}px`); set('top', `${target.top}px`);
    // Account for translated/scaled containing blocks without changing the host's CSS.
    const placed = element.getBoundingClientRect();
    const scaleX = element.offsetWidth ? placed.width / element.offsetWidth : 1;
    const scaleY = element.offsetHeight ? placed.height / element.offsetHeight : 1;
    set('left', `${target.left + (target.left - placed.left) / (scaleX || 1)}px`);
    set('top', `${target.top + (target.top - placed.top) / (scaleY || 1)}px`);
    return target;
}

export function fitViewportOverlay(element, win = window) {
    const update = () => {
        const bounds = viewportBounds(win);
        element.style.setProperty('box-sizing', 'border-box', 'important');
        element.style.setProperty('width', `${bounds.width}px`, 'important');
        element.style.setProperty('height', `${bounds.height}px`, 'important');
        placeFloatingElement(element, bounds, win, 0);
    };
    update();
    const bindings = [[win, 'resize'], [win, 'orientationchange'], [win.visualViewport, 'resize'], [win.visualViewport, 'scroll']];
    for (const [target, event] of bindings) target?.addEventListener(event, update);
    return () => { for (const [target, event] of bindings) target?.removeEventListener(event, update); };
}

export function keepFloatingUIVisible(fab, panel, win = window) {
    const bounds = viewportBounds(win);
    const rect = fab.getBoundingClientRect();
    placeFloatingElement(fab, { left: bounds.left + bounds.width - rect.width - 10,
        top: bounds.top + bounds.height - rect.height - 82 }, win);
    let frame;
    const update = () => {
        if (frame) return;
        frame = win.requestAnimationFrame(() => {
            frame = null;
            for (const element of [fab, panel]) {
                if (!element || !element.isConnected) continue;
                const r = element.getBoundingClientRect();
                if (!r.width || !r.height) continue;
                if (element === panel) element.style.maxHeight = `${Math.max(80, viewportBounds(win).height - 24)}px`;
                placeFloatingElement(element, { left: r.left, top: r.top }, win);
            }
        });
    };
    const bindings = [[win, 'resize'], [win, 'orientationchange'], [win, 'pageshow'],
        [win.visualViewport, 'resize'], [win.visualViewport, 'scroll']];
    for (const [target, event] of bindings) target?.addEventListener(event, update);
    return () => {
        for (const [target, event] of bindings) target?.removeEventListener(event, update);
        if (frame) win.cancelAnimationFrame(frame);
    };
}

export function initializeFloatingUI(build, report) {
    try { build(); return true; }
    catch (error) { report(error); return false; }
}
