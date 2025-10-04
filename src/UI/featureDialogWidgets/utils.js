export function normalizeReferenceName(value) {
    if (value == null) return null;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) return null;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') {
                const parsedName = typeof parsed.name === 'string' ? parsed.name.trim() : '';
                if (parsedName) return parsedName;
                const parsedId = typeof parsed.id === 'string' ? parsed.id.trim() : '';
                if (parsedId) return parsedId;
            }
        } catch (_) { /* not JSON */ }
        return trimmed;
    }

    if (typeof value === 'object') {
        if (typeof value.name === 'string' && value.name.trim()) return value.name.trim();
        if (typeof value.id === 'string' && value.id.trim()) return value.id.trim();
        if (Array.isArray(value.path)) {
            const joined = value.path.filter(Boolean).map(String).join(' › ');
            if (joined) return joined;
        }
    }

    const asString = String(value);
    return asString.trim() || null;
}

export function normalizeReferenceList(values) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    const out = [];
    for (const item of values) {
        const normalized = normalizeReferenceName(item);
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        out.push(normalized);
    }
    return out;
}
