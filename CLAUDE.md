# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Awa Strobes** is a web-based strobe pattern configurator for ESP32-controlled LED strips. It's a single-page application (SPA) that runs in the browser and communicates with an ESP32 over WebSocket for live preview, and via HTTP POST to upload configurations to the device's MicroSD card.

### Architecture

```
web/
├── index.html      # Single HTML file with all modals, toolbar, table, inspector, preview
├── app.js          # All application logic (~3900 lines, no build step)
├── style.css       # All styling (~880 lines, CSS custom properties)
├── assets/         # SVG icons + toastify.js (minified 3rd-party)
├── package.json    # npm scripts for lint/format (dev dependencies only)
├── eslint.config.js
├── .prettierrc
├── jsconfig.json   # TypeScript checking for JSDoc
└── firmware/
    └── mapping.txt # GPIO pin reference for hardware
```

**No build system, no bundler.** Open `web/index.html` directly in a browser (or serve via any static server). Dev dependencies (ESLint, Prettier) are only for code quality — not required to run the app.

---

## Common Development Commands

| Task | Command |
|------|---------|
| **Run locally** | Open `web/index.html` in browser, or `npx serve web` / `python -m http.server 8000 -d web` |
| **Lint** | `cd web && npm run lint` |
| **Lint + fix** | `cd web && npm run lint:fix` |
| **Format** | `cd web && npm run format` |
| **Check format** | `cd web && npm run format:check` |
| **Type check** | Open in VS Code with JavaScript/TypeScript language server (uses `jsconfig.json`) |
| **Test** | No test suite exists |
| **Create prompt.txt** | Run `ai.bat` (Windows) — concatenates index.html, app.js, style.css into prompt.txt |

---

## High-Level Architecture

### Data Model (`config` object)

```js
{
  _strobe_editor_version: "1",
  channels: 10,
  properties: {
    pwm: { min: 0, max: 255, indicatorOffAtMin: false },
    backgroundDim: { pwm: 50 },
    indicator: { mode: "global"|"per-channel", globalColor: "#ff2a2a", channelColors: [...] },
    ipAddress: "192.168.4.1",
    pinsMapping: [null, 16, 17, ...]  // GPIO per channel
  },
  defaultPattern: { backgroundDim: false, phases: { in, anim, out } },
  patterns: []  // Array of patterns or groups
}
```

**Pattern** (leaf node):
```js
{
  backgroundDim: false,
  state: [0, 255, 0, ...],  // PWM values per channel (0-1023)
  phases: {
    in:    { type: "none"|"fade"|"steady", duration: ms },
    anim:  { type: "none"|"flicker", amount: n, duration: ms },
    out:   { type: "none"|"fade"|"steady", duration: ms }
  }
}
```

**Group** (container):
```js
{ type: "group", repeat: 2, bounce: false, patterns: [Pattern, ...] }
```

Paths addressing patterns: `"2"` (root index 2) or `"2-1"` (child index 1 inside group 2).

### Key Modules in `app.js` (search for `// ====` section banners)

| Section | Responsibility |
|---------|----------------|
| **GLOBAL STATE** | `config`, `appMode`, `selectedPaths`, `historyStack`, `activePath`, `previewMode`, `canvasLayoutData`, `activeTool`, `brushBrightness` |
| **CONFIG MIGRATION** | `migratePattern`, `migrateConfigToPWM`, `migrateConfigProperties`, `ensureConfigDefaults` — upgrade legacy configs |
| **UNDO/REDO** | `saveState`, `undoState`, `redoState`, `applyHistoryState` — 50-step history persisted to localStorage |
| **SELECTION** | `selectedPaths` Set, drag-to-select, keyboard shortcuts, `selectionHistoryStack` for selection undo |
| **TABLE RENDERING** | `renderTable`, `createPatternRowHTML` — builds pattern list with state blocks, timeline summary, actions |
| **INSPECTOR PANEL** | `renderInspector`, `updatePhase`, `updateInspectorChannelVolume` — context-sensitive editor for active pattern or selection |
| **PLAYBACK ENGINE** | `playStrobe`, `playSinglePattern`, `stopStrobe` — async loop driving `renderLights` with phase timing |
| **LIGHT PREVIEW** | `renderLights` — draws to linear bar (`#light-bar`) and free-form canvas (`#custom-layout-view`), also sends WebSocket `LIVE` frames |
| **WEBSOCKET SYNC** | `initWebSocket` (auto-reconnect), `broadcastLiveState`, `uploadConfigToESP32` (HTTP POST to `/upload`) |
| **CUSTOM CANVAS** | `canvasLayoutData` (persisted to localStorage), drag-to-position, shape selector (circle/square/rectangle) |
| **PAINT TOOL** | `activeTool` (hybrid/paint/erase), `brushBrightness`, `startPaintStrokeDrag`/`paintTargetCellNode` — cell-level painting in table |
| **JSON PANEL** | `updateJsonPanel`, `handleManualJsonEdit`, `getOrderedConfig` — ordered serialization with compact `state` arrays |
| **SETTINGS MODALS** | Project settings (PWM range, IP, pin mapping, colors), Preferences (brush increment, step indicator) |

### State Persistence

- **localStorage keys** (versioned with `v${version}`):
  - `strobe_config_v1` — last saved config
  - `strobe_history_v1` + `strobe_history_index_v1` — undo stack
  - `strobe_show_steps` — boolean
  - `strobe_brush_increment` — number
  - `strobe_canvas_layout_v1` — custom layout positions
  - `strobe_visualizer_height`, `strobe_inspector_width` — panel sizes
- **Config auto-save**: `updateJsonPanel` POSTs to `/save` (no-op on static hosting) and writes localStorage

### Keyboard Shortcuts (from help modal)

| Shortcut | Action |
|----------|--------|
| Space | Toggle Play/Stop |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+S / Ctrl+O | Save / Open JSON |
| Ctrl+T | Toggle Step Indicator |
| Shift+? | Help |
| E / S | Edit / Select mode |
| ↑/↓ | Navigate rows (edit mode) |
| Ctrl+↑/↓ | Move active row |
| Ctrl+D | Duplicate |
| Ctrl+M / Ctrl+I | Mirror / Invert |
| Del | Delete |
| Ctrl+G / Ctrl+Shift+G | Group / Ungroup |
| Ctrl+R | Reverse order |
| Ctrl+A | Select all (select mode) |
| Esc | Clear selection / close modals |

---

## Key Files to Know

| File | Purpose |
|------|---------|
| `web/app.js` | All logic — search for `// ====` banners to navigate |
| `web/index.html` | Structure, modals, toolbar, table skeleton, preview containers |
| `web/style.css` | CSS custom properties (theme), layout, components, custom scrollbars |
| `web/assets/toastify.js` | Minified toast notification library (do not edit) |
| `web/jsconfig.json` | TypeScript config for JSDoc type checking in VS Code |
| `web/eslint.config.js` | ESLint flat config — globals for browser APIs, rules for JS quality |
| `web/.prettierrc` | Prettier config (4-space tabs, single quotes, 100col) |
| `firmware/mapping.txt` | GPIO reference: `CH 1: IO4, CH 2: IO16, CH 3: IO17, CH 4: IO21` |

---

## Patterns & Conventions

### Adding a New Pattern Phase Type
1. Add to `getDefaultConfig().defaultPattern.phases` and migration in `migratePattern`
2. Add `<option>` in inspector selects (`renderInspector`, `renderDefaultInspector`)
3. Handle in `playSinglePattern` timing logic
4. Update `getTimelineSummary` for table display

### Adding a New Tool (paint/erase/hybrid)
1. Add button in HTML toolbar + SVG icon in `assets/`
2. Add case in `setActiveTool`, `syncBrushWidgetStyles`
3. Implement logic in `paintTargetCellNode` (hybrid already handles toggle behavior)

### Modifying PWM Range
- `config.properties.pwm.min/max` (0-1023)
- `updatePwmRange` clamps `brushBrightness`, pattern `state` values, and inspector sliders
- `getChannelOpacity` and `isChannelOn` respect `indicatorOffAtMin` flag

### WebSocket Protocol (ESP32 expects)
```js
// LIVE frame (sent every renderLights call during playback)
{ type: "LIVE", state: [pwm0, pwm1, ...], transition: ms }

// Config upload (HTTP POST to /upload)
getOrderedConfig() // JSON with keys ordered: _strobe_editor_version, channels, properties, defaultPattern, patterns
```

---

## Common Tasks

### Run the Editor
```bash
cd web && npx serve .      # or python -m http.server 8000
# Open http://localhost:3000 or http://localhost:8000
```

### Lint / Format
```bash
cd web
npm run lint       # Check for issues
npm run lint:fix   # Auto-fix what can be fixed
npm run format     # Format with Prettier
```

### Debug WebSocket Connection
- Open DevTools Console — logs show `[WS] CONNECTED`, `[WS] SENT TO ESP32`, etc.
- ESP32 must be on same network, WebSocket server on port 81, HTTP `/upload` endpoint
- Default IP `192.168.4.1` (ESP32 AP mode) — change in Project Settings modal

### Inspect Config in Console
```js
config           // current config object
getOrderedConfig() // what gets saved/sent
historyStack     // undo history
selectedPaths    // current selection
```

### Reset Everything
Clear localStorage keys prefixed with `strobe_` or open DevTools Application tab → Local Storage → delete all.

---

## Known Issues / TODO (from TODO.md)

- Programmable channel pins (UI exists in Project Settings, needs firmware support)
- Custom IP/URL for ESP32 (UI done)
- Move steps into settings, move open into JSON
- Minify inspector, add logo, better sync indicator
- Free-form editor: grouping, multi-select, drag-select, align, distribute, snap/grid toggle
- Background dim not working in select mode for multiple patterns

---

## Quality Infrastructure

### Type Checking (JSDoc + TypeScript)
- `@ts-check` at top of `app.js`
- Comprehensive `@typedef` definitions for Config, Pattern, Phase, etc.
- `jsconfig.json` enables `checkJs: true`, `strict: true` for VS Code IntelliSense
- No build step — works directly in editor

### Linting (ESLint 9 flat config)
- Browser globals declared (`window`, `document`, `WebSocket`, `Toastify`, etc.)
- Rules: `no-unused-vars` (warn), `no-undef` (warn), `eqeqeq`, `curly`, `no-var`, `prefer-const`
- Run with `npm run lint` / `npm run lint:fix`

### Formatting (Prettier)
- 4-space indentation, single quotes, trailing commas, 100 column width
- Run with `npm run format`

### Accessibility
- ARIA labels/roles on toolbar buttons, modals, table, resizer
- `focus-visible` outlines for keyboard navigation
- `role="dialog"` + `aria-modal="true"` on modals
- `role="grid"` + `scope="col"` on pattern table
- `tabindex="0"` on vertical resizer

---

## No Build / No Tests

This project intentionally has no build step, no bundler, no test runner. Edit `app.js` / `style.css` / `index.html` directly and reload the browser. All dependencies are inlined (toastify.min.js) or native browser APIs. Dev dependencies are only for IDE support and code quality.