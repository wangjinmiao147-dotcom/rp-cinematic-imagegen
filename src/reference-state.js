// Pure mutations used inside the storage transaction; never write a stale UI list back.
export function mergeReferenceViews(existing, imported, limit = 50) {
    if (existing.length + imported.length > limit) throw new Error(`导入后将超过 ${limit} 张参考图上限，请先整理参考图`);
    let hasPrimary = existing.some(view => view.isPrimaryIdentity);
    return [...existing, ...imported.map(view => {
        const primary = !!view.isPrimaryIdentity && !hasPrimary;
        if (primary) hasPrimary = true;
        return { ...view, isPrimaryIdentity: primary };
    })];
}

export function modifyReferenceViews(views, target, operation, value) {
    const index = target.refId
        ? views.findIndex(view => view.refId === target.refId)
        : views.findIndex(view => (view.url || view.dataUrl) === (target.url || target.dataUrl)
            && (view.label || '') === (target.label || ''));
    if (index < 0) throw new Error('这张参考图已被移除，请刷新参考图列表');
    if (operation === 'remove') return views.filter((_, i) => i !== index);
    if (operation === 'primary') {
        const primary = !views[index].isPrimaryIdentity;
        return views.map((view, i) => ({ ...view, isPrimaryIdentity: primary && i === index,
            ...(primary && i === index ? { enabled: true } : {}) }));
    }
    if (operation !== 'viewType' && operation !== 'enabled') throw new Error('未知的参考图操作');
    return views.map((view, i) => i === index ? { ...view, [operation]: value } : view);
}
