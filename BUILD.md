# Build Instructions

## Requirements

- **OS:** Any (Linux, macOS, Windows)
- **Node.js:** v20.x or later
- **npm:** v10.x or later

## Steps

```bash
# 1. Install dependencies
npm install

# 2. Build the Firefox extension
npm run build:firefox
```

The built extension will be at `.output/firefox-mv2/`.

## Build Scripts

| Command | Target |
|---------|--------|
| `npm run build` | Chrome (MV3) |
| `npm run build:firefox` | Firefox (MV2) |
| `npm run build:edge` | Edge (MV3) |

## Tools Used

- **WXT** (wxt.dev) — Web Extension Tooling framework. Compiles TypeScript entrypoints into browser extension bundles.
- **Vite** — Bundler used by WXT. Combines and minifies source files.
- **TypeScript** — Source language, compiled to JavaScript.

All tools are installed via `npm install` from `package.json`. No global installs required.

## Source Code

All source files are in `src/`. No source files are transpiled, concatenated, or machine-generated prior to the build step.

Repository: https://github.com/SC-Bridge/sc-bridge-sync
