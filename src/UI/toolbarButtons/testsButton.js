// Adds a "tests" toolbar button that opens the Browser Testing window on demand.

export function createTestsButton(viewer) {
  if (!viewer) return null;

  let tester = null;

  return {
    label: 'tests',
    title: 'Open browser tests',
    onClick: async () => {
      try {
        if (!tester) {
          const mod = await import('../../tests/browserTests.js');
          const { BrowserTesting } = mod || {};
          if (typeof BrowserTesting !== 'function') return;
          tester = new BrowserTesting({ viewer });
        } else {
          tester.toggle?.();
        }
      } catch (e) {
        try { console.warn('Failed to open Browser Testing:', e); } catch {}
      }
    },
  };
}

export default createTestsButton;

