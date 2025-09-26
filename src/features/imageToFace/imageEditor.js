// Image editor that displays as a full screen paint-like editor

export class ImageEditorUI {
    // onSaveCallback can be a function (dataUrl)=>void, or an object { onSave, onCancel }
    constructor(imageBase64, onSaveCallback) {
        this.imageBase64 = imageBase64 || '';
        this.onSaveCallback = typeof onSaveCallback === 'function' ? onSaveCallback : (onSaveCallback && onSaveCallback.onSave) || null;
        this.onCancelCallback = (onSaveCallback && onSaveCallback.onCancel) || null;

        // Drawing state
        this.tool = 'brush'; // 'brush' | 'eraser' | 'pan' | 'bucket'
        this.brushColor = '#000000';
        this.brushSize = 8;
        this.brushShape = 'round'; // 'round' | 'square' | 'diamond'
        this.bucketTolerance = 0; // 0-255, max per-channel diff
        this.isDrawing = false;
        this.isPanning = false;
        this.isHovering = false;
        this.lastX = 0;
        this.lastY = 0;
        this.hoverX = 0;
        this.hoverY = 0;
        this.scale = 1;
        this.offsetX = 0;
        this.offsetY = 0;
        this.minScale = 0.1;
        this.maxScale = 10;

        // Working canvas logical size (in image pixels)
        this.workWidth = 0;
        this.workHeight = 0;

        // Resize-handle interaction
        this.isResizingCanvas = false;
        this.resizeHandleSize = 12; // screen px for hit area and drawing

        // Initial view state flag
        this._didInitialView = false;

        // Canvas state (image-space backing buffer for edits)
        this.bgImage = null; // HTMLImageElement
        this.drawCanvas = null; // offscreen edits at image resolution
        this.drawCtx = null;

        // Undo stack for the draw layer (image-space)
        this.undoStack = [];
        this.redoStack = [];
        this.maxHistory = 30;

        // DOM elements
        this.overlay = null;
        this.toolbar = null;
        this.canvas = null; // display canvas
        this.ctx = null;
        this.finishBtn = null;
        this.cancelBtn = null;
        this.colorInput = null;
        this.sizeInput = null;
        this.brushBtn = null;
        this.eraserBtn = null;
        this.undoBtn = null;
        this.redoBtn = null;

        this._bound = {};

        this._initDOM();
        this._loadImage(this.imageBase64).then(() => {/* one-to-one set in _loadImage */ });
    }

    // ----------------------------- Public API -----------------------------
    open() {
        if (!this.overlay) return;
        if (!document.body.contains(this.overlay)) document.body.appendChild(this.overlay);
        this._attachEvents();
        // Ensure initial 1:1 view once canvas has real size
        this._maybeResetInitialView(true);
        this._render();
    }

    close() {
        this._detachEvents();
        if (this.overlay && this.overlay.parentNode) this.overlay.parentNode.removeChild(this.overlay);
    }

    // ---------------------------- Initialization ---------------------------
    _initDOM() {
        // Overlay
        const overlay = document.createElement('div');
        overlay.className = 'img-editor-overlay';
        overlay.innerHTML = `
      <style>
        .img-editor-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:100;color:var(--ie-fg);font-family:system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif;}
        .img-editor-toolbar{position:absolute;left:0;right:0;top:0;height:48px;background:var(--ie-bg-2);border-bottom:1px solid var(--ie-border);display:flex;align-items:center;gap:12px;padding:0 12px;}
        .img-editor-spacer{flex:1 1 auto;}
        .img-editor-btn{border:1px solid var(--ie-border);background:var(--ie-bg-3);color:var(--ie-fg);border-radius:6px;padding:6px 10px;cursor:pointer;line-height:1;}
        .img-editor-btn.active{background:var(--ie-accent-bg);border-color:var(--ie-accent);color:var(--ie-accent-fg)}
        .img-editor-btn:disabled{opacity:.5;cursor:not-allowed;}
        .img-editor-right{margin-left:auto;display:flex;gap:8px;}
        .img-editor-canvas-wrap{position:absolute;left:0;right:0;top:48px;bottom:0;overflow:hidden;background:var(--ie-bg-1);}
        .img-editor-canvas{position:absolute;left:0;top:0;display:block;}
        .img-editor-group{display:flex;align-items:center;gap:6px;border-right:1px dashed var(--ie-border);padding-right:10px;margin-right:8px;}
        .img-editor-label{font-size:12px;color:var(--ie-muted);}
        .img-editor-color{width:32px;height:28px;border:1px solid var(--ie-border);border-radius:4px;padding:0;background:var(--ie-bg-3)}
        .img-editor-range{width:120px}
        .img-editor-select{height:28px;border:1px solid var(--ie-border);border-radius:4px;background:var(--ie-bg-3);color:var(--ie-fg);}
        /* Light defaults */
        .img-editor-overlay{--ie-bg-1:#111;--ie-bg-2:#1a1a1a;--ie-bg-3:#2a2a2a;--ie-fg:#f3f3f3;--ie-muted:#c0c0c0;--ie-border:#3a3a3a;--ie-accent:#69f;--ie-accent-bg:#143a66;--ie-accent-fg:#e8f2ff}
        @media (prefers-color-scheme: light){
          .img-editor-overlay{--ie-bg-1:#f7f7f7;--ie-bg-2:#f4f4f4;--ie-bg-3:#ffffff;--ie-fg:#111;--ie-muted:#555;--ie-border:#ddd;--ie-accent:#69f;--ie-accent-bg:#e6f2ff;--ie-accent-fg:#113355}
        }
      </style>
      <div class="img-editor-toolbar">
        <div class="img-editor-group">
            <input type="color" class="img-editor-color js-color" value="#000000"/>
            <button class="img-editor-btn js-brush" title="Brush (B)">Brush</button>
            <select class="img-editor-select js-shape">
                <option value="round" selected>Round</option>
                <option value="square">Square</option>
                <option value="diamond">Diamond</option>
            </select>
            <label class="img-editor-label">Size</label>
            <input type="range" min="1" max="64" value="8" class="img-editor-range js-size"/>
            <button class="img-editor-btn js-eraser" title="Eraser (E)">Eraser</button>
            <button class="img-editor-btn js-pan" title="Pan (Hold Space)">Pan</button>
        </div>
        <div class="img-editor-group">
            <button class="img-editor-btn js-bucket" title="Paint Bucket (G)">Bucket</button>
            <label class="img-editor-label">Tolerance</label>
            <input type="range" min="0" max="255" value="0" class="img-editor-range js-bucket-tol"/>
        </div>
        <div class="img-editor-group">
            <button class="img-editor-btn js-undo" title="Undo (Ctrl+Z)">↶</button>
            <button class="img-editor-btn js-redo" title="Redo (Ctrl+Y)">↷</button>
            <button class="img-editor-btn js-fit" title="Fit (F)">Fit</button>
        </div>
        <div class="img-editor-spacer"></div>
        <div class="img-editor-right">
            <button class="img-editor-btn js-finish" title="Finish (Enter)">Finish</button>
            <button class="img-editor-btn js-cancel" title="Cancel (Esc)">Cancel</button>
        </div>
      </div>
      <div class="img-editor-canvas-wrap">
        <canvas class="img-editor-canvas"></canvas>
      </div>
    `;

        const canvas = overlay.querySelector('canvas');
        const toolbar = overlay.querySelector('.img-editor-toolbar');
        this.overlay = overlay;
        this.toolbar = toolbar;
        this.canvas = canvas;
        this.ctx = this.canvas.getContext('2d');
        this.colorInput = overlay.querySelector('.js-color');
        this.sizeInput = overlay.querySelector('.js-size');
        this.brushBtn = overlay.querySelector('.js-brush');
        this.eraserBtn = overlay.querySelector('.js-eraser');
        this.panBtn = overlay.querySelector('.js-pan');
        this.bucketBtn = overlay.querySelector('.js-bucket');
        this.undoBtn = overlay.querySelector('.js-undo');
        this.redoBtn = overlay.querySelector('.js-redo');
        this.fitBtn = overlay.querySelector('.js-fit');
        this.finishBtn = overlay.querySelector('.js-finish');
        this.cancelBtn = overlay.querySelector('.js-cancel');
        this.shapeSelect = overlay.querySelector('.js-shape');
        this.bucketTolInput = overlay.querySelector('.js-bucket-tol');

        // Offscreen draw layer (created after image loads to match resolution)
        this.drawCanvas = document.createElement('canvas');
        this.drawCtx = this.drawCanvas.getContext('2d');
    }

    async _loadImage(src) {
        if (!src) return;
        this.bgImage = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = (e) => reject(e);
            img.src = src;
        });
        // match working area and draw canvas to image resolution
        this.workWidth = this.bgImage.width;
        this.workHeight = this.bgImage.height;
        this._resizeDrawCanvas(this.workWidth, this.workHeight, /*preserve*/ false);
        this.drawCtx.clearRect(0, 0, this.drawCanvas.width, this.drawCanvas.height);
        this._pushHistory(); // base state
        // Default view: 1:1 pixel mapping centered (if overlay sized)
        this._maybeResetInitialView(false);
    }

    _attachEvents() {
        const bound = this._bound;
        bound.onResize = () => this._resizeCanvasToViewport();
        bound.onMouseDown = (e) => this._pointerDown(e);
        bound.onMouseMove = (e) => this._pointerMove(e);
        bound.onMouseUp = (e) => this._pointerUp(e);
        bound.onWheel = (e) => this._wheel(e);
        bound.onKey = (e) => this._key(e);
        bound.onColor = (e) => { this.brushColor = e.target.value || '#000000'; this._updateButtons(); };
        bound.onSize = (e) => { this.brushSize = Math.max(1, Math.min(64, Number(e.target.value) || 8)); };
        bound.onBrush = () => { this.tool = 'brush'; this._updateButtons(); };
        bound.onEraser = () => { this.tool = 'eraser'; this._updateButtons(); };
        bound.onPan = () => { this.tool = 'pan'; this._updateButtons(); };
        bound.onBucket = () => { this.tool = 'bucket'; this._updateButtons(); };
        bound.onUndo = () => this._undo();
        bound.onRedo = () => this._redo();
        bound.onFit = () => { this._resetViewToFit(); this._render(); };
        bound.onFinish = () => this._finish();
        bound.onCancel = () => this._cancel();
        bound.onShape = (e) => { const v = String(e.target.value || 'round'); this.brushShape = (v === 'square' || v === 'diamond') ? v : 'round'; this._render(); };
        bound.onBucketTol = (e) => { this.bucketTolerance = Math.max(0, Math.min(255, Number(e.target.value) || 0)); };
        bound.onEnter = () => { this.isHovering = true; };
        bound.onLeave = () => { this.isHovering = false; this._render(); };

        window.addEventListener('resize', bound.onResize);
        this.canvas.addEventListener('mousedown', bound.onMouseDown);
        window.addEventListener('mousemove', bound.onMouseMove);
        window.addEventListener('mouseup', bound.onMouseUp);
        this.canvas.addEventListener('wheel', bound.onWheel, { passive: false });
        window.addEventListener('keydown', bound.onKey);
        window.addEventListener('keyup', bound.onKey);
        this.canvas.addEventListener('mouseenter', bound.onEnter);
        this.canvas.addEventListener('mouseleave', bound.onLeave);

        this.colorInput.addEventListener('input', bound.onColor);
        this.sizeInput.addEventListener('input', bound.onSize);
        this.brushBtn.addEventListener('click', bound.onBrush);
        this.eraserBtn.addEventListener('click', bound.onEraser);
        this.panBtn.addEventListener('click', bound.onPan);
        this.bucketBtn.addEventListener('click', bound.onBucket);
        this.undoBtn.addEventListener('click', bound.onUndo);
        this.redoBtn.addEventListener('click', bound.onRedo);
        this.fitBtn.addEventListener('click', bound.onFit);
        this.finishBtn.addEventListener('click', bound.onFinish);
        this.cancelBtn.addEventListener('click', bound.onCancel);
        this.shapeSelect.addEventListener('change', bound.onShape);
        this.bucketTolInput.addEventListener('input', bound.onBucketTol);

        this._resizeCanvasToViewport();
        this._updateButtons();
    }

    _detachEvents() {
        const b = this._bound;
        window.removeEventListener('resize', b.onResize);
        if (this.canvas) {
            this.canvas.removeEventListener('mousedown', b.onMouseDown);
            this.canvas.removeEventListener('wheel', b.onWheel);
            this.canvas.removeEventListener('mouseenter', b.onEnter);
            this.canvas.removeEventListener('mouseleave', b.onLeave);
        }
        window.removeEventListener('mousemove', b.onMouseMove);
        window.removeEventListener('mouseup', b.onMouseUp);
        window.removeEventListener('keydown', b.onKey);
        window.removeEventListener('keyup', b.onKey);
        if (this.colorInput) this.colorInput.removeEventListener('input', b.onColor);
        if (this.sizeInput) this.sizeInput.removeEventListener('input', b.onSize);
        if (this.brushBtn) this.brushBtn.removeEventListener('click', b.onBrush);
        if (this.eraserBtn) this.eraserBtn.removeEventListener('click', b.onEraser);
        if (this.panBtn) this.panBtn.removeEventListener('click', b.onPan);
        if (this.bucketBtn) this.bucketBtn.removeEventListener('click', b.onBucket);
        if (this.undoBtn) this.undoBtn.removeEventListener('click', b.onUndo);
        if (this.redoBtn) this.redoBtn.removeEventListener('click', b.onRedo);
        if (this.fitBtn) this.fitBtn.removeEventListener('click', b.onFit);
        if (this.finishBtn) this.finishBtn.removeEventListener('click', b.onFinish);
        if (this.cancelBtn) this.cancelBtn.removeEventListener('click', b.onCancel);
        if (this.shapeSelect) this.shapeSelect.removeEventListener('change', b.onShape);
        if (this.bucketTolInput) this.bucketTolInput.removeEventListener('input', b.onBucketTol);
    }

    _resizeCanvasToViewport() {
        if (!this.canvas) return;
        const wrap = this.overlay.querySelector('.img-editor-canvas-wrap');
        const w = wrap.clientWidth | 0;
        const h = wrap.clientHeight | 0;
        if (!w || !h) return;
        const dpr = Math.max(1, Math.floor(window.devicePixelRatio || 1));
        this.canvas.width = Math.max(1, w * dpr);
        this.canvas.height = Math.max(1, h * dpr);
        this.canvas.style.width = w + 'px';
        this.canvas.style.height = h + 'px';
        if (this.ctx) {
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        // If first time sizing and image is ready, set initial view now
        this._maybeResetInitialView(false);
        this._render();
    }

    _resetViewToFit() {
        if (!this.bgImage || !this.canvas) return;
        const wrap = this.overlay.querySelector('.img-editor-canvas-wrap');
        const vw = wrap.clientWidth || 1;
        const vh = wrap.clientHeight || 1;
        const iw = this.workWidth || (this.bgImage?.width || 1);
        const ih = this.workHeight || (this.bgImage?.height || 1);
        const s = Math.min(vw / iw, vh / ih);
        this.scale = Math.max(this.minScale, Math.min(this.maxScale, s));
        this.offsetX = (vw - iw * this.scale) * 0.5;
        this.offsetY = (vh - ih * this.scale) * 0.5;
    }

    _resetViewToOneToOne() {
        if (!this.canvas) return;
        const wrap = this.overlay.querySelector('.img-editor-canvas-wrap');
        const vw = wrap.clientWidth || 1;
        const vh = wrap.clientHeight || 1;
        const iw = this.workWidth || (this.bgImage?.width || 1);
        const ih = this.workHeight || (this.bgImage?.height || 1);
        this.scale = 1; // 1 image px == 1 CSS px
        this.offsetX = (vw - iw * this.scale) * 0.5;
        this.offsetY = (vh - ih * this.scale) * 0.5;
    }

    _maybeResetInitialView(force = false) {
        if (!this.bgImage || !this.canvas || !this.overlay) return;
        const wrap = this.overlay.querySelector('.img-editor-canvas-wrap');
        const vw = wrap && wrap.clientWidth ? wrap.clientWidth : 0;
        const vh = wrap && wrap.clientHeight ? wrap.clientHeight : 0;
        if (!vw || !vh) return; // wait until visible/sized
        if (force || !this._didInitialView) {
            this._resetViewToOneToOne();
            this._didInitialView = true;
        }
    }

    // ------------------------------ Rendering ------------------------------
    _render() {
        const ctx = this.ctx;
        if (!ctx) return;
        ctx.save();
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // image smoothing: disable at 1:1 for crisp pixels
        const isOneToOne = Math.abs(this.scale - 1) < 1e-6;
        ctx.imageSmoothingEnabled = !isOneToOne;
        ctx.imageSmoothingQuality = isOneToOne ? 'low' : 'high';

        // draw background image in view space (anchored at 0,0 of work area)
        if (this.bgImage) {
            ctx.drawImage(this.bgImage, this.offsetX, this.offsetY, this.bgImage.width * this.scale, this.bgImage.height * this.scale);
        }

        // draw edits layer in view space
        if (this.drawCanvas && this.drawCanvas.width > 0) {
            ctx.drawImage(this.drawCanvas, this.offsetX, this.offsetY, this.drawCanvas.width * this.scale, this.drawCanvas.height * this.scale);
        }

        // draw work-area border and resize handle
        if (this.workWidth > 0 && this.workHeight > 0) {
            const x = this.offsetX;
            const y = this.offsetY;
            const w = this.workWidth * this.scale;
            const h = this.workHeight * this.scale;
            ctx.save();
            ctx.strokeStyle = 'rgba(255,255,255,0.6)';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 3]);
            ctx.strokeRect(x + 0.5, y + 0.5, w, h);
            ctx.setLineDash([]);
            // handle square at bottom-right
            const hs = this.resizeHandleSize;
            ctx.fillStyle = 'rgba(255,255,255,0.9)';
            ctx.strokeStyle = 'rgba(0,0,0,0.6)';
            ctx.lineWidth = 1;
            ctx.fillRect(x + w - hs, y + h - hs, hs, hs);
            ctx.strokeRect(x + w - hs + 0.5, y + h - hs + 0.5, hs, hs);
            ctx.restore();
        }
        // draw brush cursor on top
        this._drawBrushPreview(ctx);
        ctx.restore();
    }

    // Draw brush cursor preview (view space)
    _drawBrushPreview(ctx) {
        if (!this.isHovering || !this.canvas) return;
        if (this.tool !== 'brush' && this.tool !== 'eraser') return;
        const cx = this.offsetX + this.hoverX * (this.scale || 1);
        const cy = this.offsetY + this.hoverY * (this.scale || 1);
        const r = Math.max(0.5, (this.brushSize * (this.scale || 1)) / 2);
        ctx.save();
        ctx.beginPath();
        if (this.brushShape === 'square') {
            ctx.rect(cx - r, cy - r, 2 * r, 2 * r);
        } else if (this.brushShape === 'diamond') {
            ctx.moveTo(cx, cy - r);
            ctx.lineTo(cx + r, cy);
            ctx.lineTo(cx, cy + r);
            ctx.lineTo(cx - r, cy);
            ctx.closePath();
        } else {
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
        }
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 2]);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
    }

    // ------------------------------ Interaction ----------------------------
    _canvasToImage(x, y) {
        // Convert screen coords within canvas → image coords
        const ix = (x - this.offsetX) / (this.scale || 1);
        const iy = (y - this.offsetY) / (this.scale || 1);
        return [ix, iy];
    }

    _pointerDown(e) {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        const spacePan = e.buttons === 1 && this._spaceHeld;
        const middlePan = e.buttons === 4; // middle mouse
        const activePan = (this.tool === 'pan') || spacePan || middlePan;

        // Check resize handle first
        if (this._hitResizeHandle(x, y)) {
            this.isResizingCanvas = true;
            this.lastX = x; this.lastY = y;
            return;
        }

        if (activePan) {
            this.isPanning = true;
            this.lastX = x; this.lastY = y;
            return;
        }

        if (e.buttons !== 1) return; // left only for drawing
        const [ix, iy] = this._canvasToImage(x, y);
        // update hover
        this.hoverX = ix; this.hoverY = iy; this.isHovering = true;
        if (this.tool === 'bucket') {
            this._applyBucket(Math.floor(ix), Math.floor(iy));
            this._pushHistory();
            this._render();
            return;
        }
        this.isDrawing = true;
        this.lastX = ix; this.lastY = iy;
        this._applyStroke(ix, iy, true);
    }

    _pointerMove(e) {
        if (!this.canvas) return;
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        // Cursor feedback for resize handle
        if (!this.isPanning && !this.isDrawing && !this.isResizingCanvas) {
            this.canvas.style.cursor = this._hitResizeHandle(x, y) ? 'nwse-resize' : '';
        }

        if (this.isResizingCanvas) {
            // compute new size in image pixels based on mouse position
            const newW = Math.max(1, Math.round((x - this.offsetX) / (this.scale || 1)));
            const newH = Math.max(1, Math.round((y - this.offsetY) / (this.scale || 1)));
            this._resizeWorkArea(newW, newH);
            this._render();
            this.lastX = x; this.lastY = y;
            return;
        }

        if (this.isPanning) {
            const dx = x - this.lastX; const dy = y - this.lastY;
            this.offsetX += dx; this.offsetY += dy;
            this.lastX = x; this.lastY = y;
            this._render();
            return;
        }

        if (this.isDrawing) {
            const [ix, iy] = this._canvasToImage(x, y);
            this._applyStroke(ix, iy, false);
            this.lastX = ix; this.lastY = iy;
            this._render();
            return;
        }

        // Update hover and render cursor preview when idle
        const [hix, hiy] = this._canvasToImage(x, y);
        this.hoverX = hix; this.hoverY = hiy; this.isHovering = true;
        this._render();
    }

    _pointerUp(_e) {
        if (this.isResizingCanvas) { this.isResizingCanvas = false; this._pushHistory(); return; }
        if (this.isPanning) { this.isPanning = false; return; }
        if (!this.isDrawing) return;
        this.isDrawing = false;
        this._pushHistory();
    }

    _hitResizeHandle(viewX, viewY) {
        if (!this.workWidth || !this.workHeight) return false;
        const hs = this.resizeHandleSize;
        const rx = this.offsetX + this.workWidth * this.scale - hs;
        const ry = this.offsetY + this.workHeight * this.scale - hs;
        return viewX >= rx && viewY >= ry && viewX <= rx + hs && viewY <= ry + hs;
    }

    _resizeWorkArea(newW, newH) {
        if (newW === this.workWidth && newH === this.workHeight) return;
        this.workWidth = newW;
        this.workHeight = newH;
        // ensure draw canvas matches work area, preserving edits
        this._resizeDrawCanvas(newW, newH, /*preserve*/ true);
    }

    _resizeDrawCanvas(newW, newH, preserve) {
        const old = this.drawCanvas;
        if (!old || (!preserve && (old.width === newW && old.height === newH))) {
            if (old) { old.width = newW; old.height = newH; this.drawCtx = old.getContext('2d'); }
            return;
        }
        const nc = document.createElement('canvas');
        nc.width = newW; nc.height = newH;
        const nctx = nc.getContext('2d');
        if (preserve && old.width && old.height) {
            nctx.drawImage(old, 0, 0);
        }
        this.drawCanvas = nc;
        this.drawCtx = nctx;
    }

    _applyStroke(ix, iy, start) {
        const ctx = this.drawCtx;
        if (!ctx) return;
        const r = Math.max(0.5, this.brushSize / 2);
        const drawDab = (x, y) => {
            ctx.beginPath();
            if (this.brushShape === 'square') {
                ctx.rect(x - r, y - r, 2 * r, 2 * r);
            } else if (this.brushShape === 'diamond') {
                ctx.moveTo(x, y - r);
                ctx.lineTo(x + r, y);
                ctx.lineTo(x, y + r);
                ctx.lineTo(x - r, y);
                ctx.closePath();
            } else {
                ctx.arc(x, y, r, 0, Math.PI * 2);
            }
            if (this.tool === 'eraser') {
                ctx.globalCompositeOperation = 'destination-out';
                ctx.fillStyle = 'rgba(0,0,0,1)';
            } else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = this.brushColor;
            }
            ctx.fill();
        };

        ctx.save();
        if (start) {
            drawDab(ix, iy);
        } else {
            const sx = this.lastX, sy = this.lastY;
            const dx = ix - sx, dy = iy - sy;
            const dist = Math.hypot(dx, dy);
            const step = Math.max(0.5, r * 0.6);
            const steps = Math.max(1, Math.ceil(dist / step));
            for (let i = 1; i <= steps; i++) {
                const t = i / steps;
                drawDab(sx + dx * t, sy + dy * t);
            }
        }
        ctx.restore();
    }

    _applyBucket(ix, iy) {
        if (!this.workWidth || !this.workHeight) return;
        if (!this.drawCtx) return;
        const w = this.workWidth | 0, h = this.workHeight | 0;
        const x0 = Math.max(0, Math.min(w - 1, Math.floor(ix)));
        const y0 = Math.max(0, Math.min(h - 1, Math.floor(iy)));
        // Composite image for region detection
        const comp = document.createElement('canvas');
        comp.width = w; comp.height = h;
        const cctx = comp.getContext('2d');
        if (this.bgImage) cctx.drawImage(this.bgImage, 0, 0);
        if (this.drawCanvas) cctx.drawImage(this.drawCanvas, 0, 0);
        const id = cctx.getImageData(0, 0, w, h);
        const data = id.data;
        const idx0 = (y0 * w + x0) * 4;
        const tr = data[idx0], tg = data[idx0 + 1], tb = data[idx0 + 2], ta = data[idx0 + 3];
        const target = (ta << 24) | (tb << 16) | (tg << 8) | tr;

        // Flood fill mask
        const stack = [x0, y0];
        const visited = new Uint8Array(w * h);
        const mask = new Uint8Array(w * h);
        const tol = Math.max(0, Math.min(255, this.bucketTolerance | 0));
        while (stack.length) {
            const y = stack.pop() | 0; const x = stack.pop() | 0;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (visited[i]) continue;
            const k = i * 4; const r = data[k], g = data[k + 1], b = data[k + 2];
            // RGB max-channel distance tolerance
            if (Math.max(Math.abs(r - tr), Math.abs(g - tg), Math.abs(b - tb)) > tol) { visited[i] = 1; continue; }
            visited[i] = 1;
            mask[i] = 1;
            stack.push(x - 1, y);
            stack.push(x + 1, y);
            stack.push(x, y - 1);
            stack.push(x, y + 1);
        }

        // Apply fill color to draw layer only
        const di = this.drawCtx.getImageData(0, 0, w, h);
        const dd = di.data;
        const [fr, fg, fb, fa] = this._hexToRgba(this.brushColor, 255);
        for (let i = 0; i < w * h; i++) {
            if (!mask[i]) continue;
            const k = i * 4;
            dd[k] = fr; dd[k + 1] = fg; dd[k + 2] = fb; dd[k + 3] = fa;
        }
        this.drawCtx.putImageData(di, 0, 0);
    }

    _hexToRgba(hex, alphaOverride) {
        let s = String(hex || '').trim();
        if (s[0] === '#') s = s.slice(1);
        if (s.length === 3) s = s.split('').map(ch => ch + ch).join('');
        let r = 0, g = 0, b = 0, a = 255;
        if (s.length >= 6) {
            r = parseInt(s.slice(0, 2), 16) | 0;
            g = parseInt(s.slice(2, 4), 16) | 0;
            b = parseInt(s.slice(4, 6), 16) | 0;
        }
        if (typeof alphaOverride === 'number') a = Math.max(0, Math.min(255, alphaOverride | 0));
        return [r, g, b, a];
    }

    _wheel(e) {
        e.preventDefault();
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        const [ix, iy] = this._canvasToImage(mx, my);
        const delta = e.deltaY > 0 ? 0.9 : 1.1111111;
        const newScale = Math.max(this.minScale, Math.min(this.maxScale, this.scale * delta));
        const k = newScale / (this.scale || 1);
        // zoom around mouse
        this.offsetX = mx - (ix * newScale);
        this.offsetY = my - (iy * newScale);
        this.scale = newScale;
        this._render();
    }

    _key(e) {
        this._spaceHeld = (e.type === 'keydown' && e.code === 'Space') ? true : (e.type === 'keyup' && e.code === 'Space' ? false : this._spaceHeld);
        if (e.type === 'keydown') {
            if (e.key === 'Escape') { this._cancel(); }
            if (e.key === 'Enter') { this._finish(); }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { this._undo(); e.preventDefault(); }
            if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { this._redo(); e.preventDefault(); }
            if (e.key.toLowerCase() === 'b') { this.tool = 'brush'; this._updateButtons(); }
            if (e.key.toLowerCase() === 'e') { this.tool = 'eraser'; this._updateButtons(); }
            if (e.key.toLowerCase() === 'g') { this.tool = 'bucket'; this._updateButtons(); }
            if (e.key.toLowerCase() === 'f') { this._resetViewToFit(); this._render(); }
        }
    }

    _updateButtons() {
        const setActive = (el, on) => { if (!el) return; el.classList.toggle('active', !!on); };
        setActive(this.brushBtn, this.tool === 'brush');
        setActive(this.eraserBtn, this.tool === 'eraser');
        setActive(this.panBtn, this.tool === 'pan');
        setActive(this.bucketBtn, this.tool === 'bucket');
        if (this.colorInput && this.brushColor) this.colorInput.value = this.brushColor;
        if (this.sizeInput) this.sizeInput.value = String(this.brushSize);
        if (this.shapeSelect) this.shapeSelect.value = String(this.brushShape || 'round');
        if (this.undoBtn) this.undoBtn.disabled = this.undoStack.length <= 1;
        if (this.redoBtn) this.redoBtn.disabled = this.redoStack.length === 0;
    }

    // ------------------------------ History --------------------------------
    _pushHistory() {
        if (!this.drawCtx || !this.drawCanvas) return;
        try {
            const snap = this.drawCtx.getImageData(0, 0, this.drawCanvas.width, this.drawCanvas.height);
            this.undoStack.push(snap);
            if (this.undoStack.length > this.maxHistory) this.undoStack.shift();
            this.redoStack.length = 0; // clear redo on new action
            this._updateButtons();
        } catch { }
    }

    _undo() {
        if (this.undoStack.length <= 1) return;
        const current = this.undoStack.pop();
        if (current) this.redoStack.push(current);
        const prev = this.undoStack[this.undoStack.length - 1];
        if (prev) {
            this.drawCtx.putImageData(prev, 0, 0);
            this._render();
            this._updateButtons();
        }
    }

    _redo() {
        if (!this.redoStack.length) return;
        const next = this.redoStack.pop();
        if (next) {
            this.undoStack.push(next);
            this.drawCtx.putImageData(next, 0, 0);
            this._render();
            this._updateButtons();
        }
    }

    // ------------------------------ Finalize --------------------------------
    _finish() {
        // Composite background + draw layer at current work area size
        const w = this.workWidth || this.bgImage?.width || this.drawCanvas?.width || 0;
        const h = this.workHeight || this.bgImage?.height || this.drawCanvas?.height || 0;
        if (!w || !h) { this._cancel(); return; }
        const out = document.createElement('canvas');
        out.width = w; out.height = h;
        const octx = out.getContext('2d');
        if (this.bgImage) octx.drawImage(this.bgImage, 0, 0);
        if (this.drawCanvas) octx.drawImage(this.drawCanvas, 0, 0);
        const dataUrl = out.toDataURL('image/png');
        if (typeof this.onSaveCallback === 'function') {
            try { this.onSaveCallback(dataUrl); } catch { }
        }
        this.close();
    }

    _cancel() {
        if (typeof this.onCancelCallback === 'function') {
            try { this.onCancelCallback(); } catch { }
        }
        this.close();
    }
}
