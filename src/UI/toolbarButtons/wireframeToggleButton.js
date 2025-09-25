export function createWireframeToggleButton(viewer) {
  const onClick = () => { try { viewer?.toggleWireframe?.(); } catch {} };
  return { label: '🕸️', title: 'Toggle wireframe', onClick };
}

