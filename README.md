# prompts

A static browser for Claude Code `/export` transcripts.

## Adding transcripts

Drop a folder of `.txt` exports into the repo root (e.g. `leman/`), then rebuild:

```sh
node build.mjs              # every top-level folder that holds .txt exports
node build.mjs leman other  # only these folders
```

This writes the site to `dist/` (gitignored): the page, a `manifest.json` of sessions, and
copies of the transcripts under `dist/sessions/`. Each top-level folder becomes a group in the
sidebar. Preview with `python3 -m http.server -d dist`.

## Publishing

`.github/workflows/pages.yml` runs the build and deploys `dist/` on every push to `main`. To turn
it on, set the repo's Settings → Pages → Source to "GitHub Actions". Only the exports and
`src/` are committed; the site is rebuilt from them each time.

## Layout

- `src/parse.js`: transcript parser, used by both the build and the page
- `src/app.js`, `src/index.html`: the viewer
- `build.mjs`: scans folders and writes `dist/`
