export function createAboutButton() {
  const onClick = () => { try { window.open('../../help/index.html', '_blank'); } catch {} };
  return { label: 'ℹ️', title: 'Open About page', onClick };
}

