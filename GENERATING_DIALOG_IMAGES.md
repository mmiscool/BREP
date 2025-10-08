# Generating Feature Dialog Images

The docs rely on a Playwright script that captures each feature dialog from the `feature-dialog-capture.html` page and writes PNGs into `docs/features`. Follow the steps below whenever you need to refresh those images.

## 1. Install dependencies (first-time setup)

```bash
pnpm install
pnpm exec playwright install chromium
```

Playwright needs its Chromium runtime the first time you run the capture script. You can skip the second command if the browsers have already been installed on your machine.

## 2. Start the local capture page

```bash
pnpm dev
```

Keep the dev server running; it hosts `http://localhost:5173/feature-dialog-capture.html`, which renders every registered feature dialog.

## 3. Run the automated capture

Open a second terminal and execute:

```bash
pnpm capture
```

The script in `scripts/capture.js` launches Playwright headlessly, waits for all `.dialog-card` elements to render, and saves each dialog as `<FeatureName>.png` in `docs/features`. Existing files will be overwritten.

## 4. Optional configuration

- `CAPTURE_URL` overrides the page to open (defaults to `http://localhost:5173/feature-dialog-capture.html`).
- `CAPTURE_OUTPUT` changes the output directory (defaults to `docs/features`, relative to the repo root).

Example:

```bash
CAPTURE_URL=http://127.0.0.1:4173/feature-dialog-capture.html \
CAPTURE_OUTPUT=docs/features-new \
pnpm capture
```

## 5. Verify the results

Once the script finishes, review the generated PNGs under `docs/features` and commit any changes needed for the docs.
