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
    display: grid;
    grid-template-columns: 1fr auto;
    align-items: stretch;
  }
  .hc-toggle {
    appearance: none;
    background: transparent;
    color: var(--text);
    border: 0;
    padding: 10px 12px;
    text-align: left;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .hc-toggle:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
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
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 4px 2px;
    border-top: 1px solid rgba(255,255,255,0.04);
    margin-top: 2px;
  }
  .hc-add-label {
    font-size: 12px;
    color: var(--muted);
  }
  .hc-add-select {
    flex: 1 1 auto;
    background: var(--input-bg);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 8px 10px;
    font-size: 13px;
  }
  .hc-add-select:focus-visible {
    outline: 2px solid var(--focus);
    outline-offset: 2px;
  }
`;
