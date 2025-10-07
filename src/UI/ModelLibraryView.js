const STYLE_ID = 'model-library-styles';

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .fm-row { display: flex; align-items: center; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #1f2937; background: transparent; transition: background-color .12s ease; }
    .fm-row:hover { background: #0f172a; }
    .fm-row.header { background: #111827; border-bottom: 1px solid #1f2937; padding-bottom: 8px; margin-bottom: 4px; }
    .fm-row:last-child { border-bottom: 0; }
    .fm-row.is-selected { background: rgba(59,130,246,.18); }
    .fm-grow { flex: 1 1 auto; overflow: hidden; }
    .fm-thumb { flex: 0 0 auto; width: 60px; height: 60px; border-radius: 6px; border: 1px solid #1f2937; background: #0b0e14; object-fit: contain; image-rendering: auto; }
    .fm-name { font-weight: 600; color: #e5e7eb; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; }
    .fm-date { font-size: 11px; color: #9ca3af; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .fm-btn { background: rgba(255,255,255,.03); color: #f9fafb; border: 1px solid #374151; padding: 2px 6px; border-radius: 8px; cursor: pointer; font-weight: 700; font-size: 12px; line-height: 1; min-width: 26px; height: 24px; display: inline-flex; align-items: center; justify-content: center; transition: border-color .15s ease, background-color .15s ease, transform .05s ease; }
    .fm-btn:hover { border-color: #3b82f6; background: rgba(59,130,246,.12); }
    .fm-btn:active { transform: translateY(1px); }
    .fm-btn.danger { border-color: #7f1d1d; color: #fecaca; }
    .fm-btn.danger:hover { border-color: #ef4444; background: rgba(239,68,68,.15); color: #fff; }
    .fm-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(84px, 1fr)); gap: 8px; padding: 6px; }
    .fm-item { position: relative; display: flex; align-items: center; justify-content: center; padding: 8px; border: 1px solid #1f2937; border-radius: 8px; background: transparent; transition: background-color .12s ease, border-color .12s ease; cursor: pointer; }
    .fm-item:hover { background: #0f172a; border-color: #334155; }
    .fm-item.is-selected { border-color: #3b82f6; box-shadow: 0 0 0 2px rgba(59,130,246,.25); }
    .fm-item .fm-thumb { width: 60px; height: 60px; border: 1px solid #1f2937; background: #0b0e14; border-radius: 6px; }
    .fm-item .fm-del { position: absolute; top: 4px; right: 4px; width: 22px; height: 22px; padding: 0; line-height: 1; }
    .fm-empty { padding: 12px; color: #94a3b8; text-align: center; font-size: 13px; }
  `;
  document.head.appendChild(style);
}

export class ModelLibraryView {
  constructor({
    container,
    iconsOnly = false,
    allowDelete = false,
    showOpenButton = true,
    openButtonLabel = '📂',
    deleteButtonLabel = '✕',
    onOpen,
    onDelete,
    loadThumbnail,
    emptyMessage = 'No entries.',
    selectedName = null,
  } = {}) {
    if (!container) throw new Error('ModelLibraryView requires a container element.');
    ensureStyles();
    this.container = container;
    this.iconsOnly = !!iconsOnly;
    this.allowDelete = !!allowDelete;
    this.showOpenButton = showOpenButton !== false;
    this.openButtonLabel = openButtonLabel;
    this.deleteButtonLabel = deleteButtonLabel;
    this.onOpen = typeof onOpen === 'function' ? onOpen : () => {};
    this.onDelete = typeof onDelete === 'function' ? onDelete : null;
    this.loadThumbnail = typeof loadThumbnail === 'function' ? loadThumbnail : null;
    this.emptyMessage = emptyMessage;
    this.selectedName = selectedName;
  }

  setIconsOnly(flag) {
    this.iconsOnly = !!flag;
  }

  setSelected(name) {
    this.selectedName = name || null;
  }

  setEmptyMessage(message) {
    this.emptyMessage = message;
  }

  render(items) {
    const list = Array.isArray(items) ? items : [];
    while (this.container.firstChild) this.container.removeChild(this.container.firstChild);
    if (!list.length) {
      const empty = document.createElement('div');
      empty.className = 'fm-empty';
      empty.textContent = this.emptyMessage;
      this.container.appendChild(empty);
      return;
    }
    if (this.iconsOnly) {
      this._renderIconsView(list);
    } else {
      this._renderListView(list);
    }
  }

  _renderListView(items) {
    for (const entry of items) {
      const row = document.createElement('div');
      row.className = 'fm-row';
      if (this.selectedName && entry.name === this.selectedName) row.classList.add('is-selected');

      const thumb = document.createElement('img');
      thumb.className = 'fm-thumb';
      thumb.alt = `${entry.name} thumbnail`;
      this._applyThumbnail(entry, thumb);
      thumb.addEventListener('click', () => this.onOpen(entry.name, entry));
      row.appendChild(thumb);

      const left = document.createElement('div');
      left.className = 'fm-left fm-grow';
      const nameBtn = document.createElement('div');
      nameBtn.className = 'fm-name';
      nameBtn.textContent = entry.name;
      nameBtn.addEventListener('click', () => this.onOpen(entry.name, entry));
      left.appendChild(nameBtn);
      const dateLine = document.createElement('div');
      dateLine.className = 'fm-date';
      const dt = new Date(entry.savedAt);
      dateLine.textContent = isNaN(dt) ? String(entry.savedAt || '') : dt.toLocaleString();
      left.appendChild(dateLine);
      row.appendChild(left);

      if (this.showOpenButton) {
        const openBtn = document.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'fm-btn';
        openBtn.textContent = this.openButtonLabel;
        openBtn.addEventListener('click', () => this.onOpen(entry.name, entry));
        row.appendChild(openBtn);
      }

      if (this.allowDelete && this.onDelete) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'fm-btn danger';
        delBtn.textContent = this.deleteButtonLabel;
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onDelete(entry.name, entry);
        });
        row.appendChild(delBtn);
      }

      this.container.appendChild(row);
    }
  }

  _renderIconsView(items) {
    const grid = document.createElement('div');
    grid.className = 'fm-grid';
    this.container.appendChild(grid);

    for (const entry of items) {
      const cell = document.createElement('div');
      cell.className = 'fm-item';
      if (this.selectedName && entry.name === this.selectedName) cell.classList.add('is-selected');
      const timestamp = new Date(entry.savedAt);
      const timeLabel = isNaN(timestamp) ? String(entry.savedAt || '') : timestamp.toLocaleString();
      cell.title = `${entry.name}\n${timeLabel}`;
      cell.addEventListener('click', () => this.onOpen(entry.name, entry));

      const img = document.createElement('img');
      img.className = 'fm-thumb';
      img.alt = `${entry.name} thumbnail`;
      this._applyThumbnail(entry, img);
      cell.appendChild(img);

      if (this.allowDelete && this.onDelete) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'fm-btn danger fm-del';
        delBtn.textContent = this.deleteButtonLabel;
        delBtn.title = `Delete ${entry.name}`;
        delBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          this.onDelete(entry.name, entry);
        });
        cell.appendChild(delBtn);
      }

      grid.appendChild(cell);
    }
  }

  _applyThumbnail(entry, imgEl) {
    if (!this.loadThumbnail || !imgEl) return;
    if (entry?.thumbnail) {
      try { imgEl.src = entry.thumbnail; } catch {}
    }
    try {
      const res = this.loadThumbnail(entry, imgEl);
      if (res && typeof res.then === 'function') {
        res.catch(() => {});
      }
    } catch {
      // ignore thumbnail load errors
    }
  }
}
