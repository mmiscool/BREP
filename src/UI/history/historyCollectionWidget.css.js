export const HISTORY_COLLECTION_WIDGET_CSS = `
  *{font:12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace}
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
  .hc-item:hover {
    border-color: white;
  }
  .hc-header-row {
    display: flex;
    align-items: stretch;
    gap: 0px;
    padding: 2px 5px;
    padding-right: 130px;
    position: relative;
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
    gap: 2px;
    min-width: 0;
    flex: 1 1 auto;
  }
  .hc-title {
    font-size: 14px;
    font-weight: 600;
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hc-subline {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .hc-controls {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    right: 3px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 0;
    z-index: 2;
  }
  .hc-controls .hc-btn {
    width: 32px;
    height: 32px;
    padding: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
  }
  .hc-meta {
    display: inline-flex;
    align-items: center;
    font-size: 12px;
    color: var(--muted);
    gap: 6px;
    padding-right: 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
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
  .hc-item.annotation-disabled .hc-meta {
    opacity: 0.55;
  }
  .hc-btn {
    appearance: none;
    background: var(--bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 8px;
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
    box-shadow: 0 0 0 2px rgba(59,130,246,.18);
  }
  .hc-btn:not(:disabled):active {
    transform: translateY(1px);
  }
  .hc-btn.danger:not(:disabled):hover {
    border-color: var(--danger);
    box-shadow: 0 0 0 2px rgba(239,68,68,.2);
  }
  .hc-body {
    padding: 8px 12px 12px;
    margin-top: 6px;
    background: #0c0f16;
    border-top: 1px solid var(--border);
    border-radius: 0 0 10px 10px;
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
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
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
    position: static;
    align-self: stretch;
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 10px;
    box-shadow: 0 6px 20px rgba(0,0,0,.3);
    padding: 6px;
    box-sizing: border-box;
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
