// Sidebar + 3D hover/selection coloring helpers

export function updateListHighlights(inst) {
  if (!inst || !inst._acc) return;
  const mapKey = (t, id) => (t === 'point' ? `p:${id}` : t === 'geometry' ? `g:${id}` : t === 'constraint' ? `c:${id}` : null);
  const sel = new Set(Array.from(inst._selection || []).map((i) => mapKey(i.type, i.id)).filter(Boolean));
  const hov = inst._hover ? mapKey(inst._hover.type, inst._hover.id) : null;

  const rows = Array.from(inst._acc.uiElement.querySelectorAll('.sk-row'));
  for (const r of rows) {
    const btn = r.querySelector('[data-act]');
    const key = btn ? btn.getAttribute('data-act') : null;
    const selected = key && sel.has(key);
    const hovered = key && hov === key;

    // Row tint
    r.style.background = selected
      ? 'rgba(111,226,111,.12)'
      : hovered
        ? 'rgba(255,213,74,.10)'
        : 'transparent';
    r.style.borderRadius = '6px';

    // Button visual state
    if (btn) {
      if (selected) {
        btn.style.background = 'rgba(111,226,111,.10)';
        btn.style.border = '1px solid #2f6d2f';
        btn.style.color = '#d7ffd7';
      } else if (hovered) {
        btn.style.background = 'rgba(255,213,74,.08)';
        btn.style.border = '1px solid #6f5a12';
        btn.style.color = '#ffe599';
      } else {
        // Reset to defaults used when rendering the list
        btn.style.background = 'transparent';
        btn.style.border = '1px solid #364053';
        btn.style.color = '#ddd';
      }
    }
  }
}

export function applyHoverAndSelectionColors(inst) {
  if (!inst || !inst._sketchGroup) return;
  const hov = inst._hover;
  const isSel = (kind, id) => Array.from(inst._selection).some(s => s.type === (kind === 'point' ? 'point' : 'geometry') && s.id === id);
  const isHov = (kind, id) => hov && ((hov.type === 'point' && kind === 'point' && hov.id === id) || (hov.type === 'geometry' && kind === 'geometry' && hov.id === id));
  for (const ch of inst._sketchGroup.children) {
    const ud = ch.userData || {};
    if (ud.kind === 'point') {
      const col = isSel('point', ud.id) ? 0x6fe26f : (isHov('point', ud.id) ? 0xffd54a : 0x9ec9ff);
      try { ch.material.color.setHex(col); } catch {}
    } else if (ud.kind === 'geometry') {
      const col = isSel('geometry', ud.id) ? 0x6fe26f : (isHov('geometry', ud.id) ? 0xffd54a : 0xffff88);
      try { ch.material.color.setHex(col); } catch {}
    }
  }
}
