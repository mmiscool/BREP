export const HISTORY_COLLECTION_WIDGET_CSS = `
  :host, .hc-widget {
    --bg: #0f1117;
    --bg-elev: #12141b;
    --border: #262b36;
    --text: #e6e6e6;
    --muted: #9aa4b2;
    --accent: #6ea8fe;
    --focus: #3b82f6;
    --danger: #ef4444;
    --input-bg: #0b0e14;
    --radius: 12px;
    color-scheme: dark;
  }
  .hc-widget {
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 6px;
    box-shadow: 0 6px 24px rgba(0,0,0,.35);
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 100%;
  }
  .hc-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hc-item {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: linear-gradient(180deg, rgba(255,255,255,.02), rgba(255,255,255,.01));
    overflow: hidden;
  }
  .hc-header-row {
    display: flex;
    align-items: stretch;
    gap: 0px;
  }
  .hc-toggle {
    appearance: none;
    background: transparent;
    color: var(--text);
    border: 0;
    padding: 0px;
    text-align: left;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    flex: 1 1 auto;
    min-width: 0;
  }
  .hc-toggle:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
  .hc-toggle-main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .hc-title {
    font-size: 14px;
    font-weight: 600;
  }
  .hc-type {
    font-size: 11px;
    color: var(--muted);
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
  .hc-controls {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    margin-left: auto;
  }
  .hc-meta {
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
    gap: 6px;
    padding-right: 4px;
    white-space: nowrap;
  }
  .hc-entry-toggle {
    display: inline-flex;
    align-items: center;
    padding-left: 4px;
    padding-right: 2px;
  }
  .hc-entry-toggle-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--accent);
  }
  .hc-item.annotation-disabled .hc-title,
  .hc-item.annotation-disabled .hc-type,
  .hc-item.annotation-disabled .hc-meta {
    opacity: 0.55;
  }
  .hc-btn {
    appearance: none;
    background: linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03));
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 999px;
    padding: 6px 10px;
    cursor: pointer;
    font-size: 12px;
    transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
  }
  .hc-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }
  .hc-btn:not(:disabled):hover {
    border-color: var(--focus);
    box-shadow: 0 0 0 3px rgba(59,130,246,.15);
  }
  .hc-btn:not(:disabled):active {
    transform: translateY(1px);
  }
  .hc-btn.danger:not(:disabled):hover {
    border-color: var(--danger);
    box-shadow: 0 0 0 3px rgba(239,68,68,.2);
  }
  .hc-body {
    padding: 0 12px 12px;
  }
  .hc-missing {
    padding: 12px;
    font-size: 13px;
    color: var(--muted);
  }
  .hc-empty {
    padding: 20px;
    text-align: center;
    color: var(--muted);
    font-size: 13px;
    border: 1px dashed var(--border);
    border-radius: 10px;
  }
  .hc-footer {
    position: relative;
    margin-top: 6px;
    padding-top: 10px;
    border-top: 1px dashed var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .hc-add-btn {
    appearance: none;
    border: 1px solid var(--border);
    background: linear-gradient(180deg, rgba(255,255,255,.03), rgba(255,255,255,.02));
    color: var(--text);
    border-radius: 9999px;
    padding: 6px 10px;
    width: 36px;
    height: 36px;
    line-height: 24px;
    text-align: center;
    cursor: pointer;
    transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
  }
  .hc-footer.menu-open .hc-add-btn,
  .hc-add-btn:hover {
    border-color: var(--focus);
    box-shadow: 0 0 0 3px rgba(59,130,246,.15);
  }
  .hc-add-btn:active {
    transform: translateY(1px);
  }
  .hc-add-btn:disabled {
    opacity: 0.5;
    cursor: default;
    box-shadow: none;
    border-color: var(--border);
  }
  .hc-add-menu {
    position: absolute;
    bottom: 48px;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 10px 30px rgba(0,0,0,.45);
    padding: 6px;
    z-index: 5;
  }
  .hc-menu-item {
    appearance: none;
    width: 100%;
    text-align: left;
    background: transparent;
    color: var(--text);
    border: 0;
    border-radius: 8px;
    padding: 8px 10px;
    cursor: pointer;
    transition: background-color .12s ease, color .12s ease;
  }
  .hc-menu-item:hover {
    background: rgba(110,168,254,.12);
    color: #fff;
  }
  .hc-menu-empty {
    padding: 10px;
    color: var(--muted);
    text-align: center;
  }
`;
