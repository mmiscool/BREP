# Dialog Screenshots

1. Run `pnpm dev` and open at least one of the capture helper pages:
   - `http://localhost:5173/feature-dialog-capture.html`
   - `http://localhost:5173/pmi-dialog-capture.html`
   - `http://localhost:5173/assembly-constraint-capture.html`
2. With the dev server running, execute `pnpm capture` to export every dialog screenshot. Outputs land in:
   - `docs/features` (feature dialogs)
   - `docs/pmi-annotations` (PMI annotations)
   - `docs/assembly-constraints` (assembly constraints)

## Configuration

Customize the automation with environment variables:

- `CAPTURE_SCOPE=features,pmi` limits which capture helpers are processed.
- `CAPTURE_BASE_URL=http://127.0.0.1:5174` points to a dev server running on a different host/port.
- `CAPTURE_URL` + `CAPTURE_OUTPUT` run a one-off capture against any URL.
- `CAPTURE_DEVICE_SCALE_FACTOR=1` (default `2`) controls the browser’s device pixel ratio for sharper or softer renders.
- `CAPTURE_OUTPUT_SCALE=device` keeps the full hi-DPI image size instead of downscaling back to CSS pixels (default `css` keeps the files small while retaining clarity).
