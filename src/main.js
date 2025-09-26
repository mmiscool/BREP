// App entry: create the main Viewer and expose as window.env
import { Viewer } from './UI/viewer.js';

const containerEl = document.getElementById('viewport');
const sidebarEl = document.getElementById('sidebar');

if (!containerEl) throw new Error('Missing #viewport element');

const viewer = new Viewer({ container: containerEl, sidebar: sidebarEl });

try { window.env = viewer; } catch {}

// Viewer registers default toolbar buttons internally; the "tests" button
// loads the Browser Testing UI on demand.

