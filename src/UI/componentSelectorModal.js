import { listComponentRecords, getComponentRecord, extractThumbnailFrom3MFBase64 } from '../services/componentLibrary.js';
import { ModelLibraryView } from './ModelLibraryView.js';

function formatDate(iso) {
  if (!iso) return '';
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return '';
    return dt.toLocaleString();
  } catch {
    return '';
  }
}

export function openComponentSelectorModal({ title = 'Select Component' } = {}) {
  return new Promise((resolve) => {
    const records = listComponentRecords();

    const overlay = document.createElement('div');
    overlay.className = 'component-selector-overlay';

    const panel = document.createElement('div');
    panel.className = 'component-selector-panel';

    const header = document.createElement('div');
    header.className = 'cs-header';
    header.textContent = title;

    const controls = document.createElement('div');
    controls.className = 'cs-controls';

    const search = document.createElement('input');
    search.type = 'search';
    search.placeholder = 'Search components…';
    search.className = 'cs-search';
    controls.appendChild(search);

    let iconsOnly = false;
    const viewToggle = document.createElement('button');
    viewToggle.type = 'button';
    viewToggle.className = 'fm-btn cs-view-toggle';
    controls.appendChild(viewToggle);

    const list = document.createElement('div');
    list.className = 'cs-list';

    const footer = document.createElement('div');
    footer.className = 'cs-footer';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.className = 'cs-btn';
    footer.appendChild(cancel);

    panel.appendChild(header);
    panel.appendChild(controls);
    panel.appendChild(list);
    panel.appendChild(footer);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);

    const cleanup = (result) => {
      try { document.body.removeChild(overlay); } catch {}
      resolve(result);
    };

    cancel.addEventListener('click', () => cleanup(null));
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) cleanup(null);
    });

    const thumbCache = new Map();
    const gallery = new ModelLibraryView({
      container: list,
      iconsOnly,
      allowDelete: false,
      showOpenButton: false,
      loadThumbnail: async (item, imgEl) => {
        if (!item || !imgEl) return;
        if (item.thumbnail) {
          imgEl.src = item.thumbnail;
          thumbCache.set(item.name, item.thumbnail);
          return;
        }
        if (!item.data3mf) {
          if (thumbCache.has(item.name)) {
            const cached = thumbCache.get(item.name);
            if (cached) imgEl.src = cached;
          }
          return;
        }
        if (thumbCache.has(item.name)) {
          const cached = thumbCache.get(item.name);
          if (cached) {
            imgEl.src = cached;
            return;
          }
        }
        const src = await extractThumbnailFrom3MFBase64(item.data3mf);
        if (src) {
          thumbCache.set(item.name, src);
          imgEl.src = src;
        }
      },
      onOpen: async (name) => {
        const record = getComponentRecord(name);
        if (!record || !record.data3mf) {
          cleanup(null);
          return;
        }
        cleanup(record);
      },
      emptyMessage: records.length ? 'No components match the search.' : 'No stored components found.',
    });

    const updateViewToggle = () => {
      if (!viewToggle) return;
      if (iconsOnly) {
        viewToggle.textContent = '☰';
        viewToggle.title = 'Switch to list view';
      } else {
        viewToggle.textContent = '🔳';
        viewToggle.title = 'Switch to grid view';
      }
    };
    updateViewToggle();

    const render = () => {
      const term = (search.value || '').trim().toLowerCase();
      const matches = !term
        ? records
        : records.filter((rec) => rec.name.toLowerCase().includes(term));
      const mapped = matches.map(({ name, savedAt, record }) => ({
        name,
        savedAt,
        data3mf: record?.data3mf || null,
        thumbnail: record?.thumbnail || null,
      }));
      const emptyMessage = records.length ? 'No components match the search.' : 'No stored components found.';
      gallery.setEmptyMessage(emptyMessage);
      gallery.setIconsOnly(iconsOnly);
      gallery.render(mapped);
    };

    viewToggle.addEventListener('click', () => {
      iconsOnly = !iconsOnly;
      updateViewToggle();
      gallery.setIconsOnly(iconsOnly);
      render();
    });

    search.addEventListener('input', render);
    render();

    requestAnimationFrame(() => {
      try { search.focus(); } catch {}
    });
  });
}

(function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById('component-selector-styles')) return;
  const style = document.createElement('style');
  style.id = 'component-selector-styles';
  style.textContent = `
    .component-selector-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.45);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2000;
    }
    .component-selector-panel {
      width: min(560px, 90vw);
      max-height: 80vh;
      background: #111827;
      border: 1px solid #1f2937;
      border-radius: 12px;
      box-shadow: 0 24px 48px rgba(0,0,0,0.45);
      display: flex;
      flex-direction: column;
      overflow: hidden;
      color: #e5e7eb;
      font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    }
    .cs-header {
      font-weight: 600;
      padding: 14px 18px;
      border-bottom: 1px solid #1f2937;
      background: rgba(255,255,255,0.03);
    }
    .cs-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 18px 0 18px;
    }
    .cs-search {
      margin: 0;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid #374151;
      background: #0b0e14;
      color: inherit;
      outline: none;
      flex: 1 1 auto;
    }
    .cs-search:focus {
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59,130,246,0.25);
    }
    .cs-list {
      flex: 1 1 auto;
      overflow-y: auto;
      padding: 12px;
    }
    .cs-view-toggle {
      flex: 0 0 auto;
    }
    .cs-empty {
      padding: 32px 18px;
      text-align: center;
      color: #9ca3af;
    }
    .cs-footer {
      padding: 12px 18px;
      border-top: 1px solid #1f2937;
      display: flex;
      justify-content: flex-end;
    }
    .cs-btn {
      appearance: none;
      border: 1px solid #374151;
      background: rgba(255,255,255,0.05);
      color: #f9fafb;
      padding: 6px 12px;
      border-radius: 8px;
      font-weight: 600;
      cursor: pointer;
      transition: border-color 0.15s ease, background-color 0.15s ease;
    }
    .cs-btn:hover {
      border-color: #3b82f6;
      background: rgba(59,130,246,0.12);
    }
  `;
  document.head.appendChild(style);
})();
