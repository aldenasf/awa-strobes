// ============================================================================
// STROBE PATTERN CONFIGURATOR
// ----------------------------------------------------------------------------
// This file drives the whole editor UI: the pattern table, the inspector
// panel, the live preview (bar / custom canvas layouts), undo/redo, the
// paint tool, and syncing the config to a physical ESP32 strobe controller
// over WebSocket. Jump to the section banners below (search for "// ====")
// to find a specific area of functionality.
// ============================================================================

// ============================================================================
// GLOBAL STATE
// ============================================================================

const version = "1";
const default_color = "#ff2a2a";
const DEFAULT_PWM_MIN = 0;
const DEFAULT_PWM_MAX = 1023;

let config = {
    _strobe_editor_version: "1",
    channels: 10,
    patterns: [],
    colors: [],
    pwmMin: DEFAULT_PWM_MIN,
    pwmMax: DEFAULT_PWM_MAX,
    indicatorOffAtMin: false,
    backgroundDimPWM: 0,
    defaultPattern: {
        backgroundDim: false,
        phases: {
            in: { type: "none", duration: 0 },
            anim: { type: "none", amount: 0, duration: 0 },
            out: { type: "steady", duration: 500 },
        },
    },
};
let appMode = "edit";
let showSteps = true;
let selectedPaths = new Set();
let isDraggingSelection = false;
let dragTargetState = null;
let isPlaying = false;
let abortController = null;
let activePath = null;
let soloGroupIdx = null;
let activeInspectorChannel = 0;

// Custom Color Picker Application Context States
let currentPickerContext = null;

// Selection History Tracking Stack
let selectionHistoryStack = [];

// Preview Mode & Custom Canvas Layout Configuration Properties
let previewMode = "bar";
let canvasLayoutData = [];
let draggedChannelIdx = null;

// Painting Tools Dynamic State Settings
let activeTool = "hybrid";
let brushBrightness = DEFAULT_PWM_MAX;
// brushIncrement is now stored in localStorage (user preference)
let brushIncrement = 100;
let isPaintingActive = false;
let nodesToggledInCurrentStroke = new Set();

let inspectorBuffer = null;
let dirtyFields = new Set();

let historyStack =
    JSON.parse(localStorage.getItem(`strobe_history_v${version}`)) || [];
let historyIndex =
    localStorage.getItem(`strobe_history_index_v${version}`) !== null
        ? parseInt(localStorage.getItem(`strobe_history_index_v${version}`))
        : -1;
const MAX_HISTORY = 50;
let isUndoRedoAction = false;

// ==========================================================================
// TOAST NOTIFICATIONS
// Small popup messages shown to the user (via Toastify).
// ==========================================================================
function showToast(msg, type = "info") {
    let color = "linear-gradient(to right, #007bff, #0056b3)";
    if (type === "history") color = "#cc9a05";
    if (type === "success") color = "#28a745";
    if (type === "warn") color = "#dc3545";
    Toastify({
        text: msg,
        duration: 2000,
        gravity: "top",
        position: "right",
        stopOnFocus: true,
        style: { background: color, color: "#ffffff" },
    }).showToast();
}

// ==========================================================================
// CONFIG DATA MIGRATION
// Upgrades patterns saved by older versions of the editor to the current shape.
// ==========================================================================
function migratePattern(p) {
    if (!p.phases) {
        let dur = p.duration || 500;
        let hasFlicker = p.flicker && p.flicker.amount > 0;
        p.phases = {
            in:
                p.fade && p.fade.in > 0
                    ? { type: "fade", duration: p.fade.in }
                    : { type: "none", duration: 0 },
            anim: hasFlicker
                ? {
                      type: "flicker",
                      amount: p.flicker.amount,
                      duration: p.flicker.duration || dur,
                  }
                : { type: "none", duration: 0, amount: 0 },
            out:
                p.fade && p.fade.out > 0
                    ? { type: "fade", duration: p.fade.out }
                    : hasFlicker
                      ? { type: "none", duration: 0 }
                      : { type: "steady", duration: dur },
        };
        delete p.duration;
        delete p.flicker;
        delete p.fade;
    }
    if (p.backgroundDim === undefined) p.backgroundDim = false;
    return p;
}

// ==========================================================================
// PWM VALUE MIGRATION
// Older config files stored channel brightness as a normalized 0.0-1.0
// float. The editor now works exclusively in native ESP32 PWM duty values
// (0-1023). When a config is loaded, we look at every state value: if they
// are ALL within 0.0-1.0, we assume it's the legacy normalized format and
// scale it up to PWM. Otherwise we assume it's already PWM and leave it
// untouched.
// ==========================================================================
function collectStateValues(patterns, out = []) {
    (patterns || []).forEach((p) => {
        if (p.type === "group") {
            collectStateValues(p.patterns, out);
        } else if (Array.isArray(p.state)) {
            p.state.forEach((v) => {
                const n = parseFloat(v);
                if (!isNaN(n)) out.push(n);
            });
        }
    });
    return out;
}

function scaleStatesToPWM(patterns) {
    const maxVal = config.pwmMax || DEFAULT_PWM_MAX;
    (patterns || []).forEach((p) => {
        if (p.type === "group") {
            scaleStatesToPWM(p.patterns);
        } else if (Array.isArray(p.state)) {
            p.state = p.state.map((v) => {
                const n = parseFloat(v) || 0;
                return Math.round(n * maxVal);
            });
        }
    });
}

function migrateConfigToPWM(cfg) {
    const values = collectStateValues(cfg.patterns);
    const isLegacyNormalized =
        values.length > 0 && values.every((v) => v >= 0 && v <= 1);
    if (isLegacyNormalized) {
        scaleStatesToPWM(cfg.patterns);
    }
    return cfg;
}

// ==========================================================================
// CONFIG DEFAULTS (PWM range, indicator behaviour, background dim, default pattern)
// ==========================================================================
function ensureConfigDefaults() {
    if (config.pwmMin === undefined) config.pwmMin = DEFAULT_PWM_MIN;
    if (config.pwmMax === undefined) config.pwmMax = DEFAULT_PWM_MAX;
    if (config.indicatorOffAtMin === undefined)
        config.indicatorOffAtMin = false;
    if (config.backgroundDimPWM === undefined) config.backgroundDimPWM = 0;
    // clamp min < max
    if (config.pwmMin >= config.pwmMax) {
        config.pwmMin = DEFAULT_PWM_MIN;
        config.pwmMax = DEFAULT_PWM_MAX;
    }
    // ensure each pattern has backgroundDim
    (config.patterns || []).forEach((item) => {
        if (item.type === "group") {
            item.patterns.forEach((p) => {
                if (p.backgroundDim === undefined) p.backgroundDim = false;
            });
        } else {
            if (item.backgroundDim === undefined) item.backgroundDim = false;
        }
    });
    // ensure defaultPattern exists
    if (!config.defaultPattern) {
        config.defaultPattern = {
            backgroundDim: false,
            phases: {
                in: { type: "none", duration: 0 },
                anim: { type: "none", amount: 0, duration: 0 },
                out: { type: "steady", duration: 500 },
            },
        };
    }
    // ensure defaultPattern.phases exist
    if (!config.defaultPattern.phases) {
        config.defaultPattern.phases = {
            in: { type: "none", duration: 0 },
            anim: { type: "none", amount: 0, duration: 0 },
            out: { type: "steady", duration: 500 },
        };
    }
    if (config.defaultPattern.backgroundDim === undefined)
        config.defaultPattern.backgroundDim = false;
}

function isChannelOn(val) {
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    if (config.indicatorOffAtMin) {
        return val > min;
    } else {
        return val > 0;
    }
}

function getChannelOpacity(val) {
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    if (config.indicatorOffAtMin) {
        if (val <= min) return 0;
        return Math.min(1, (val - min) / (max - min));
    } else {
        return Math.min(1, val / max);
    }
}

function clampStateValues() {
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    const clamp = (v) => Math.round(Math.min(max, Math.max(min, v)));
    (config.patterns || []).forEach((item) => {
        if (item.type === "group") {
            item.patterns.forEach((p) => {
                p.state = p.state.map(clamp);
            });
        } else {
            item.state = item.state.map(clamp);
        }
    });
}

// ==========================================================================
// UNDO / REDO HISTORY (CONFIG)
// Tracks snapshots of the whole `config` object so edits can be undone/redone.
// ==========================================================================
function saveHistoryToLocal() {
    localStorage.setItem(
        `strobe_history_v${version}`,
        JSON.stringify(historyStack),
    );
    localStorage.setItem(
        `strobe_history_index_v${version}`,
        historyIndex.toString(),
    );
}

function saveState(jsonString) {
    if (historyIndex < historyStack.length - 1)
        historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(jsonString);
    if (historyStack.length > MAX_HISTORY) historyStack.shift();
    else historyIndex++;
    updateUndoRedoButtons();
    saveHistoryToLocal();
}

function undoState() {
    if (historyIndex > 0) {
        isUndoRedoAction = true;
        historyIndex--;
        applyHistoryState();
        showToast("Undid action", "history");
    }
    updateUndoRedoButtons();
    saveHistoryToLocal();
}

function redoState() {
    if (historyIndex < historyStack.length - 1) {
        isUndoRedoAction = true;
        historyIndex++;
        applyHistoryState();
        showToast("Redid action", "history");
    }
    updateUndoRedoButtons();
    saveHistoryToLocal();
}

function applyHistoryState() {
    config = JSON.parse(historyStack[historyIndex]);
    if (!config._strobe_editor_version) config._strobe_editor_version = "1";
    if (!config.colors) config.colors = [];
    while (config.colors.length < config.channels)
        config.colors.push(default_color);
    ensureConfigDefaults();
    syncCanvasLayoutLength();
    document.getElementById("light-bar").innerHTML = "";
    document.getElementById("custom-layout-view").innerHTML = "";
    const bgDim = getBackgroundDimForPath(activePath);
    renderLights(
        new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
        0,
        bgDim,
    );
    document.getElementById("global-channels").value = config.channels;
    renderTable();
    renderInspector();
    isUndoRedoAction = false;
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    const u = document.getElementById("btn-undo"),
        r = document.getElementById("btn-redo");
    if (u) u.disabled = historyIndex <= 0;
    if (r) r.disabled = historyIndex >= historyStack.length - 1;
}

// ==========================================================================
// SELECTION & CLICK HANDLING
// Generic clicks on empty space / setting the 'active' row.
// ==========================================================================
function handleEmptyClick(e) {
    const isDeadSpace =
        e.target.classList.contains("app-container") ||
        e.target.contains(document.getElementById("custom-layout-view")) ||
        e.target.classList.contains("editor-side") ||
        e.target.tagName.toLowerCase() === "table" ||
        e.target.tagName.toLowerCase() === "thead";
    if (isDeadSpace) {
        activePath = null;
        selectedPaths.clear();
        inspectorBuffer = null;
        dirtyFields.clear();
        renderTable();
        renderInspector();
    }
}

function setActivePath(path) {
    activePath = path;
    if (selectedPaths.size === 0) {
        inspectorBuffer = null;
        dirtyFields.clear();
    }
    renderTable();
    renderInspector();
}

// ==========================================================================
// SELECTION HISTORY (UNDO SELECTION)
// Separate undo stack just for row-selection changes.
// ==========================================================================
function saveSelectionState() {
    selectionHistoryStack.push(new Set(selectedPaths));
    if (selectionHistoryStack.length > 50) selectionHistoryStack.shift();
    updateSelectionUndoButton();
}

function undoSelection() {
    if (selectionHistoryStack.length === 0) return;
    selectedPaths = selectionHistoryStack.pop();
    renderTableSelection();
    updateSelectionUndoButton();
    showToast("Selection restored");
}

function updateSelectionUndoButton() {
    const btn = document.getElementById("sel-undo");
    if (btn) btn.disabled = selectionHistoryStack.length === 0;
}

function filterSelectionOddEven(type) {
    if (selectedPaths.size === 0) return;
    saveSelectionState();
    const allVisualPaths = Array.from(
        document.querySelectorAll("#pattern-list tr"),
    )
        .map((tr) => tr.dataset.path)
        .filter(Boolean);
    const sortedSelected = allVisualPaths.filter((path) =>
        selectedPaths.has(path),
    );
    selectedPaths.clear();
    sortedSelected.forEach((path, idx) => {
        if (type === "odd" && idx % 2 === 0) selectedPaths.add(path);
        else if (type === "even" && idx % 2 !== 0) selectedPaths.add(path);
    });
    renderTableSelection();
}

// ==========================================================================
// CUSTOM COLOR PICKER POPUP
// ==========================================================================
function openCustomColorPopup(e, context) {
    e.stopPropagation();
    currentPickerContext = context;
    const popup = document.getElementById("custom-color-popup");

    const hiddenPicker = document.getElementById("hidden-native-picker");
    if (typeof context === "number") {
        hiddenPicker.value = config.colors[context] || default_color;
    }

    const rect = e.target.getBoundingClientRect();
    popup.style.top = `${rect.bottom + window.scrollY + 4}px`;
    popup.style.left = `${Math.min(window.innerWidth - 170, rect.left + window.scrollX)}px`;
    popup.style.display = "flex";
}

function selectCustomPopupColor(val) {
    if (!val) return;
    if (typeof currentPickerContext === "number") {
        config.colors[currentPickerContext] = val;
        updateJsonPanel();
        renderTable();
        renderInspector();
        if (!isPlaying) {
            if (activePath) {
                let currP = getObjByPath(activePath);
                if (currP && currP.state) {
                    const bgDim = getBackgroundDimForPath(activePath);
                    renderLights(currP.state, 0, bgDim);
                }
            } else {
                renderLights(
                    new Array(config.channels).fill(
                        config.pwmMin || DEFAULT_PWM_MIN,
                    ),
                    0,
                    false,
                );
            }
        }
    }
}

// ==========================================================================
// HELP MODAL
// ==========================================================================
function toggleHelp() {
    const m = document.getElementById("help-modal");
    m.style.display = m.style.display === "flex" ? "none" : "flex";
}

document.addEventListener("click", () => {
    document.getElementById("custom-color-popup").style.display = "none";
});

// ==========================================================================
// ROW REORDERING & KEYBOARD SHORTCUTS
// Arrow-key row moves, plus the global keydown handler for all hotkeys.
// ==========================================================================
function moveActiveRow(dir) {
    if (!activePath) return;
    const isChild = activePath.includes("-");
    if (isChild) {
        let [gIdx, pIdx] = activePath.split("-").map(Number);
        let group = config.patterns[gIdx];
        if (!group || group.type !== "group") return;
        let arr = group.patterns;
        let nextPIdx = dir === "up" ? pIdx - 1 : pIdx + 1;
        if (nextPIdx < 0 || nextPIdx >= arr.length) return;

        let temp = arr[pIdx];
        arr[pIdx] = arr[nextPIdx];
        arr[nextPIdx] = temp;
        activePath = `${gIdx}-${nextPIdx}`;
    } else {
        let gIdx = parseInt(activePath);
        let arr = config.patterns;
        let nextGIdx = dir === "up" ? gIdx - 1 : gIdx + 1;
        if (nextGIdx < 0 || nextGIdx >= arr.length) return;

        let temp = arr[gIdx];
        arr[gIdx] = arr[nextGIdx];
        arr[nextGIdx] = temp;
        activePath = `${nextGIdx}`;

        if (soloGroupIdx === gIdx) soloGroupIdx = nextGIdx;
        else if (soloGroupIdx === nextGIdx) soloGroupIdx = gIdx;
    }
    updateJsonPanel();
    renderTable();
    renderInspector();
    showToast(`Moved active item ${dir}`);
}

window.addEventListener("keydown", (e) => {
    if (
        e.target.tagName.toLowerCase() === "input" ||
        e.target.tagName.toLowerCase() === "textarea" ||
        e.target.tagName.toLowerCase() === "select"
    )
        return;
    const isCtrl = e.ctrlKey || e.metaKey;

    if (isCtrl && !e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        undoState();
        return;
    }
    if (isCtrl && e.shiftKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        redoState();
        return;
    }
    if (isCtrl && e.key.toLowerCase() === "y") {
        e.preventDefault();
        redoState();
        return;
    }
    if (isCtrl && e.key.toLowerCase() === "o") {
        e.preventDefault();
        document.getElementById("file-input").click();
        return;
    }
    if ((e.shiftKey && e.key === "?") || e.key === "/") {
        e.preventDefault();
        toggleHelp();
        return;
    }
    if (e.code === "Space") {
        e.preventDefault();
        togglePlayback();
        return;
    }

    if (isCtrl && e.key.toLowerCase() === "a") {
        e.preventDefault();
        if (appMode === "select") selectAllRows();
        return;
    }

    if (isCtrl && (e.key === "<" || e.key === ",")) {
        e.preventDefault();
        if (selectedPaths.size > 0) {
            shiftSelected("left");
        } else if (activePath) {
            shiftPattern(activePath, "left");
            showToast("Shifted pattern left");
        }
        return;
    }
    if (isCtrl && (e.key === ">" || e.key === ".")) {
        e.preventDefault();
        if (selectedPaths.size > 0) {
            shiftSelected("right");
        } else if (activePath) {
            shiftPattern(activePath, "right");
            showToast("Shifted pattern right");
        }
        return;
    }

    if (appMode === "edit") {
        if (isCtrl && e.key === "ArrowUp") {
            e.preventDefault();
            moveActiveRow("up");
            return;
        }
        if (isCtrl && e.key === "ArrowDown") {
            e.preventDefault();
            moveActiveRow("down");
            return;
        }

        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const allRows = Array.from(
                document.querySelectorAll("#pattern-list tr"),
            ).filter((tr) => tr.dataset.path || tr.dataset.groupPath);
            const currentIdx = allRows.findIndex(
                (tr) =>
                    (tr.dataset.path || tr.dataset.groupPath) === activePath,
            );
            let nextIdx = e.key === "ArrowUp" ? currentIdx - 1 : currentIdx + 1;
            if (nextIdx >= 0 && nextIdx < allRows.length) {
                setActivePath(
                    allRows[nextIdx].dataset.path ||
                        allRows[nextIdx].dataset.groupPath,
                );
            }
            return;
        }
        if (isCtrl && e.key.toLowerCase() === "d") {
            e.preventDefault();
            if (selectedPaths.size > 0) duplicateSelected();
            else if (activePath) {
                if (activePath.includes("-")) duplicateRow(activePath);
                else duplicateGroup(parseInt(activePath));
            }
            return;
        }
        if (isCtrl && e.key.toLowerCase() === "m") {
            e.preventDefault();
            if (selectedPaths.size > 0) mirrorSelected();
            else if (activePath && activePath.includes("-"))
                mirrorPattern(activePath);
            return;
        }
        if (isCtrl && e.key.toLowerCase() === "i") {
            e.preventDefault();
            if (selectedPaths.size > 0) invertSelected();
            else if (activePath) {
                if (activePath.includes("-")) invertRow(activePath);
                else invertGroup(parseInt(activePath));
            }
            return;
        }
        if (e.key === "Delete") {
            if (selectedPaths.size > 0) deleteSelected();
            else if (activePath) removePattern(activePath);
            return;
        }
    }

    if (!isCtrl && e.key.toLowerCase() === "e") setAppMode("edit");
    if (!isCtrl && e.key.toLowerCase() === "s") setAppMode("select");
    if (!isCtrl && e.key.toLowerCase() === "a") addPattern();
    if (isCtrl && e.key.toLowerCase() === "s") {
        e.preventDefault();
        downloadConfig();
    }
    if (isCtrl && e.key.toLowerCase() === "r") {
        e.preventDefault();
        if (appMode === "select") reverseSelectedOrder();
    }
    if (isCtrl && e.key.toLowerCase() === "t") {
        e.preventDefault();
        toggleStepIndicator();
    }
    if (isCtrl && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (appMode === "select") groupSelectedItems();
    }
    if (isCtrl && e.shiftKey && e.key.toLowerCase() === "g") {
        e.preventDefault();
        if (activePath) {
            let parts = activePath.split("-");
            let gIdx = parseInt(parts[0]);
            if (config.patterns[gIdx] && config.patterns[gIdx].type === "group")
                ungroup(gIdx);
        }
    }
    if (e.key === "Escape") {
        if (document.getElementById("help-modal").style.display === "flex")
            toggleHelp();
        else if (document.getElementById("json-modal").style.display === "flex")
            toggleJsonModal();
        else if (
            document.getElementById("settings-modal").style.display === "flex"
        )
            toggleSettingsModal();
        else if (appMode === "select") clearSelection();
    }
});

// ==========================================================================
// FILE IMPORT / JSON LOADING
// Opening a .json config file from disk.
// ==========================================================================
function handleFileInput(event) {
    if (event.target.files.length > 0) loadJsonFile(event.target.files[0]);
    event.target.value = "";
}

function loadJsonFile(file) {
    if (
        !file ||
        (!file.type.includes("json") && !file.name.endsWith(".json"))
    ) {
        showToast("Please select a valid JSON file", "warn");
        return;
    }
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const p = JSON.parse(
                file.name.endsWith(".json") ? e.target.result : "{}",
            );
            if (
                p &&
                typeof p.channels === "number" &&
                Array.isArray(p.patterns)
            ) {
                config = p;
                ensureConfigDefaults();
                config = migrateConfigToPWM(config);
                if (!config._strobe_editor_version)
                    config._strobe_editor_version = "1";
                if (!config.colors) config.colors = [];
                while (config.colors.length < config.channels)
                    config.colors.push(default_color);
                syncCanvasLayoutLength();
                document.getElementById("light-bar").innerHTML = "";
                document.getElementById("custom-layout-view").innerHTML = "";
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(
                    new Array(config.channels).fill(
                        config.pwmMin || DEFAULT_PWM_MIN,
                    ),
                    0,
                    bgDim,
                );
                document.getElementById("global-channels").value =
                    config.channels;
                activePath = null;
                inspectorBuffer = null;
                dirtyFields.clear();
                renderTable();
                renderInspector();
                showToast("Config loaded successfully", "success");
            } else showToast("Invalid config format", "warn");
        } catch (err) {
            showToast("Failed to parse JSON", "warn");
        }
    };
    reader.readAsText(file);
}

document.addEventListener("dragover", (e) => {
    if (
        e.dataTransfer.types &&
        Array.from(e.dataTransfer.types).includes("Files")
    ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
    }
});

document.addEventListener("drop", (e) => {
    if (
        e.dataTransfer.types &&
        Array.from(e.dataTransfer.types).includes("Files")
    ) {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0)
            loadJsonFile(e.dataTransfer.files[0]);
    }
});

function toggleJsonModal() {
    const m = document.getElementById("json-modal");
    m.style.display = m.style.display === "flex" ? "none" : "flex";
    if (m.style.display === "flex") updateJsonPanel();
}

// ==========================================================================
// SETTINGS MODAL
// ==========================================================================
function toggleSettingsModal() {
    const m = document.getElementById("settings-modal");
    m.style.display = m.style.display === "flex" ? "none" : "flex";
    if (m.style.display === "flex") {
        // Populate project settings
        document.getElementById("settings-pwm-min").value =
            config.pwmMin || DEFAULT_PWM_MIN;
        document.getElementById("settings-pwm-max").value =
            config.pwmMax || DEFAULT_PWM_MAX;
        document.getElementById("settings-indicator-off-min").checked =
            !!config.indicatorOffAtMin;
        document.getElementById("settings-background-dim-pwm").value =
            config.backgroundDimPWM || 0;
        updateBackgroundDimPreview();

        // Populate user preferences
        document.getElementById("settings-brush-increment").value =
            brushIncrement;
    }
}

function updateBrushIncrementSetting(val) {
    let parsed = parseFloat(val);
    if (isNaN(parsed) || parsed <= 0) return;
    brushIncrement = Math.round(Math.min(1023, Math.max(1, parsed)));
    // Save to localStorage
    localStorage.setItem("strobe_brush_increment", brushIncrement);
}

function updatePwmRange() {
    const minInput = document.getElementById("settings-pwm-min");
    const maxInput = document.getElementById("settings-pwm-max");
    let newMin = parseInt(minInput.value);
    let newMax = parseInt(maxInput.value);
    if (isNaN(newMin) || newMin < 0) newMin = 0;
    if (isNaN(newMax) || newMax > 1023) newMax = 1023;
    if (newMin >= newMax) {
        showToast("Minimum must be less than maximum", "warn");
        return;
    }
    config.pwmMin = newMin;
    config.pwmMax = newMax;
    // Clamp existing state values
    clampStateValues();
    // Clamp brush brightness
    if (brushBrightness < config.pwmMin) brushBrightness = config.pwmMin;
    if (brushBrightness > config.pwmMax) brushBrightness = config.pwmMax;
    syncBrushWidgetStyles();
    // Update inspector sliders
    renderInspector();
    // Update table and preview
    renderTable();
    if (!isPlaying) {
        if (activePath) {
            let currP = getObjByPath(activePath);
            if (currP && currP.state) {
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(currP.state, 0, bgDim);
            }
        } else {
            renderLights(
                new Array(config.channels).fill(
                    config.pwmMin || DEFAULT_PWM_MIN,
                ),
                0,
                false,
            );
        }
    }
    updateJsonPanel();
    updateBackgroundDimPreview();
    showToast("PWM range updated", "success");
}

function toggleIndicatorOffAtMin() {
    const checkbox = document.getElementById("settings-indicator-off-min");
    config.indicatorOffAtMin = checkbox.checked;
    // Re-render preview
    if (!isPlaying) {
        if (activePath) {
            let currP = getObjByPath(activePath);
            if (currP && currP.state) {
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(currP.state, 0, bgDim);
            }
        } else {
            renderLights(
                new Array(config.channels).fill(
                    config.pwmMin || DEFAULT_PWM_MIN,
                ),
                0,
                false,
            );
        }
    }
    renderTable();
    updateJsonPanel();
    updateBackgroundDimPreview();
    showToast("Indicator behaviour updated", "success");
}

function updateBackgroundDimPWM(val) {
    let parsed = parseInt(val);
    if (isNaN(parsed) || parsed < 0) parsed = 0;
    if (parsed > (config.pwmMax || DEFAULT_PWM_MAX))
        parsed = config.pwmMax || DEFAULT_PWM_MAX;
    config.backgroundDimPWM = parsed;
    updateJsonPanel();
    // Update preview if active pattern
    if (!isPlaying) {
        if (activePath) {
            let currP = getObjByPath(activePath);
            if (currP && currP.state) {
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(currP.state, 0, bgDim);
            }
        } else {
            renderLights(
                new Array(config.channels).fill(
                    config.pwmMin || DEFAULT_PWM_MIN,
                ),
                0,
                false,
            );
        }
    }
    // Also update the settings preview
    updateBackgroundDimPreview();
    showToast("Background Dim PWM updated", "success");
}

function updateBackgroundDimPreview() {
    const previewContainer = document.getElementById("bg-dim-preview");
    if (!previewContainer) return;
    const bgPWM = config.backgroundDimPWM || 0;
    const maxPWM = config.pwmMax || DEFAULT_PWM_MAX;
    const minPWM = config.pwmMin || DEFAULT_PWM_MIN;
    // Three states: OFF (0), Background Dim (bgPWM), ON (maxPWM)
    const states = [0, bgPWM, maxPWM];
    const labels = ["OFF", "BG Dim", "ON"];
    previewContainer.innerHTML = "";
    states.forEach((val, idx) => {
        const wrapper = document.createElement("div");
        wrapper.style.display = "flex";
        wrapper.style.flexDirection = "column";
        wrapper.style.alignItems = "center";
        wrapper.style.gap = "2px";
        const dot = document.createElement("div");
        dot.className = "bg-preview-dot";
        const isOn = isChannelOn(val);
        const opacity = getChannelOpacity(val);
        const color = config.colors[0] || default_color; // use first channel color
        if (isOn) {
            dot.style.background = color;
            dot.style.opacity = opacity;
            dot.style.boxShadow = `0 0 6px ${color}`;
            dot.style.borderColor = color;
        } else {
            dot.style.background = "#222";
            dot.style.opacity = "1";
            dot.style.boxShadow = "none";
            dot.style.borderColor = "var(--border)";
        }
        const label = document.createElement("span");
        label.style.fontSize = "8px";
        label.style.color = "#888";
        label.textContent = labels[idx];
        wrapper.appendChild(dot);
        wrapper.appendChild(label);
        previewContainer.appendChild(wrapper);
    });
}

document.addEventListener("click", () => {
    const pop = document.getElementById("brush-presets-popup");
    if (pop) pop.style.display = "none";
});

// ==========================================================================
// CONFIG EXPORT
// Downloading / copying the current config as JSON.
// ==========================================================================
function downloadConfig() {
    const blob = new Blob([JSON.stringify(config, null, 2)], {
        type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "strobe_config.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Config downloaded");
}

function copyToClipboard() {
    navigator.clipboard
        .writeText(document.getElementById("json-input").value)
        .then(() => {
            showToast("JSON copied to clipboard", "success");
        })
        .catch((err) => {
            document.getElementById("json-input").select();
            document.execCommand("copy");
            showToast("JSON copied to clipboard", "success");
        });
}

// ==========================================================================
// APP MODE & STEP INDICATOR
// Switching between edit/select modes and toggling the step-number display.
// ==========================================================================
function setAppMode(mode) {
    appMode = mode;
    inspectorBuffer = null;
    dirtyFields.clear();
    document.getElementById("btn-edit-mode").className =
        mode === "edit" ? "active-mode" : "";
    document.getElementById("btn-select-mode").className =
        mode === "select" ? "active-mode" : "";
    document.getElementById("editor-container").className =
        mode === "select"
            ? "editor-side select-mode-active"
            : "editor-side show-steps";
    document.getElementById("selection-toolbar").style.display =
        mode === "select" ? "flex" : "none";
    if (mode === "edit") {
        selectedPaths.clear();
        selectionHistoryStack = [];
    }
    renderTable();
    renderInspector();
    if (mode === "select") updateSelectionUndoButton();
}

function toggleStepIndicator() {
    showSteps = !showSteps;
    document.getElementById("btn-toggle-steps").innerText = showSteps
        ? "STEPS: ON"
        : "STEPS: OFF";
    if (showSteps)
        document.getElementById("editor-container").classList.add("show-steps");
    else
        document
            .getElementById("editor-container")
            .classList.remove("show-steps");
}
window.onmouseup = () => {
    isDraggingSelection = false;
    dragTargetState = null;
};

// ==========================================================================
// PATH HELPERS
// Patterns are addressed by a "path" string like "2" (root pattern 2) or "2-1"
// (pattern 1 inside group 2). These helpers resolve a path to real data.
// ==========================================================================
function getObjByPath(path) {
    let [gIdx, pIdx] = path.split("-");
    return pIdx === undefined
        ? config.patterns[gIdx]
        : config.patterns[gIdx].patterns[pIdx];
}
function getArrByPath(path) {
    let [gIdx, pIdx] = path.split("-");
    return pIdx === undefined
        ? config.patterns
        : config.patterns[gIdx].patterns;
}
function getIdxByPath(path) {
    let parts = path.split("-");
    return parseInt(parts[parts.length - 1]);
}

function getBackgroundDimForPath(path) {
    if (!path) return false;
    let p = getObjByPath(path);
    return p && p.backgroundDim ? true : false;
}

// ==========================================================================
// BULK SELECTION ACTIONS
// Select all / clear / group / ungroup multiple rows at once.
// ==========================================================================
function selectAllRows() {
    if (appMode !== "select") return;
    saveSelectionState();
    inspectorBuffer = null;
    dirtyFields.clear();
    config.patterns.forEach((item, gIdx) => {
        if (item.type === "group")
            item.patterns.forEach((_, pIdx) =>
                selectedPaths.add(`${gIdx}-${pIdx}`),
            );
        else selectedPaths.add(`${gIdx}`);
    });
    renderTableSelection();
}

function clearSelection() {
    saveSelectionState();
    selectedPaths.clear();
    inspectorBuffer = null;
    dirtyFields.clear();
    renderTableSelection();
}

function groupSelectedItems() {
    let rootIndices = Array.from(selectedPaths)
        .filter((p) => !p.includes("-"))
        .map(Number)
        .sort((a, b) => a - b);
    if (rootIndices.length < 1) return;
    let group = { type: "group", repeat: 2, patterns: [], bounce: false };
    for (let i = rootIndices.length - 1; i >= 0; i--) {
        let item = config.patterns.splice(rootIndices[i], 1)[0];
        if (item.type === "group") group.patterns.unshift(...item.patterns);
        else group.patterns.unshift(item);
    }
    config.patterns.splice(rootIndices[0], 0, group);
    selectedPaths.clear();
    activePath = null;
    inspectorBuffer = null;
    dirtyFields.clear();
    renderTable();
    renderInspector();
    showToast("Group created");
}
function ungroup(gIdx) {
    let group = config.patterns[gIdx];
    config.patterns.splice(gIdx, 1, ...group.patterns);
    if (soloGroupIdx === gIdx) soloGroupIdx = null;
    activePath = null;
    inspectorBuffer = null;
    dirtyFields.clear();
    renderTable();
    renderInspector();
    showToast("Group disbanded");
}

// ==========================================================================
// CHANNEL COUNT MANAGEMENT
// Changing how many strobe channels the config has.
// ==========================================================================
function updateGlobalChannels(val) {
    let n = parseInt(val) || 1;
    config.channels = n;
    if (!config.colors) config.colors = [];
    while (config.colors.length < n) config.colors.push(default_color);
    if (config.colors.length > n) config.colors = config.colors.slice(0, n);
    syncCanvasLayoutLength();
    const fixLength = (p) => {
        while (p.state.length < n) p.state.push(0);
        if (p.state.length > n) p.state = p.state.slice(0, n);
    };
    config.patterns.forEach((item) => {
        if (item.type === "group") item.patterns.forEach(fixLength);
        else fixLength(item);
    });
    document.getElementById("light-bar").innerHTML = "";
    document.getElementById("custom-layout-view").innerHTML = "";
    renderTable();
}

// Paint, Erase, & Hybrid Tool Selection Controls

// ==========================================================================
// PAINT TOOL
// The brush used to paint channel levels directly onto rows in the table
// and onto nodes in the custom canvas layout.
// ==========================================================================
function setActiveTool(tool) {
    activeTool = tool;

    const hybridBtn = document.getElementById("tool-hybrid-btn");
    const paintBtn = document.getElementById("tool-paint-btn");
    const eraseBtn = document.getElementById("tool-erase-btn");

    hybridBtn.className = "btn-compact";
    paintBtn.className = "btn-compact";
    eraseBtn.className = "btn-compact";

    if (tool === "hybrid") hybridBtn.classList.add("active-hybrid");
    if (tool === "paint") paintBtn.classList.add("active-paint");
    if (tool === "erase") eraseBtn.classList.add("active-erase");

    const opacityVal = tool === "erase" ? "0.3" : "1";
    document.getElementById("paint-tool-scroll-box").style.opacity = opacityVal;
    document.getElementById("brush-presets-dropdown-wrapper").style.opacity =
        opacityVal;
    syncBrushWidgetStyles();
}

function syncBrushWidgetStyles() {
    const inputField = document.getElementById("global-brush-val");
    if (inputField && document.activeElement !== inputField) {
        inputField.value = brushBrightness;
        inputField.min = config.pwmMin || DEFAULT_PWM_MIN;
        inputField.max = config.pwmMax || DEFAULT_PWM_MAX;
    }
    const scrollBox = document.getElementById("paint-tool-scroll-box");
    if (scrollBox) {
        const max = config.pwmMax || DEFAULT_PWM_MAX;
        const intensity = Math.min(1, brushBrightness / max);
        scrollBox.style.backgroundColor = `rgba(255, 42, 42, ${intensity})`;
    }
}

function handleBrushWidgetWheel(event) {
    if (activeTool === "erase") return;
    event.preventDefault();
    let step = event.deltaY < 0 ? brushIncrement : -brushIncrement;
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    let next = Math.min(max, Math.max(min, brushBrightness + step));
    brushBrightness = Math.round(next);
    syncBrushWidgetStyles();
    renderInspector();
}

function handleManualBrushInput(val) {
    if (activeTool === "erase") return;
    let parsed = parseFloat(val);
    if (isNaN(parsed)) return;
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    brushBrightness = Math.round(Math.min(max, Math.max(min, parsed)));
    syncBrushWidgetStyles();
    renderInspector();
}

function toggleBrushPresetsMenu(e) {
    if (activeTool === "erase") return;
    e.stopPropagation();
    const pop = document.getElementById("brush-presets-popup");
    // Populate presets based on current min/max
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    const range = max - min;
    const presets = [
        { label: "10%", value: min + range * 0.1 },
        { label: "25%", value: min + range * 0.25 },
        { label: "50%", value: min + range * 0.5 },
        { label: "75%", value: min + range * 0.75 },
        { label: "100%", value: max },
    ];
    pop.innerHTML = presets
        .map(
            (p) =>
                `<button onclick="selectBrushPreset(${Math.round(p.value)})">${p.label} (${Math.round(p.value)})</button>`,
        )
        .join("");
    pop.style.display = pop.style.display === "block" ? "none" : "block";
}

function selectBrushPreset(val) {
    brushBrightness = val;
    syncBrushWidgetStyles();
    document.getElementById("brush-presets-popup").style.display = "none";
    renderInspector();
}

// Grid Painting Drag Action Modules
function startPaintStrokeDrag(path, si) {
    if (appMode !== "edit") return;
    isPaintingActive = true;
    nodesToggledInCurrentStroke.clear();
    paintTargetCellNode(path, si);
}

function enterPaintStrokeDrag(path, si) {
    if (!isPaintingActive || appMode !== "edit") return;
    paintTargetCellNode(path, si);
}

function globallyReleasePaintStroke() {
    if (isPaintingActive) {
        isPaintingActive = false;
        nodesToggledInCurrentStroke.clear();
    }
}

function paintTargetCellNode(path, si) {
    const nodeKey = `${path}-${si}`;
    if (nodesToggledInCurrentStroke.has(nodeKey)) return;

    nodesToggledInCurrentStroke.add(nodeKey);
    let p = getObjByPath(path);
    if (!p) return;

    if (activeTool === "paint") {
        p.state[si] = brushBrightness;
    } else if (activeTool === "erase") {
        p.state[si] = config.pwmMin || DEFAULT_PWM_MIN;
    } else if (activeTool === "hybrid") {
        let current = Math.round(parseFloat(p.state[si]) || 0);
        const min = config.pwmMin || DEFAULT_PWM_MIN;
        const isOn = config.indicatorOffAtMin ? current > min : current > 0;
        if (isOn) {
            if (current === brushBrightness) {
                p.state[si] = min; // turn off to minimum
            } else {
                p.state[si] = brushBrightness;
            }
        } else {
            p.state[si] = brushBrightness;
        }
    }

    renderTable();
    if (!isPlaying) {
        const bgDim = getBackgroundDimForPath(path);
        renderLights(p.state, 0, bgDim);
    }
    updateJsonPanel();
    if (activePath === path) {
        const rangeInput = document.getElementById("inspector-dimmer-range");
        const numberInput = document.getElementById("inspector-dimmer-number");
        const labelNode = document.getElementById("inspector-dimmer-label");
        const blockNode = document.getElementById(`inspector-ch-block-${si}`);

        if (si === activeInspectorChannel) {
            if (rangeInput && rangeInput !== document.activeElement)
                rangeInput.value = p.state[si];
            if (numberInput && numberInput !== document.activeElement)
                numberInput.value = p.state[si];
            if (labelNode)
                labelNode.innerHTML = `Ch ${si + 1} Level: <span>(${p.state[si]})</span>`;
        }
        if (blockNode) {
            blockNode.title = `${p.state[si]}`;
            const chanColor = config.colors[si] || default_color;
            const isOn = isChannelOn(p.state[si]);
            if (isOn) {
                blockNode.classList.add("on");
                blockNode.style.background = chanColor;
                blockNode.style.opacity = getChannelOpacity(p.state[si]);
            } else {
                blockNode.classList.remove("on");
                blockNode.style.background = "#222";
                blockNode.style.opacity = "1";
            }
        }
    }
}

// ==========================================================================
// SELECTION SHIFT & INSPECTOR APPLY
// Applying an inspector-panel edit to every currently selected row.
// ==========================================================================
function shiftSelected(dir) {
    selectedPaths.forEach((path) => shiftPattern(path, dir, false));
    renderTable();
    showToast(`Shifted selection ${dir}`);
}

function applyInspectorToSelection() {
    let hasStateChanges =
        inspectorBuffer && inspectorBuffer.state.some((s) => s !== -1);
    if (
        !inspectorBuffer ||
        selectedPaths.size === 0 ||
        (dirtyFields.size === 0 && !hasStateChanges)
    )
        return;

    selectedPaths.forEach((path) => {
        let p = getObjByPath(path);
        if (p && p.type !== "group") {
            if (!p.phases) p = migratePattern(p);
            dirtyFields.forEach((fieldPath) => {
                let [phaseName, fieldKey] = fieldPath.split(".");
                if (p.phases[phaseName]) {
                    p.phases[phaseName][fieldKey] =
                        inspectorBuffer.phases[phaseName][fieldKey];
                }
            });
            for (let i = 0; i < config.channels; i++) {
                if (inspectorBuffer.state[i] !== -1) {
                    p.state[i] = inspectorBuffer.state[i];
                }
            }
        }
    });
    dirtyFields.clear();
    inspectorBuffer = null;
    updateJsonPanel();
    renderTable();
    renderInspector();
    showToast("Applied modified values to selection", "success");
}

// ==========================================================================
// TABLE RENDERING
// Building the HTML for the main pattern table.
// ==========================================================================
function getTimelineSummary(p) {
    if (!p.phases) return "-";
    let parts = [];
    const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
    if (p.phases.in && p.phases.in.type !== "none")
        parts.push(
            `<span style="color:#a5d6ff; font-weight:bold;">In:</span> ${cap(p.phases.in.type)} (${p.phases.in.duration}ms)`,
        );
    if (p.phases.anim && p.phases.anim.type !== "none") {
        let amt = p.phases.anim.amount ? `x${p.phases.anim.amount}` : "";
        parts.push(
            `<span style="color:#ffc107; font-weight:bold;">Anim:</span> ${cap(p.phases.anim.type)} ${amt} (${p.phases.anim.duration}ms)`,
        );
    }
    if (p.phases.out && p.phases.out.type !== "none")
        parts.push(
            `<span style="color:#28a745; font-weight:bold;">Out:</span> ${cap(p.phases.out.type)} (${p.phases.out.duration}ms)`,
        );
    return parts.join("<br>") || "None";
}

function createPatternRowHTML(p, path, isChild = false) {
    if (!p.phases) p = migratePattern(p);
    const tr = document.createElement("tr");
    tr.dataset.path = path;
    if (isChild) tr.className = "group-child";
    if (selectedPaths.has(path)) tr.classList.add("selected");
    if (activePath === path && appMode === "edit")
        tr.classList.add("active-row");

    tr.onmousedown = (e) => {
        if (
            e.target.closest("button") ||
            e.target.classList.contains("block") ||
            e.target.closest(".actions-cell") ||
            e.target.closest("input") ||
            e.target.closest("select")
        ) {
            return;
        }
        setActivePath(path);
        if (appMode === "select") {
            saveSelectionState();
            isDraggingSelection = true;
            if (selectedPaths.has(path)) {
                selectedPaths.delete(path);
                dragTargetState = "deselect";
            } else {
                selectedPaths.add(path);
                dragTargetState = "select";
            }
            renderTableSelection();
        }
    };

    const stateHtml = `<div class="state-blocks">${p.state
        .map((s, si) => {
            const val = parseFloat(s) || 0;
            const isOn = isChannelOn(val);
            let styleStr = "";
            const chanColor = config.colors[si] || default_color;
            if (isOn) {
                const opacity = getChannelOpacity(val);
                styleStr = `style="background: ${chanColor}; opacity: ${opacity};"`;
            }
            return `<div class="block ${isOn ? "on" : ""}" ${styleStr} onmousedown="event.stopPropagation(); activePath='${path}'; startPaintStrokeDrag('${path}', ${si})" onmouseenter="enterPaintStrokeDrag('${path}', ${si})" title="${val}"></div>`;
        })
        .join("")}</div>`;

    const summaryHtml = `<div style="font-size: 10px; color:#aaa; white-space: normal; line-height:1.4;">${getTimelineSummary(p)}</div>`;

    tr.innerHTML = `
            <td class="drag-handle"><img src="/assets/drag-handle.svg" class="icon icon-sm"></td>
            <td>${stateHtml}</td>
            <td>${summaryHtml}</td>
            <td>
                <div class="actions-cell">
                    <button class="btn-icon" title="Shift Left" onclick="activePath='${path}'; shiftPattern('${path}', 'left')"><img src="/assets/shift-left.svg" class="icon icon-sm"></button>
                    <button class="btn-icon" title="Shift Right" onclick="activePath='${path}'; shiftPattern('${path}', 'right')"><img src="/assets/shift-right.svg" class="icon icon-sm"></button>
                    <button class="btn-icon" title="Mirror" onclick="activePath='${path}'; mirrorPattern('${path}')"><img src="/assets/mirror.svg" class="icon icon-sm"></button>
                    <button class="btn-icon" title="Invert" onclick="activePath='${path}'; invertRow('${path}')"><img src="/assets/invert.svg" class="icon icon-sm"></button>
                    <button class="btn-icon" title="Duplicate" onclick="activePath='${path}'; duplicateRow('${path}')"><img src="/assets/duplicate.svg" class="icon icon-sm"></button>
                    <button class="btn-icon" title="Delete" onclick="removePattern('${path}')"><img src="/assets/delete.svg" class="icon icon-sm"></button>
                </div>
            </td>`;

    const handle = tr.querySelector(".drag-handle");
    handle.onmouseenter = () => (tr.draggable = true);
    handle.onmouseleave = () => {
        if (!tr.classList.contains("dragging")) tr.draggable = false;
    };
    tr.onmouseup = () => {
        tr.draggable = false;
        tr.classList.remove("dragging");
    };
    tr.onmouseenter = () => {
        if (isDraggingSelection && appMode === "select" && dragTargetState) {
            if (dragTargetState === "select") selectedPaths.add(path);
            else selectedPaths.delete(path);
            renderTableSelection();
        }
    };

    tr.ondragstart = (e) => {
        tr.classList.add("dragging");
        e.dataTransfer.setData("text/plain", path);
        e.dataTransfer.effectAllowed = "move";
    };
    tr.ondragend = () => {
        tr.classList.remove("dragging");
        tr.draggable = false;
    };
    tr.ondragover = (e) => e.preventDefault();
    tr.ondrop = (e) => {
        e.preventDefault();
        handleDrop(path, e.dataTransfer.getData("text/plain"));
    };

    return tr;
}

function renderTable(skipInspector = false) {
    const list = document.getElementById("pattern-list");
    list.innerHTML = "";
    config.patterns.forEach((item, gIdx) => {
        if (item.type === "group") {
            const gTr = document.createElement("tr");
            gTr.className = "group-header";
            gTr.dataset.groupPath = `${gIdx}`;
            if (activePath === `${gIdx}` && appMode === "edit")
                gTr.classList.add("active-row");
            if (soloGroupIdx === gIdx) gTr.classList.add("solo-active");

            gTr.onmousedown = (e) => {
                if (
                    e.target.closest("button") ||
                    e.target.closest("input") ||
                    e.target.closest("label") ||
                    e.target.closest(".actions-cell")
                ) {
                    return;
                }
                if (appMode === "select") {
                    toggleGroupSelection(gIdx);
                    setActivePath(`${gIdx}`);
                } else {
                    setActivePath(`${gIdx}`);
                }
            };
            gTr.innerHTML = `
                    <td class="drag-handle"><img src="/assets/drag-handle.svg" class="icon icon-sm"></td>
                    <td colspan="2" style="padding-left:10px;">
                        <span class="label-text" style="color:var(--accent);">PATTERN GROUP</span><span style="margin-left: 15px; font-size:10px; color:#888;">REPEAT:</span>
                        <input type="number" class="group-repeat-input" value="${item.repeat}" onchange="updateGroupVal('${gIdx}', 'repeat', this.value, true)">
                        <label class="bounce-toggle"><input type="checkbox" ${item.bounce ? "checked" : ""} onchange="updateGroupVal('${gIdx}', 'bounce', this.checked, true)"> BOUNCE</label>
                    </td>
                    <td>
                        <div class="actions-cell">
                             <button class="btn-icon btn-solo ${soloGroupIdx === gIdx ? "active" : ""}" onclick="toggleSolo(${gIdx})">SOLO</button>
                             <button class="btn-icon" onclick="invertGroup(${gIdx})"><img src="/assets/invert.svg" class="icon icon-sm"></button>
                             <button class="btn-icon" onclick="duplicateGroup(${gIdx})"><img src="/assets/duplicate.svg" class="icon icon-sm"></button>
                             <button class="btn-icon" onclick="removePattern('${gIdx}')"><img src="/assets/delete.svg" class="icon icon-sm"></button>
                             <button class="warn btn-compact" onclick="ungroup(${gIdx})">UNGROUP</button>
                        </div>
                    </td>`;

            const handle = gTr.querySelector(".drag-handle");
            handle.onmouseenter = () => (gTr.draggable = true);
            handle.onmouseleave = () => {
                if (!gTr.classList.contains("dragging")) gTr.draggable = false;
            };
            gTr.onmouseup = () => {
                gTr.draggable = false;
                gTr.classList.remove("dragging");
            };

            gTr.ondragstart = (e) => {
                gTr.classList.add("dragging");
                e.dataTransfer.setData("text/plain", `${gIdx}`);
                e.dataTransfer.effectAllowed = "move";
            };
            gTr.ondragend = () => {
                gTr.classList.remove("dragging");
                gTr.draggable = false;
            };
            gTr.ondragover = (e) => e.preventDefault();
            gTr.ondrop = (e) => {
                e.preventDefault();
                handleDrop(`${gIdx}`, e.dataTransfer.getData("text/plain"));
            };

            list.appendChild(gTr);
            item.patterns.forEach((child, pIdx) =>
                list.appendChild(
                    createPatternRowHTML(child, `${gIdx}-${pIdx}`, true),
                ),
            );
        } else list.appendChild(createPatternRowHTML(item, `${gIdx}`, false));
    });
    renderTableSelection(skipInspector);
    updateJsonPanel();
}

function toggleGroupSelection(gIdx) {
    const group = config.patterns[gIdx];
    if (!group || group.type !== "group") return;
    saveSelectionState();
    const allSelected = group.patterns.every((_, pIdx) =>
        selectedPaths.has(`${gIdx}-${pIdx}`),
    );
    group.patterns.forEach((_, pIdx) => {
        if (allSelected) selectedPaths.delete(`${gIdx}-${pIdx}`);
        else selectedPaths.add(`${gIdx}-${pIdx}`);
    });
    renderTableSelection();
}

// ==========================================================================
// INSPECTOR PANEL
// The right-hand panel used to edit the details of the active pattern.
// ==========================================================================
function selectInspectorChannel(si) {
    activeInspectorChannel = si;
    renderInspector();
    if (previewMode === "custom") {
        const numEl = document.getElementById("shape-control-ch-num");
        if (numEl) numEl.innerText = si !== -1 ? si + 1 : "-";
        const selectEl = document.getElementById("canvas-item-shape");
        if (selectEl && si !== -1 && canvasLayoutData[si])
            selectEl.value = canvasLayoutData[si].shape;

        if (activePath) {
            let currP = getObjByPath(activePath);
            if (currP && currP.state) {
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(currP.state, 0, bgDim);
            }
        } else {
            renderLights(
                new Array(config.channels).fill(
                    config.pwmMin || DEFAULT_PWM_MIN,
                ),
                0,
                false,
            );
        }
    }
}

function updateInspectorChannelVolume(si, val) {
    if (si === -1) return;
    let num = parseFloat(val);
    if (isNaN(num)) num = 0;
    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    if (num < min) num = min;
    if (num > max) num = max;
    num = Math.round(num);

    if (selectedPaths.size > 0) {
        if (!inspectorBuffer) {
            let p = getObjByPath(activePath);
            if (!p.phases) p = migratePattern(p);
            inspectorBuffer = {
                phases: JSON.parse(JSON.stringify(p.phases)),
                state: new Array(config.channels).fill(-1),
            };
        }
        inspectorBuffer.state[si] = num;

        const applyBtn = document.getElementById("btn-apply-selection");
        if (applyBtn) {
            applyBtn.removeAttribute("disabled");
            applyBtn.style.cssText =
                "width: 100%; justify-content: center; background: var(--success);";
        }
    } else {
        let p = getObjByPath(activePath);
        if (p) {
            p.state[si] = num;
            renderTable(true);
            if (!isPlaying) {
                const bgDim = getBackgroundDimForPath(activePath);
                renderLights(p.state, 0, bgDim);
            }
            updateJsonPanel();
        }
    }

    const labelNode = document.getElementById("inspector-dimmer-label");
    if (labelNode) {
        labelNode.innerHTML = `Ch ${si + 1} Level: <span>(${num})</span>`;
    }

    const rangeInput = document.getElementById("inspector-dimmer-range");
    if (rangeInput && rangeInput !== document.activeElement) {
        rangeInput.value = num;
        rangeInput.min = config.pwmMin || DEFAULT_PWM_MIN;
        rangeInput.max = config.pwmMax || DEFAULT_PWM_MAX;
    }

    const numberInput = document.getElementById("inspector-dimmer-number");
    if (numberInput && numberInput !== document.activeElement) {
        numberInput.value = num;
        numberInput.min = config.pwmMin || DEFAULT_PWM_MIN;
        numberInput.max = config.pwmMax || DEFAULT_PWM_MAX;
    }

    const blockNode = document.getElementById(`inspector-ch-block-${si}`);
    if (blockNode) {
        blockNode.title = `${num}`;
        const chanColor = config.colors[si] || default_color;
        const isOn = isChannelOn(num);
        if (isOn) {
            blockNode.classList.add("on");
            blockNode.style.background = chanColor;
            blockNode.style.opacity = getChannelOpacity(num);
        } else {
            blockNode.classList.remove("on");
            blockNode.style.background = "#222";
            blockNode.style.opacity = "1";
        }
    }
}

function resetInspectorChannelToUnchanged(si) {
    if (inspectorBuffer && si !== -1) {
        inspectorBuffer.state[si] = -1;
        renderInspector();
    }
}

function toggleBackgroundDim(target = null) {
    // If target is null, we are editing the default pattern
    if (target === null) {
        // Toggle default pattern's backgroundDim
        config.defaultPattern.backgroundDim =
            !config.defaultPattern.backgroundDim;
        updateJsonPanel();
        renderInspector();
        // No preview update needed because default doesn't affect live preview
        showToast(
            `Default Background Dim ${config.defaultPattern.backgroundDim ? "enabled" : "disabled"}`,
            "info",
        );
        return;
    }
    // Otherwise, toggle on the given pattern (path)
    let p = getObjByPath(target);
    if (!p || p.type === "group") return;
    p.backgroundDim = !p.backgroundDim;
    updateJsonPanel();
    renderTable();
    renderInspector();
    if (!isPlaying) {
        const bgDim = getBackgroundDimForPath(target);
        renderLights(p.state, 0, bgDim);
    }
    showToast(
        `Background Dim ${p.backgroundDim ? "enabled" : "disabled"}`,
        "info",
    );
}

// Helper to update a phase property on the default pattern
function updateDefaultPhase(phase, key, value, refreshInspector = false) {
    const dp = config.defaultPattern;
    if (key === "type") {
        dp.phases[phase].type = value;
        if (value !== "none" && !dp.phases[phase].duration)
            dp.phases[phase].duration = 500;
        if (value === "flicker" && !dp.phases[phase].amount)
            dp.phases[phase].amount = 3;
    } else {
        dp.phases[phase][key] = parseInt(value) || 0;
    }
    updateJsonPanel();
    if (refreshInspector) renderInspector();
}

// Helper to render the default pattern inspector (when no pattern selected)
function renderDefaultInspector() {
    const container = document.getElementById("inspector-content");
    const dp = config.defaultPattern;

    let effectiveInType = dp.phases.in.type;
    let effectiveAnimType = dp.phases.anim.type;
    let effectiveOutType = dp.phases.out.type;

    let bgDimHtml = `
                <div class="inspector-section" style="margin-top: 12px;">
                    <div class="inspector-label">Background Dim</div>
                    <label style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: #ccc; cursor: pointer;">
                        <input type="checkbox" ${dp.backgroundDim ? "checked" : ""} onchange="toggleBackgroundDim(null)">
                        Enabled
                    </label>
                    <div style="font-size: 10px; color: #666; margin-top: 4px;">
                        Global PWM: ${config.backgroundDimPWM || 0} &nbsp;|&nbsp; OFF channels will output this value when enabled.
                    </div>
                </div>
            `;

    container.innerHTML = `
                <div style="margin-bottom: 15px; padding: 8px 12px; background: #2a2a3a; border-radius: 4px; border: 1px solid var(--accent);">
                    <span style="font-size: 12px; font-weight: bold; color: var(--accent);">Default Pattern Properties</span>
                    <span style="font-size: 10px; color: #888; margin-left: 10px;">These settings will be applied to newly created patterns.</span>
                </div>

                <div class="inspector-section">
                    <div class="inspector-label">1. In-Transition</div>
                    <select class="inspector-select" onchange="updateDefaultPhase('in', 'type', this.value, true)">
                        <option value="none" ${effectiveInType === "none" ? "selected" : ""}>None</option>
                        <option value="fade" ${effectiveInType === "fade" ? "selected" : ""}>Fade</option>
                        <option value="steady" ${effectiveInType === "steady" ? "selected" : ""}>Steady</option>
                    </select>
                    ${
                        effectiveInType !== "none"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms):</span>
                        <input type="number" value="${dp.phases.in.duration}" oninput="updateDefaultPhase('in', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>

                <div class="inspector-section">
                    <div class="inspector-label">2. Animation</div>
                    <select class="inspector-select" onchange="updateDefaultPhase('anim', 'type', this.value, true)">
                        <option value="none" ${effectiveAnimType === "none" ? "selected" : ""}>None</option>
                        <option value="flicker" ${effectiveAnimType === "flicker" ? "selected" : ""}>Flicker</option>
                    </select>
                    ${
                        effectiveAnimType === "flicker"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Amount:</span>
                        <input type="number" value="${dp.phases.anim.amount || 0}" oninput="updateDefaultPhase('anim', 'amount', this.value, false)" style="width:70px;">
                    </div>
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms):</span>
                        <input type="number" value="${dp.phases.anim.duration}" oninput="updateDefaultPhase('anim', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>

                <div class="inspector-section">
                    <div class="inspector-label">3. Out-Transition</div>
                    <select class="inspector-select" onchange="updateDefaultPhase('out', 'type', this.value, true)">
                        <option value="none" ${effectiveOutType === "none" ? "selected" : ""}>None</option>
                        <option value="fade" ${effectiveOutType === "fade" ? "selected" : ""}>Fade</option>
                        <option value="steady" ${effectiveOutType === "steady" ? "selected" : ""}>Steady</option>
                    </select>
                    ${
                        effectiveOutType !== "none"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms):</span>
                        <input type="number" value="${dp.phases.out.duration}" oninput="updateDefaultPhase('out', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>

                ${bgDimHtml}
            `;
}

function renderInspector() {
    const container = document.getElementById("inspector-content");
    // If no active path, show default inspector
    if (!activePath) {
        renderDefaultInspector();
        return;
    }

    // If active path is a group, show group properties
    if (!activePath.includes("-")) {
        let p = config.patterns[parseInt(activePath)];
        if (p && p.type === "group") {
            container.innerHTML = `
                        <div class="inspector-section">
                            <div class="inspector-label">Group Properties</div>
                            <div style="display:flex; flex-direction:column; gap:10px;">
                                <label style="font-size:11px; display:flex; justify-content:space-between; align-items:center;">
                                    Repeat count:
                                    <input type="number" value="${p.repeat}" oninput="updateGroupVal('${activePath}', 'repeat', this.value, false)" style="width:70px;">
                                </label>
                                <label style="font-size:11px; display:flex; align-items:center; gap:8px;">
                                    <input type="checkbox" ${p.bounce ? "checked" : ""} onchange="updateGroupVal('${activePath}', 'bounce', this.checked, false)">
                                    Bounce (Reverse Play)
                                </label>
                            </div>
                        </div>
                    `;
            return;
        }
    }

    // Otherwise, it's a pattern (not a group)
    let p = getObjByPath(activePath);
    if (!p) return;
    if (!p.phases) p = migratePattern(p);

    if (selectedPaths.size > 0) {
        if (!inspectorBuffer) {
            inspectorBuffer = {
                phases: JSON.parse(JSON.stringify(p.phases)),
                state: new Array(config.channels).fill(-1),
            };
        }
    } else {
        inspectorBuffer = null;
    }

    let currentPhases =
        selectedPaths.size > 0 ? inspectorBuffer.phases : p.phases;

    let effectiveInType =
        selectedPaths.size > 0 && !dirtyFields.has("in.type")
            ? p.phases.in.type
            : currentPhases.in.type;
    let effectiveAnimType =
        selectedPaths.size > 0 && !dirtyFields.has("anim.type")
            ? p.phases.anim.type
            : currentPhases.anim.type;
    let effectiveOutType =
        selectedPaths.size > 0 && !dirtyFields.has("out.type")
            ? p.phases.out.type
            : currentPhases.out.type;

    let stateBlocksHtml = "";
    let currentChVal = 0;

    if (selectedPaths.size > 0) {
        currentChVal =
            activeInspectorChannel !== -1 &&
            inspectorBuffer.state[activeInspectorChannel] !== undefined
                ? inspectorBuffer.state[activeInspectorChannel]
                : -1;
        stateBlocksHtml = inspectorBuffer.state
            .map((s, si) => {
                const isActive =
                    si === activeInspectorChannel
                        ? "outline: 2px solid var(--accent); outline-offset: 1px;"
                        : "";
                const chanColor = config.colors[si] || default_color;
                if (s === -1) {
                    return `<div class="block" id="inspector-ch-block-${si}" style="display:flex; align-items:center; justify-content:center; color:#666; font-size:10px; font-weight:bold; background:#222; ${isActive}" onclick="selectInspectorChannel(${si})">-</div>`;
                } else {
                    const val = parseFloat(s) || 0;
                    const isOn = isChannelOn(val);
                    const opacity = getChannelOpacity(val);
                    return `<div class="block ${isOn ? "on" : ""}" id="inspector-ch-block-${si}" style="background: ${isOn ? chanColor : "#222"}; opacity: ${isOn ? opacity : 1}; ${isActive}" onclick="selectInspectorChannel(${si})" title="${val}"></div>`;
                }
            })
            .join("");
    } else {
        currentChVal =
            activeInspectorChannel !== -1 &&
            p.state[activeInspectorChannel] !== undefined
                ? p.state[activeInspectorChannel]
                : 0;
        stateBlocksHtml = p.state
            .map((s, si) => {
                const val = parseFloat(s) || 0;
                const isActive =
                    si === activeInspectorChannel
                        ? "outline: 2px solid var(--accent); outline-offset: 1px;"
                        : "";
                const chanColor = config.colors[si] || default_color;
                const isOn = isChannelOn(val);
                const opacity = getChannelOpacity(val);
                if (isOn) {
                    return `<div class="block on" id="inspector-ch-block-${si}" style="background: ${chanColor}; opacity: ${opacity}; ${isActive}" onclick="selectInspectorChannel(${si})" title="${val}"></div>`;
                } else {
                    return `<div class="block" id="inspector-ch-block-${si}" style="background: #222; ${isActive}" onclick="selectInspectorChannel(${si})" title="0"></div>`;
                }
            })
            .join("");
    }

    let displayVal = currentChVal === -1 ? 0 : currentChVal;
    let sliderLabelExtra =
        activeInspectorChannel === -1
            ? ' <span style="color:#777; font-style:italic;">(None Selected)</span>'
            : currentChVal === -1
              ? ' <span style="color:#777; font-style:italic;">(Unchanged)</span>'
              : ` <span>(${displayVal})</span>`;

    let resetBtnHtml = "";
    if (
        selectedPaths.size > 0 &&
        currentChVal !== -1 &&
        activeInspectorChannel !== -1
    ) {
        resetBtnHtml = `<button class="btn-compact" style="padding: 2px 6px; font-size: 10px; background: #444; margin-left: auto;" onclick="resetInspectorChannelToUnchanged(${activeInspectorChannel})">RESET</button>`;
    }

    const min = config.pwmMin || DEFAULT_PWM_MIN;
    const max = config.pwmMax || DEFAULT_PWM_MAX;

    let dimmerControlHtml = `
                <div style="margin-top: 14px; background: #222; padding: 10px; border-radius: 4px; border: 1px solid #333;">
                    <div style="display:flex; align-items:center; margin-bottom: 6px;">
                        <span id="inspector-dimmer-label" style="font-size:11px; color:#aaa; font-weight:bold;">Ch ${activeInspectorChannel !== -1 ? activeInspectorChannel + 1 : "-"} Level:${sliderLabelExtra}</span>
                        ${resetBtnHtml}
                    </div>
                    <div style="display:flex; align-items:center; gap:10px;">
                        <input type="range" id="inspector-dimmer-range" min="${min}" max="${max}" step="1" value="${displayVal}" ${activeInspectorChannel === -1 ? "disabled" : ""} oninput="updateInspectorChannelVolume(${activeInspectorChannel}, this.value)" style="flex:1; accent-color:var(--accent); cursor:pointer;">
                        <input type="number" id="inspector-dimmer-number" min="${min}" max="${max}" step="1" value="${displayVal}" ${activeInspectorChannel === -1 ? "disabled" : ""} oninput="updateInspectorChannelVolume(${activeInspectorChannel}, this.value)" style="width:65px; text-align:center;">
                    </div>
                </div>
            `;

    // Background Dim checkbox (only for non‑group patterns)
    let bgDimHtml = "";
    if (p && p.type !== "group") {
        const bgDimEnabled = p.backgroundDim || false;
        bgDimHtml = `
                <div class="inspector-section" style="margin-top: 12px;">
                    <div class="inspector-label">Background Dim</div>
                    <label style="display: flex; align-items: center; gap: 10px; font-size: 12px; color: #ccc; cursor: pointer;">
                        <input type="checkbox" ${bgDimEnabled ? "checked" : ""} onchange="toggleBackgroundDim('${activePath}')">
                        Enabled
                    </label>
                    <div style="font-size: 10px; color: #666; margin-top: 4px;">
                        Global PWM: ${config.backgroundDimPWM || 0} &nbsp;|&nbsp; OFF channels will output this value when enabled.
                    </div>
                </div>
            `;
    }

    let hasStateChanges =
        selectedPaths.size > 0 &&
        inspectorBuffer &&
        inspectorBuffer.state.some((s) => s !== -1);
    let canApply = dirtyFields.size > 0 || hasStateChanges;

    let applyAllButtonHtml = "";
    if (selectedPaths.size > 0) {
        applyAllButtonHtml = `
                <div style="margin-top: 15px;">
                    <button id="btn-apply-selection" style="width: 100%; justify-content: center; background: var(--success);" onclick="applyInspectorToSelection()" ${!canApply ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ""}>
                        APPLY TO SELECTION (${selectedPaths.size})
                    </button>
                </div>`;
    }

    container.innerHTML = `
                <div class="inspector-section">
                    <div class="inspector-label">Channels Configuration</div>
                    <div class="state-blocks" style="justify-content: flex-start; gap: 4px; flex-wrap: wrap;">
                        ${stateBlocksHtml}
                    </div>
                    ${dimmerControlHtml}
                </div>

                ${bgDimHtml}

                <div class="inspector-section">
                    <div class="inspector-label">1. In-Transition</div>
                    <select class="inspector-select" onchange="updatePhase('${activePath}', 'in', 'type', this.value, true)">
                        ${selectedPaths.size > 0 ? `<option value="unchanged" ${!dirtyFields.has("in.type") ? "selected" : ""}>---- unchanged ----</option>` : ""}
                        <option value="none" ${effectiveInType === "none" && (selectedPaths.size === 0 || dirtyFields.has("in.type")) ? "selected" : ""}>None</option>
                        <option value="fade" ${effectiveInType === "fade" && (selectedPaths.size === 0 || dirtyFields.has("in.type")) ? "selected" : ""}>Fade</option>
                        <option value="steady" ${effectiveInType === "steady" && (selectedPaths.size === 0 || dirtyFields.has("in.type")) ? "selected" : ""}>Steady</option>
                    </select>
                    ${
                        effectiveInType !== "none"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms): ${selectedPaths.size > 0 && !dirtyFields.has("in.duration") ? '<span style="color:#666; font-style:italic;">(unchanged)</span>' : ""}</span>
                        <input type="number" value="${currentPhases.in.duration}" oninput="updatePhase('${activePath}', 'in', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>

                <div class="inspector-section">
                    <div class="inspector-label">2. Animation</div>
                    <select class="inspector-select" onchange="updatePhase('${activePath}', 'anim', 'type', this.value, true)">
                        ${selectedPaths.size > 0 ? `<option value="unchanged" ${!dirtyFields.has("anim.type") ? "selected" : ""}>---- unchanged ----</option>` : ""}
                        <option value="none" ${effectiveAnimType === "none" && (selectedPaths.size === 0 || dirtyFields.has("anim.type")) ? "selected" : ""}>None</option>
                        <option value="flicker" ${effectiveAnimType === "flicker" && (selectedPaths.size === 0 || dirtyFields.has("anim.type")) ? "selected" : ""}>Flicker</option>
                    </select>
                    ${
                        effectiveAnimType === "flicker"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Amount: ${selectedPaths.size > 0 && !dirtyFields.has("anim.amount") ? '<span style="color:#666; font-style:italic;">(unchanged)</span>' : ""}</span>
                        <input type="number" value="${currentPhases.anim.amount || 0}" oninput="updatePhase('${activePath}', 'anim', 'amount', this.value, false)" style="width:70px;">
                    </div>
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms): ${selectedPaths.size > 0 && !dirtyFields.has("anim.duration") ? '<span style="color:#666; font-style:italic;">(unchanged)</span>' : ""}</span>
                        <input type="number" value="${currentPhases.anim.duration}" oninput="updatePhase('${activePath}', 'anim', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>

                <div class="inspector-section">
                    <div class="inspector-label">3. Out-Transition</div>
                    <select class="inspector-select" onchange="updatePhase('${activePath}', 'out', 'type', this.value, true)">
                        ${selectedPaths.size > 0 ? `<option value="unchanged" ${!dirtyFields.has("out.type") ? "selected" : ""}>---- unchanged ----</option>` : ""}
                        <option value="none" ${effectiveOutType === "none" && (selectedPaths.size === 0 || dirtyFields.has("out.type")) ? "selected" : ""}>None</option>
                        <option value="fade" ${effectiveOutType === "fade" && (selectedPaths.size === 0 || dirtyFields.has("out.type")) ? "selected" : ""}>Fade</option>
                        <option value="steady" ${effectiveOutType === "steady" && (selectedPaths.size === 0 || dirtyFields.has("out.type")) ? "selected" : ""}>Steady</option>
                    </select>
                    ${
                        effectiveOutType !== "none"
                            ? `
                    <div class="inspector-row">
                        <span style="font-size:11px; color:#ccc;">Duration (ms): ${selectedPaths.size > 0 && !dirtyFields.has("out.duration") ? '<span style="color:#666; font-style:italic;">(unchanged)</span>' : ""}</span>
                        <input type="number" value="${currentPhases.out.duration}" oninput="updatePhase('${activePath}', 'out', 'duration', this.value, false)" style="width:70px;">
                    </div>`
                            : ""
                    }
                </div>
                ${applyAllButtonHtml}
            `;
}

// ==========================================================================
// PHASE & GROUP VALUE UPDATES
// Editing individual phase fields and group repeat/bounce settings.
// ==========================================================================
function updatePhase(path, phase, key, value, refreshInspector = false) {
    if (selectedPaths.size > 0) {
        if (!inspectorBuffer) {
            let p = getObjByPath(path);
            if (!p.phases) p = migratePattern(p);
            inspectorBuffer = {
                phases: JSON.parse(JSON.stringify(p.phases)),
                state: new Array(config.channels).fill(-1),
            };
        }
        if (key === "type") {
            if (value === "unchanged") {
                dirtyFields.delete(`${phase}.type`);
                dirtyFields.delete(`${phase}.duration`);
                dirtyFields.delete(`${phase}.amount`);
            } else {
                inspectorBuffer.phases[phase].type = value;
                dirtyFields.add(`${phase}.type`);
                if (value !== "none") {
                    inspectorBuffer.phases[phase].duration = 500;
                    dirtyFields.add(`${phase}.duration`);
                }
                if (value === "flicker") {
                    inspectorBuffer.phases[phase].amount = 3;
                    dirtyFields.add(`${phase}.amount`);
                }
            }
        } else {
            inspectorBuffer.phases[phase][key] = parseInt(value) || 0;
            dirtyFields.add(`${phase}.${key}`);
        }
        if (refreshInspector) renderInspector();
        else {
            let hasStateChanges = inspectorBuffer.state.some((s) => s !== -1);
            if (dirtyFields.size > 0 || hasStateChanges) {
                const applyBtn = document.getElementById("btn-apply-selection");
                if (applyBtn) {
                    applyBtn.removeAttribute("disabled");
                    applyBtn.style.cssText =
                        "width: 100%; justify-content: center; background: var(--success);";
                }
            }
        }
        return;
    }

    let p = getObjByPath(path);
    if (!p.phases) p = migratePattern(p);
    if (key === "type") {
        p.phases[phase].type = value;
        if (value !== "none" && !p.phases[phase].duration)
            p.phases[phase].duration = 500;
        if (value === "flicker" && !p.phases[phase].amount)
            p.phases[phase].amount = 3;
    } else {
        p.phases[phase][key] = parseInt(value) || 0;
    }

    updateJsonPanel();
    renderTable();
    if (refreshInspector) renderInspector();
}

function updateGroupVal(path, key, val, refresh = false) {
    let p = config.patterns[parseInt(path)];
    if (key === "repeat") p.repeat = parseInt(val) || 1;
    if (key === "bounce") p.bounce = !!val;
    updateJsonPanel();
    if (refresh) renderInspector();
}

function renderTableSelection(skipInspector = false) {
    const count = selectedPaths.size;
    document.querySelectorAll("#pattern-list tr").forEach((tr) => {
        if (tr.dataset.path)
            tr.classList.toggle("selected", selectedPaths.has(tr.dataset.path));
    });
    document.getElementById("del-count-text").innerText =
        count > 0 ? `(${count})` : "";
    [
        "sel-clone",
        "sel-reverse",
        "sel-invert",
        "sel-mirror",
        "sel-left",
        "sel-right",
        "sel-clear",
        "sel-delete",
        "sel-group",
        "sel-odd",
        "sel-even",
    ].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.disabled = count === 0;
    });
    if (!skipInspector) renderInspector();
}

// ==========================================================================
// PLAYBACK ENGINE
// Runs the configured pattern in real time and drives the live preview.
// ==========================================================================
function togglePlayback() {
    if (isPlaying) stopStrobe();
    else playStrobe();
}

function highlightPlayingRow(path) {
    document
        .querySelectorAll("#pattern-list tr")
        .forEach((tr) => tr.classList.remove("playing"));
    if (path && showSteps) {
        const tr = document.querySelector(
            `#pattern-list tr[data-path='${path}']`,
        );
        if (tr) tr.classList.add("playing");
    }
}

async function playStrobe() {
    if (isPlaying) return;
    isPlaying = true;
    abortController = new AbortController();
    const btn = document.getElementById("main-playback-btn");
    btn.className = "stop-btn";
    document.getElementById("playback-text").innerText = "STOP";
    document.getElementById("playback-icon").src = "/assets/stop.svg";
    try {
        while (isPlaying) {
            if (config.patterns.length === 0) break;
            let indices =
                soloGroupIdx !== null &&
                config.patterns[soloGroupIdx]?.type === "group"
                    ? [soloGroupIdx]
                    : config.patterns.map((_, i) => i);
            for (let gIdx of indices) {
                let item = config.patterns[gIdx];
                if (!item || !isPlaying) continue;
                if (item.type === "group") {
                    for (let r = 0; r < item.repeat; r++) {
                        for (
                            let pIdx = 0;
                            pIdx < item.patterns.length;
                            pIdx++
                        ) {
                            if (!isPlaying) break;
                            await playSinglePattern(
                                item.patterns[pIdx],
                                `${gIdx}-${pIdx}`,
                            );
                        }
                        if (
                            item.bounce &&
                            isPlaying &&
                            item.patterns.length > 1
                        ) {
                            for (
                                let pIdx = item.patterns.length - 2;
                                pIdx >= 0;
                                pIdx--
                            ) {
                                if (
                                    !isPlaying ||
                                    (pIdx === 0 && r < item.repeat - 1)
                                )
                                    continue;
                                await playSinglePattern(
                                    item.patterns[pIdx],
                                    `${gIdx}-${pIdx}`,
                                );
                            }
                        }
                    }
                } else await playSinglePattern(item, `${gIdx}`);
            }
        }
    } catch (e) {}
}

async function playSinglePattern(p, path) {
    highlightPlayingRow(path);
    if (!p.phases) p = migratePattern(p);
    let timePlayed = false;
    const bgDimEnabled = p.backgroundDim || false;

    if (p.phases.in.type === "fade" && p.phases.in.duration > 0) {
        renderLights(p.state, p.phases.in.duration, bgDimEnabled);
        await sleep(p.phases.in.duration, abortController.signal);
        timePlayed = true;
    } else if (p.phases.in.type === "steady" && p.phases.in.duration > 0) {
        renderLights(p.state, 0, bgDimEnabled);
        await sleep(p.phases.in.duration, abortController.signal);
        timePlayed = true;
    }

    if (p.phases.anim.type === "flicker" && p.phases.anim.amount > 0) {
        let animDur = p.phases.anim.duration > 0 ? p.phases.anim.duration : 500;
        const step = animDur / (p.phases.anim.amount * 2);
        for (let f = 0; f < p.phases.anim.amount * 2; f++) {
            if (!isPlaying) break;
            renderLights(
                f % 2 === 0
                    ? p.state
                    : new Array(config.channels).fill(
                          config.pwmMin || DEFAULT_PWM_MIN,
                      ),
                0,
                bgDimEnabled,
            );
            await sleep(step, abortController.signal);
        }
        timePlayed = true;
    }

    if (p.phases.out.type === "fade" && p.phases.out.duration > 0) {
        renderLights(
            new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
            p.phases.out.duration,
            bgDimEnabled,
        );
        await sleep(p.phases.out.duration, abortController.signal);
        timePlayed = true;
    } else if (p.phases.out.type === "steady" && p.phases.out.duration > 0) {
        renderLights(p.state, 0, bgDimEnabled);
        await sleep(p.phases.out.duration, abortController.signal);
        timePlayed = true;
    }
    if (!timePlayed) await sleep(10, abortController.signal);
}

function stopStrobe() {
    isPlaying = false;
    abortController?.abort();
    highlightPlayingRow(null);
    const btn = document.getElementById("main-playback-btn");
    btn.className = "play-btn";
    document.getElementById("playback-text").innerText = "PLAY";
    document.getElementById("playback-icon").src = "/assets/play.svg";
    const bgDim = getBackgroundDimForPath(activePath);
    renderLights(
        new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
        0,
        bgDim,
    );
}

// ==========================================================================
// BATCH ROW / GROUP OPERATIONS
// Operations that act on the entire current selection (reverse, invert,
// mirror, duplicate, delete).
// ==========================================================================
function deletePaths(pathsArray) {
    pathsArray.sort((a, b) => {
        let [aG, aP] = a.split("-").map(Number);
        let [bG, bP] = b.split("-").map(Number);
        if (aG !== bG) return bG - aG;
        return aP !== undefined && bP !== undefined ? bP - aP : 0;
    });
    pathsArray.forEach((path) => {
        let [gIdx, pIdx] = path.split("-");
        if (pIdx === undefined) config.patterns.splice(Number(gIdx), 1);
        else config.patterns[Number(gIdx)].patterns.splice(Number(pIdx), 1);
    });
    config.patterns = config.patterns.filter(
        (p) => p.type !== "group" || p.patterns.length > 0,
    );
}
function reverseSelectedOrder() {
    if (selectedPaths.size < 2) return;
    const groups = {};
    selectedPaths.forEach((path) => {
        const parts = path.split("-");
        const key = parts.length > 1 ? `group-${parts[0]}` : "root";
        if (!groups[key]) groups[key] = [];
        groups[key].push(path);
    });
    Object.keys(groups).forEach((key) => {
        const paths = groups[key].sort(
            (a, b) => getIdxByPath(a) - getIdxByPath(b),
        );
        if (paths.length < 2) return;
        const parentArr = getArrByPath(paths[0]);
        const indices = paths.map((p) => getIdxByPath(p));
        const items = indices.map((idx) => parentArr[idx]);
        items.reverse();
        indices.forEach((idx, i) => (parentArr[idx] = items[i]));
    });
    renderTable();
    showToast("Reversed order");
}
function invertSelected() {
    selectedPaths.forEach((path) => invertRow(path, false));
    renderTable();
    showToast("Inverted selection");
}
function mirrorSelected() {
    selectedPaths.forEach((path) => mirrorPattern(path, false));
    renderTable();
    showToast("Mirrored selection");
}
function duplicateSelected() {
    if (selectedPaths.size === 0) return;
    let roots = {};
    selectedPaths.forEach((p) => {
        let r = p.split("-")[0];
        if (!roots[r]) roots[r] = [];
        roots[r].push(p);
    });
    let sorted = Object.keys(roots)
        .map(Number)
        .sort((a, b) => a - b);
    let clones = [];
    sorted.forEach((idx) => {
        let item = config.patterns[idx];
        if (
            item.type === "group" &&
            !item.patterns.every((_, pIdx) =>
                selectedPaths.has(`${idx}-${pIdx}`),
            )
        ) {
            item.patterns.forEach((c, pIdx) => {
                if (selectedPaths.has(`${idx}-${pIdx}`))
                    clones.push(JSON.parse(JSON.stringify(c)));
            });
        } else clones.push(JSON.parse(JSON.stringify(item)));
    });
    config.patterns.splice(sorted[sorted.length - 1] + 1, 0, ...clones);
    selectedPaths.clear();
    renderTable();
    showToast("Duplicated selection");
}

// ==========================================================================
// ROW & GROUP CRUD
// Add / duplicate / invert / remove individual rows and groups.
// ==========================================================================
function deleteSelected() {
    if (selectedPaths.size === 0) return;
    const count = selectedPaths.size;
    const sortedPaths = Array.from(selectedPaths).sort((a, b) => {
        let [aG, aP] = a.split("-").map(Number);
        let [bG, bP] = b.split("-").map(Number);
        return aG === bG ? (aP || 0) - (bP || 0) : aG - bG;
    });
    const lastPath = sortedPaths[sortedPaths.length - 1];
    const rows = Array.from(
        document.querySelectorAll("#pattern-list tr"),
    ).filter((tr) => tr.dataset.path || tr.dataset.groupPath);
    const lastIdx = rows.findIndex(
        (tr) => (tr.dataset.path || tr.dataset.groupPath) === lastPath,
    );
    deletePaths(Array.from(selectedPaths));
    selectedPaths.clear();
    activePath = null;
    inspectorBuffer = null;
    dirtyFields.clear();
    renderTable();
    const newRows = Array.from(
        document.querySelectorAll("#pattern-list tr"),
    ).filter((tr) => tr.dataset.path || tr.dataset.groupPath);
    if (newRows.length > 0) {
        setActivePath(
            newRows[Math.min(lastIdx, newRows.length - 1)].dataset.path ||
                newRows[Math.min(lastIdx, newRows.length - 1)].dataset
                    .groupPath,
        );
    } else renderInspector();
    showToast(`Deleted ${count} items`);
}

function duplicateGroup(gIdx) {
    config.patterns.splice(
        gIdx + 1,
        0,
        JSON.parse(JSON.stringify(config.patterns[gIdx])),
    );
    setActivePath((gIdx + 1).toString());
}

function invertGroup(gIdx) {
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    config.patterns[gIdx].patterns.forEach((p) => {
        p.state = p.state.map((s) => {
            let val = Math.round(parseFloat(s) || 0);
            return max - val;
        });
    });
    renderTable();
}

function toggleSolo(gIdx) {
    soloGroupIdx = soloGroupIdx === gIdx ? null : gIdx;
    renderTable();
}

function addPattern() {
    // Deep clone defaultPattern and add state array
    const newPattern = JSON.parse(JSON.stringify(config.defaultPattern));
    newPattern.state = new Array(config.channels).fill(
        config.pwmMin || DEFAULT_PWM_MIN,
    );
    config.patterns.push(newPattern);
    renderTable();
}

function duplicateRow(path) {
    let arr = getArrByPath(path);
    let idx = getIdxByPath(path);
    arr.splice(idx + 1, 0, JSON.parse(JSON.stringify(arr[idx])));
    renderTable();
}

function invertRow(path, render = true) {
    const max = config.pwmMax || DEFAULT_PWM_MAX;
    let p = getObjByPath(path);
    p.state = p.state.map((s) => {
        let val = Math.round(parseFloat(s) || 0);
        return max - val;
    });
    if (render) renderTable();
}

function removePattern(path) {
    const rows = Array.from(
        document.querySelectorAll("#pattern-list tr"),
    ).filter((tr) => tr.dataset.path || tr.dataset.groupPath);
    const currentIdx = rows.findIndex(
        (tr) => (tr.dataset.path || tr.dataset.groupPath) === path,
    );
    if (!path.includes("-")) {
        const idx = parseInt(path);
        config.patterns.splice(idx, 1);
        if (soloGroupIdx === idx) soloGroupIdx = null;
        else if (soloGroupIdx > idx) soloGroupIdx--;
    } else deletePaths([path]);
    activePath = null;
    inspectorBuffer = null;
    dirtyFields.clear();
    renderTable();
    const newRows = Array.from(
        document.querySelectorAll("#pattern-list tr"),
    ).filter((tr) => tr.dataset.path || tr.dataset.groupPath);
    if (newRows.length > 0) {
        setActivePath(
            newRows[Math.min(currentIdx, newRows.length - 1)].dataset.path ||
                newRows[Math.min(currentIdx, newRows.length - 1)].dataset
                    .groupPath,
        );
    } else renderInspector();
    showToast("Item deleted");
}

function clearAllPatterns() {
    if (confirm("Delete ALL rows?")) {
        config.patterns = [];
        selectedPaths.clear();
        activePath = null;
        inspectorBuffer = null;
        dirtyFields.clear();
        soloGroupIdx = null;
        renderTable();
        renderInspector();
    }
}

// ==========================================================================
// ROW STATE TRANSFORMS
// Shifting a row's channel values left/right, or mirroring them.
// ==========================================================================
function shiftPattern(path, dir, render = true) {
    let p = getObjByPath(path);
    if (!p || p.type === "group") return;
    dir === "left"
        ? p.state.push(p.state.shift())
        : p.state.unshift(p.state.pop());
    if (render) renderTable();
    updateJsonPanel();
}
function mirrorPattern(path, render = true) {
    let p = getObjByPath(path);
    p.state.reverse();
    if (render) renderTable();
    updateJsonPanel();
}

// ==========================================================================
// DRAG & DROP REORDERING
// Reordering rows in the table via native HTML5 drag and drop.
// ==========================================================================
function handleDrop(target, dragged) {
    const isTChild = target.includes("-"),
        isDChild = dragged.includes("-");
    if (!isTChild && !isDChild) {
        const tIdx = parseInt(target),
            dIdx = parseInt(dragged);
        let indicesToMove = selectedPaths.has(dragged)
            ? Array.from(selectedPaths)
                  .filter((p) => !p.includes("-"))
                  .map(Number)
                  .sort((a, b) => a - b)
            : [dIdx];
        const items = indicesToMove.map((idx) => config.patterns[idx]);
        for (let i = indicesToMove.length - 1; i >= 0; i--) {
            config.patterns.splice(indicesToMove[i], 1);
        }
        let insertIdx = tIdx - indicesToMove.filter((idx) => idx < tIdx).length;
        config.patterns.splice(insertIdx, 0, ...items);
        const newSelection = new Set();
        for (let i = 0; i < items.length; i++) {
            newSelection.add((insertIdx + i).toString());
        }
        selectedPaths = newSelection;
    } else if (isTChild && isDChild) {
        const tG = target.split("-")[0],
            dG = dragged.split("-")[0];
        if (tG !== dG) return;
        const gIdx = parseInt(tG),
            tIdx = parseInt(target.split("-")[1]),
            dIdx = parseInt(dragged.split("-")[1]);
        let childIndices = selectedPaths.has(dragged)
            ? Array.from(selectedPaths)
                  .filter((p) => p.startsWith(tG + "-"))
                  .map((p) => parseInt(p.split("-")[1]))
                  .sort((a, b) => a - b)
            : [dIdx];
        const children = childIndices.map(
            (idx) => config.patterns[gIdx].patterns[idx],
        );
        for (let i = childIndices.length - 1; i >= 0; i--) {
            config.patterns[gIdx].patterns.splice(childIndices[i], 1);
        }
        let insertIdx = tIdx - childIndices.filter((idx) => idx < tIdx).length;
        config.patterns[gIdx].patterns.splice(insertIdx, 0, ...children);
        const newSelection = new Set();
        for (let i = 0; i < children.length; i++) {
            newSelection.add(`${gIdx}-${insertIdx + i}`);
        }
        selectedPaths = newSelection;
    }
    renderTable();
    showToast("Moved selection");
}

// ==========================================================================
// JSON PANEL SYNC
// Keeps the raw-JSON textarea in the modal in sync with `config`.
// ==========================================================================
function updateJsonPanel() {
    const el = document.getElementById("json-input"),
        currentJson = JSON.stringify(config);
    if (document.activeElement !== el) {
        el.value = JSON.stringify(config, null, 2).replace(
            /"state":\s*\[\s+([\s\S]*?)\s+\]/g,
            (m, p) =>
                `"state": [${p
                    .split(",")
                    .map((s) => s.trim())
                    .filter((s) => s !== "")
                    .join(", ")}]`,
        );
    }
    fetch("/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: currentJson,
    }).catch((e) => {});
    localStorage.setItem(`strobe_config_v${version}`, currentJson);
    if (
        !isUndoRedoAction &&
        (historyIndex === -1 || currentJson !== historyStack[historyIndex])
    )
        saveState(currentJson);
    updateUndoRedoButtons();
}

function handleManualJsonEdit(val) {
    try {
        const p = JSON.parse(val);
        if (p && typeof p.channels === "number" && Array.isArray(p.patterns)) {
            config = p;
            ensureConfigDefaults();
            config = migrateConfigToPWM(config);
            if (!config._strobe_editor_version)
                config._strobe_editor_version = "1";
            if (!config.colors) config.colors = [];
            while (config.colors.length < config.channels)
                config.colors.push(default_color);
            syncCanvasLayoutLength();
            document.getElementById("light-bar").innerHTML = "";
            document.getElementById("custom-layout-view").innerHTML = "";
            const bgDim = getBackgroundDimForPath(activePath);
            renderLights(
                new Array(config.channels).fill(
                    config.pwmMin || DEFAULT_PWM_MIN,
                ),
                0,
                bgDim,
            );
            document.getElementById("global-channels").value = config.channels;
            activePath = null;
            inspectorBuffer = null;
            dirtyFields.clear();
            renderTable();
            renderInspector();
        }
    } catch (e) {}
}
const sleep = (ms, sig) =>
    new Promise((res, rej) => {
        const t = setTimeout(res, ms);
        sig?.addEventListener("abort", () => {
            clearTimeout(t);
            rej();
        });
    });

// ==========================================================================
// CUSTOM CANVAS LAYOUT
// The free-form "custom layout" preview where channel nodes can be
// dragged to arbitrary positions on a canvas.
// ==========================================================================
function loadCanvasLayoutData() {
    let data = localStorage.getItem(`strobe_canvas_layout_v${version}`);
    if (data) {
        try {
            canvasLayoutData = JSON.parse(data);
        } catch (e) {
            canvasLayoutData = [];
        }
    } else {
        canvasLayoutData = [];
    }
    syncCanvasLayoutLength();
}

function syncCanvasLayoutLength() {
    while (canvasLayoutData.length < config.channels) {
        let i = canvasLayoutData.length;
        let row = Math.floor(i / 5);
        let col = i % 5;
        canvasLayoutData.push({
            x: 15 + col * 16,
            y: 25 + row * 40,
            shape: "circle",
        });
    }
    if (canvasLayoutData.length > config.channels) {
        canvasLayoutData = canvasLayoutData.slice(0, config.channels);
    }
    localStorage.setItem(
        `strobe_canvas_layout_v${version}`,
        JSON.stringify(canvasLayoutData),
    );
}

function setPreviewMode(mode) {
    previewMode = mode;
    const bar = document.getElementById("light-bar");
    const customView = document.getElementById("custom-layout-view");
    const barBtn = document.getElementById("view-bar-btn");
    const customBtn = document.getElementById("view-custom-btn");
    const shapeCtrls = document.getElementById("custom-shape-controls");

    document.getElementById("btn-reset-layout").style.display =
        mode === "custom" ? "inline-flex" : "none";

    if (mode === "custom") {
        bar.style.display = "none";
        customView.style.display = "block";
        barBtn.style.background = "transparent";
        customBtn.style.background = "var(--accent)";
        shapeCtrls.style.display = "flex";
        document.getElementById("shape-control-ch-num").innerText =
            activeInspectorChannel !== -1 ? activeInspectorChannel + 1 : "-";
        if (
            activeInspectorChannel !== -1 &&
            canvasLayoutData[activeInspectorChannel]
        ) {
            document.getElementById("canvas-item-shape").value =
                canvasLayoutData[activeInspectorChannel].shape;
        }
    } else {
        bar.style.display = "flex";
        customView.style.display = "none";
        barBtn.style.background = "var(--accent)";
        customBtn.style.background = "transparent";
        shapeCtrls.style.display = "none";
    }

    if (activePath) {
        let currP = getObjByPath(activePath);
        if (currP && currP.state) {
            const bgDim = getBackgroundDimForPath(activePath);
            renderLights(currP.state, 0, bgDim);
        }
    } else {
        renderLights(
            new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
            0,
            false,
        );
    }
}

function setCanvasItemShape(shape) {
    const selectedNodes = document.querySelectorAll(
        "#custom-layout-view .active-node-sel",
    );

    // Nothing selected -> ask to apply to all
    if (selectedNodes.length === 0) {
        if (
            !confirm(
                `No channels are selected.\n\nApply "${shape}" to all ${config.channels} indicators?`,
            )
        ) {
            return;
        }

        canvasLayoutData.forEach((node) => {
            node.shape = shape;
        });
    } else {
        // Apply only to selected nodes
        selectedNodes.forEach((node) => {
            const idx = parseInt(node.dataset.channel, 10);
            if (canvasLayoutData[idx]) {
                canvasLayoutData[idx].shape = shape;
            }
        });
    }

    renderLights(
        isPlaying
            ? currentLightState
            : new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
        false,
    );
}

function handleCanvasNodeMouseDown(e, index) {
    e.stopPropagation();
    e.preventDefault();
    draggedChannelIdx = index;
    selectInspectorChannel(index);

    const container = document.getElementById("custom-layout-view");
    const rect = container.getBoundingClientRect();

    function onMouseMove(moveEvent) {
        if (draggedChannelIdx === null) return;
        let relX = ((moveEvent.clientX - rect.left) / rect.width) * 100;
        let relY = ((moveEvent.clientY - rect.top) / rect.height) * 100;

        relX = Math.min(100, Math.max(0, relX));
        relY = Math.min(100, Math.max(0, relY));

        canvasLayoutData[draggedChannelIdx].x = Math.round(relX * 10) / 10;
        canvasLayoutData[draggedChannelIdx].y = Math.round(relY * 10) / 10;

        const el = document.getElementById(`canvas-node-${draggedChannelIdx}`);
        if (el) {
            el.style.left = `${canvasLayoutData[draggedChannelIdx].x}%`;
            el.style.top = `${canvasLayoutData[draggedChannelIdx].y}%`;
        }
    }

    function onMouseUp() {
        draggedChannelIdx = null;
        localStorage.setItem(
            `strobe_canvas_layout_v${version}`,
            JSON.stringify(canvasLayoutData),
        );
        window.removeEventListener("mousemove", onMouseMove);
        window.removeEventListener("mouseup", onMouseUp);
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
}

function resetIndicatorPositions() {
    if (!confirm("Reset position of all indicators?")) return;
    const cols = Math.ceil(config.channels / 2);
    const topY = 25;
    const bottomY = 65;

    const startX = 15;
    const endX = 79;

    const step = cols > 1 ? (endX - startX) / (cols - 1) : 0;

    canvasLayoutData = [];

    for (let i = 0; i < config.channels; i++) {
        const row = i < cols ? 0 : 1;
        const col = row === 0 ? i : i - cols;

        canvasLayoutData.push({
            x: startX + col * step,
            y: row === 0 ? topY : bottomY,
            shape: "circle",
        });
    }

    renderLights(
        isPlaying
            ? currentLightState
            : new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
        false,
    );
    showToast("Indicator positions reset", "success");
}
// ==========================================================================
// LIGHT PREVIEW RENDERING
// Draws the current channel state onto the bar/canvas preview.
// ==========================================================================
function renderLights(state, transitionMs = 0, bgDimEnabled = false) {
    const bar = document.getElementById("light-bar");
    const customView = document.getElementById("custom-layout-view");
    if (!bar || !customView) return;

    if (!config.colors) config.colors = [];
    while (config.colors.length < config.channels) {
        config.colors.push(default_color);
    }

    // Compute output state with background dimming
    const bgPWM = config.backgroundDimPWM || 0;
    const outputState = state.map((val) => {
        const num = parseFloat(val) || 0;
        if (num === 0 && bgDimEnabled) {
            return bgPWM;
        }
        return num;
    });

    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
            JSON.stringify({
                type: "LIVE",
                state: outputState,
                transition: transitionMs,
            }),
        );
    }

    if (bar.children.length !== state.length) {
        bar.innerHTML = "";
        state.forEach((_, i) => {
            const container = document.createElement("div");
            container.className = "light-container";
            container.style.cssText =
                "display: flex; flex-direction: column; flex: 1; align-items: center; gap: 4px; height: 100%; justify-content: space-between;";

            const l = document.createElement("div");
            l.className = "light";
            l.style.cssText =
                "width: 100%; flex: 1; background: #222; border-radius: 4px; transition: all 0.05s; border: 1px solid var(--border);";

            const controls = document.createElement("div");
            controls.className = "channel-control";
            controls.style.cssText =
                "display: flex; align-items: center; gap: 4px; font-size: 10px; color: #888; font-weight: bold; line-height: 1;";

            const numLabel = document.createElement("span");
            numLabel.innerText = i + 1;

            const picker = document.createElement("div");
            picker.className = "channel-color-swatch";
            picker.dataset.color = config.colors[i] || default_color;
            picker.style.cssText =
                "width: 14px; height: 14px; background-color: " +
                (config.colors[i] || default_color) +
                "; border: 1px solid #ffffff; box-shadow: 0 0 0 1px #444; border-radius: 2px; cursor: pointer; padding:0; margin:0;";

            picker.onclick = (e) => {
                openCustomColorPopup(e, i);
            };

            controls.appendChild(numLabel);
            controls.appendChild(picker);
            container.appendChild(l);
            container.appendChild(controls);
            bar.appendChild(container);
        });
    }

    if (customView.children.length !== state.length) {
        customView.innerHTML = "";
        state.forEach((_, i) => {
            const el = document.createElement("div");
            el.className = "canvas-light-node";
            el.id = `canvas-node-${i}`;
            el.dataset.channel = i;
            el.innerHTML = `<span>${i + 1}</span>`;

            el.onmousedown = (e) => handleCanvasNodeMouseDown(e, i);
            el.oncontextmenu = (e) => {
                e.preventDefault();
                openCustomColorPopup(e, i);
            };

            customView.appendChild(el);
        });
    }

    if (canvasLayoutData.length !== config.channels) {
        syncCanvasLayoutLength();
    }

    Array.from(bar.children).forEach((container, i) => {
        const l = container.querySelector(".light");
        const picker = container.querySelector(".channel-color-swatch");
        if (picker && picker.dataset.color !== config.colors[i]) {
            picker.dataset.color = config.colors[i];
            picker.style.backgroundColor = config.colors[i];
        }
        if (!l) return;
        if (transitionMs > 0)
            l.style.transition = `all ${transitionMs}ms ease-in-out`;
        else l.style.transition = `all 0.05s`;
        const val = parseFloat(outputState[i]) || 0;
        const isOn = isChannelOn(val);
        const opacity = getChannelOpacity(val);
        const chanColor = config.colors[i] || default_color;
        if (isOn) {
            l.classList.add("on");
            l.style.background = chanColor;
            l.style.borderColor = chanColor;
            l.style.opacity = opacity;
            l.style.boxShadow = `0 0 ${15 * opacity}px ${chanColor}`;
        } else {
            l.classList.remove("on");
            l.style.background = "#222";
            l.style.borderColor = "var(--border)";
            l.style.opacity = 1;
            l.style.boxShadow = "none";
        }
    });

    Array.from(customView.children).forEach((el, i) => {
        const layout = canvasLayoutData[i];
        if (!layout) return;

        el.className = `canvas-light-node shape-${layout.shape}`;
        if (i === activeInspectorChannel && previewMode === "custom") {
            el.classList.add("active-node-sel");
        }

        el.style.left = `${layout.x}%`;
        el.style.top = `${layout.y}%`;

        if (transitionMs > 0)
            el.style.transition = `all ${transitionMs}ms ease-in-out, left 0s, top 0s`;
        else el.style.transition = `all 0.05s, left 0s, top 0s`;

        const val = parseFloat(outputState[i]) || 0;
        const isOn = isChannelOn(val);
        const opacity = getChannelOpacity(val);
        const chanColor = config.colors[i] || default_color;
        if (isOn) {
            el.style.background = chanColor;
            el.style.borderColor = chanColor;
            el.style.opacity = opacity;
            el.style.boxShadow = `0 0 ${15 * opacity}px ${chanColor}`;
            el.style.color = "#000";
        } else {
            el.style.background = "#222";
            el.style.borderColor = "var(--border)";
            el.style.opacity = 1;
            el.style.boxShadow = "none";
            el.style.color = "#fff";
        }
    });
}

// ==========================================================================
// APP INITIALIZATION
// Loads the saved config, restores history, and renders the initial UI
// once the DOM is ready.
// ==========================================================================
document.addEventListener("DOMContentLoaded", async () => {
    // Load user preferences from localStorage
    const savedIncrement = localStorage.getItem("strobe_brush_increment");
    if (savedIncrement !== null) {
        brushIncrement = Math.round(
            Math.min(1023, Math.max(1, parseFloat(savedIncrement))),
        );
    } else {
        brushIncrement = 100;
        localStorage.setItem("strobe_brush_increment", brushIncrement);
    }

    try {
        const response = await fetch("/config.json");
        if (response.ok) {
            config = await response.json();
        } else {
            throw new Error("Local fallback");
        }
    } catch (e) {
        const savedConfig = localStorage.getItem(`strobe_config_v${version}`);
        if (savedConfig) {
            try {
                config = JSON.parse(savedConfig);
            } catch (err) {}
        }
    }
    ensureConfigDefaults();
    config = migrateConfigToPWM(config);
    if (!config._strobe_editor_version) config._strobe_editor_version = "1";
    if (!config.colors) config.colors = [];
    while (config.colors.length < config.channels)
        config.colors.push(default_color);
    loadCanvasLayoutData();
    if (historyStack.length === 0 || historyIndex === -1) {
        historyStack = [];
        historyIndex = -1;
        saveState(JSON.stringify(config));
    }
    document.getElementById("global-channels").value = config.channels;
    const bgDim = getBackgroundDimForPath(activePath);
    renderLights(
        new Array(config.channels).fill(config.pwmMin || DEFAULT_PWM_MIN),
        0,
        bgDim,
    );
    renderTable();
    renderInspector();
    updateUndoRedoButtons();

    setActiveTool("hybrid");
    setupLayoutPanelsResizers();

    const cv = document.getElementById("custom-layout-view");
    cv.addEventListener("mousedown", (e) => {
        if (e.target === cv) {
            selectInspectorChannel(-1);
        }
    });
});

// ==========================================================================
// RESIZABLE LAYOUT PANELS
// Drag handles for resizing the preview header and inspector panel.
// ==========================================================================
function setupLayoutPanelsResizers() {
    const hResizer = document.getElementById("h-resizer");
    const visualizerHeader = document.querySelector(".visualizer-header");
    const vResizer = document.getElementById("v-resizer");
    const inspectorPanel = document.getElementById("inspector-panel");

    const savedHeaderHeight = localStorage.getItem("strobe_visualizer_height");
    if (savedHeaderHeight && visualizerHeader) {
        visualizerHeader.style.height = savedHeaderHeight;
    } else if (visualizerHeader) {
        visualizerHeader.style.height = "145px";
    }

    const savedInspectorWidth = localStorage.getItem("strobe_inspector_width");
    if (savedInspectorWidth && inspectorPanel) {
        inspectorPanel.style.width = savedInspectorWidth;
    }

    if (hResizer && visualizerHeader) {
        hResizer.addEventListener("dblclick", () => {
            visualizerHeader.style.height = "145px";
            localStorage.removeItem("strobe_visualizer_height");
            showToast("Visualizer preview reset to default layout");
        });

        hResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            hResizer.classList.add("resizing");
            document.body.classList.add("is-resizing");

            const startY = e.clientY;
            const startHeight = visualizerHeader.getBoundingClientRect().height;

            function onMouseMove(e) {
                const currentHeight = startHeight + (e.clientY - startY);
                if (currentHeight >= 80 && currentHeight <= 400) {
                    visualizerHeader.style.height = `${currentHeight}px`;
                }
            }

            function onMouseUp() {
                hResizer.classList.remove("resizing");
                document.body.classList.remove("is-resizing");
                localStorage.setItem(
                    "strobe_visualizer_height",
                    visualizerHeader.style.height,
                );
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            }

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });
    }

    if (vResizer && inspectorPanel) {
        vResizer.addEventListener("dblclick", () => {
            inspectorPanel.style.width = "";
            localStorage.removeItem("strobe_inspector_width");
            showToast("Inspector layout panels width reset to default");
        });

        vResizer.addEventListener("mousedown", (e) => {
            e.preventDefault();
            vResizer.classList.add("resizing");
            document.body.classList.add("is-resizing");

            const startX = e.clientX;
            const startWidth = inspectorPanel.getBoundingClientRect().width;

            function onMouseMove(e) {
                const currentWidth = startWidth - (e.clientX - startX);
                if (currentWidth >= 200 && currentWidth <= 600) {
                    inspectorPanel.style.width = `${currentWidth}px`;
                }
            }

            function onMouseUp() {
                vResizer.classList.remove("resizing");
                document.body.classList.remove("is-resizing");
                localStorage.setItem(
                    "strobe_inspector_width",
                    inspectorPanel.style.width,
                );
                window.removeEventListener("mousemove", onMouseMove);
                window.removeEventListener("mouseup", onMouseUp);
            }

            window.addEventListener("mousemove", onMouseMove);
            window.addEventListener("mouseup", onMouseUp);
        });
    }
}

const ESP_IP = "192.168.4.1";
let socket;

function initWebSocket() {
    console.log("[WS] Attempting connection to ws://" + ESP_IP + ":81 ...");
    socket = new WebSocket(`ws://${ESP_IP}:81`);

    socket.onopen = () => {
        console.log(
            "[WS] SUCCESS: Connected and synced with ESP32 Strobe Engine!",
        );
        showToast("Connected & Synced with ESP32");
    };

    socket.onclose = (event) => {
        console.warn(
            `[WS] DISCONNECTED: Code ${event.code}, Reason: ${event.reason || "None"}`,
        );
        // Auto-retry connection every 3 seconds
        setTimeout(initWebSocket, 3000);
    };

    socket.onerror = (error) => {
        console.error("[WS] ERROR DETECTED:", error);
    };

    socket.onmessage = (e) => {
        // Logs anything the ESP32 sends BACK to your laptop
        console.log("[WS] RECEIVED FROM ESP32 ->", e.data);
    };
}

// INJECT THIS IN YOUR PLAYER LOOP:
// Ensure that your HTML editor's timeline system calls this function
// every single time a new frame or step plays!
function broadcastLiveState(stateArray) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const payload = JSON.stringify({ live: stateArray });

        // This will print the exact JSON layout leaving your laptop
        console.log("[WS] SENT TO ESP32 ->", payload);

        socket.send(payload);
    } else {
        console.warn(
            "[WS] CANNOT SEND: Socket is not open. Current state:",
            socket ? socket.readyState : "Null",
        );
    }
}

// Call initialization on window load
window.addEventListener("load", () => {
    initWebSocket();
});

// WIRELESS OVER-THE-AIR CONFIGURATION UPLOAD
function uploadConfigToESP32() {
    // 1. Safety Check: Verify that we actually have a working WebSocket connection first
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showToast("Upload Failed: Connect to 'Strobe-Editor' hotspot first!");
        return;
    }

    showToast("Transmitting configuration to MicroSD card...");

    // 2. Perform an HTTP POST request sending the raw editor 'config' object
    fetch(`http://${ESP_IP}/upload`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify(config), // Grab the active workspace layout state
    })
        .then(async (response) => {
            if (response.ok) {
                showToast("Success! Configuration locked to MicroSD memory.");
            } else {
                const errorMsg = await response.text();
                showToast("Upload rejected: " + errorMsg);
            }
        })
        .catch((err) => {
            console.error("Upload network exception:", err);
            showToast("Network Error: Connection timed out or dropped.");
        });
}
