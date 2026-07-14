const API_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') 
    ? '' 
    : 'http://127.0.0.1:8765';

let allGames = [];
let currentGame = null;
let isTranslated = false;
let originalMetadata = null;
let lastGridScrollPos = 0;
let appSettings = null;
let activeSettingsJobKey = null;
let activeScanJobKey = null;
let activeScanModeKey = null;
let currentSmartScanResult = null;
let lastSettingsMetadataQueueRefreshAt = 0;
let currentExtensionBrowser = 'chrome';
const MISSING_SOURCE_SCAN_JOB_KEY = 'missing-source-scan';
const AVAILABLE_THEME_MODES = ['midnight', 'graphite', 'obsidian'];
const AVAILABLE_ACCENT_COLORS = ['blue', 'rose', 'teal', 'amber', 'emerald'];
const EXTENSION_BROWSER_PRESETS = {
    chrome: {
        label: 'Chrome',
        badge: 'Chrome extension',
        title: 'Load the unpacked Chrome extension',
        copy: 'Use Chrome\'s extensions page, enable Developer mode, then load the bundled XDir extension folder.',
        steps: [
            'Open chrome://extensions.',
            'Enable Developer mode.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    edge: {
        label: 'Edge',
        badge: 'Edge extension',
        title: 'Load the unpacked Edge extension',
        copy: 'Edge uses the same Chromium extension flow as Chrome, including the same bundled extension directory.',
        steps: [
            'Open edge://extensions.',
            'Enable Developer mode in the left sidebar.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    opera: {
        label: 'Opera',
        badge: 'Opera extension',
        title: 'Load the unpacked Opera extension',
        copy: 'Opera can load the same unpacked source tree after developer mode is enabled on the extensions page.',
        steps: [
            'Open opera://extensions.',
            'Enable Developer mode.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    brave: {
        label: 'Brave',
        badge: 'Brave extension',
        title: 'Load the unpacked Brave extension',
        copy: 'Brave follows the Chromium install flow, so the same bundled extension folder works directly.',
        steps: [
            'Open brave://extensions.',
            'Enable Developer mode.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    vivaldi: {
        label: 'Vivaldi',
        badge: 'Vivaldi extension',
        title: 'Load the unpacked Vivaldi extension',
        copy: 'Vivaldi exposes the same unpacked extension flow used by other Chromium-based browsers.',
        steps: [
            'Open vivaldi://extensions.',
            'Enable Developer mode.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    chromium: {
        label: 'Chromium',
        badge: 'Chromium extension',
        title: 'Load the unpacked Chromium extension',
        copy: 'Chromium accepts the exact same extension source tree that ships with XDir.',
        steps: [
            'Open chrome://extensions in Chromium.',
            'Enable Developer mode.',
            'Click Load unpacked and choose the folder above.',
        ],
    },
    firefox: {
        label: 'Firefox',
        badge: 'Firefox temporary add-on',
        title: 'Temporarily load the Firefox build for local testing',
        copy: 'Firefox can temporarily load the same source folder for a session, but the Chromium browsers remain the primary supported sync target.',
        steps: [
            'Open about:debugging#/runtime/this-firefox.',
            'Click Load Temporary Add-on.',
            'Select the manifest.json file inside the folder above.',
        ],
    },
};
const SCAN_JOB_DEFINITIONS = {
    [MISSING_SOURCE_SCAN_JOB_KEY]: {
        jobKey: MISSING_SOURCE_SCAN_JOB_KEY,
        startUrl: `${API_BASE}/api/library/missing-source-scan`,
        toolbarLabel: 'Missing source scan running',
        resultsTitle: 'Missing Source Scan',
        resultsCopy: 'Track missing primary source matches and review anything that still needs attention.',
        reviewTitle: 'Review Missing Sources',
        reviewCopy: 'Apply the best source candidate when it looks correct, or skip it and resolve the game later.',
        eyebrow: 'Missing Source Scan',
        cancelledEyebrow: 'Missing Source Scan Cancelled',
    },
};
const SETTINGS_JOB_DEFINITIONS = {
    'fix-metadata': {
        buttonId: 'btn-fix-metadata',
        startUrl: `${API_BASE}/api/library/fix-metadata`,
        initialMessage: 'Fixing titles, covers, and screenshots across your library...',
        genericFailureMessage: 'Failed to fix titles and refetch metadata',
        idleHtml: `<i data-lucide="wand-2"></i> <span>Fix Titles & Refetch All Metadata</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Fixing Titles & Refetching Metadata (Please wait)...</span>`,
    },
    'rematch-f95zone': {
        buttonId: 'btn-rematch-f95',
        startUrl: `${API_BASE}/api/library/rematch-f95zone`,
        initialMessage: 'Rematching unidentified games against F95Zone and refreshing matches...',
        genericFailureMessage: 'Failed to rematch F95Zone titles',
        idleHtml: `<i data-lucide="search"></i> <span>Rematch Unidentified Games from F95Zone</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Rematching and Scraping from F95Zone (Please wait)...</span>`,
    },
    'flush-metadata': {
        buttonId: 'btn-flush-metadata',
        startUrl: `${API_BASE}/api/library/flush-metadata`,
        initialMessage: 'Removing scraped metadata while keeping local records and source links intact...',
        genericFailureMessage: 'Failed to flush scraped metadata',
        idleHtml: `<i data-lucide="trash-2"></i> <span>Flush All Scraped Metadata</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Flushing Scraped Metadata (Please wait)...</span>`,
        requestInit: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation_phrase: 'FLUSH' }),
        },
    },
    'export-library': {
        buttonId: 'btn-settings-export-library',
        startUrl: `${API_BASE}/api/library/export`,
        initialMessage: 'Packaging your primary library directory, source links, and saved library state...',
        genericFailureMessage: 'Failed to export the portable library package',
        idleHtml: `<i data-lucide="download"></i> <span>Export Full Library Package</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Exporting Library Package (Please wait)...</span>`,
    },
    'import-library': {
        buttonId: 'btn-settings-import-library',
        startUrl: `${API_BASE}/api/library/import`,
        initialMessage: 'Importing the portable library package into your primary library directory and restoring source-linked metadata...',
        genericFailureMessage: 'Failed to import the portable library package',
        idleHtml: `<i data-lucide="upload"></i> <span>Import Library Package</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Importing Library Package (Please wait)...</span>`,
    },
    'update-check': {
        buttonId: 'btn-settings-check-updates',
        startUrl: `${API_BASE}/api/library/check-updates`,
        initialMessage: 'Checking linked games for newer versions...',
        genericFailureMessage: 'Failed to check the library for updates',
        idleHtml: `<i data-lucide="search-check"></i> <span>Check Entire Library for Updates</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Checking Library for Updates...</span>`,
    },
};
const SETTINGS_JOB_KEYS = Object.keys(SETTINGS_JOB_DEFINITIONS);

function renderTranslateButtonLabel(mode = 'translate') {
    const label = mode === 'revert' ? 'Revert' : 'Translate';
    return `<i data-lucide="languages" style="width:14px;height:14px;"></i><span>${label}</span>`;
}

function normalizeRatingText(value) {
    if (!value) return 'N/A';
    return String(value)
        .replace(/(\d+(?:\.\d+)?)\s*[^\w\s\/().,-]{1,6}\s*\(([^)]+)\)/g, '$1 / 5 ($2)')
        .replace(/(\d+(?:\.\d+)?)\s*[^\w\s\/().,-]{1,6}$/g, '$1 / 5');
}

function getPreferredSourcePlatform() {
    const selectedValue = document.getElementById('set-preferred-source')?.value;
    const preferred = String(selectedValue || appSettings?.preferred_source || 'f95zone').toLowerCase();
    return ['f95zone', 'dlsite', 'itch', 'steam', 'all'].includes(preferred) ? preferred : 'f95zone';
}

function formatSourceLabel(source) {
    const key = String(source || '').toLowerCase();
    if (key === 'f95zone') return 'F95Zone';
    if (key === 'dlsite') return 'DLsite';
    if (key === 'itch') return 'Itch.io';
    if (key === 'steam') return 'Steam';
    if (key === 'all') return 'All Sources';
    return key ? key.toUpperCase() : 'Unknown';
}

function getPreferredSourceSummary(source) {
    const key = String(source || '').toLowerCase();
    if (key === 'dlsite') {
        return 'will be searched first when Find Missing Sources needs a starting provider.';
    }
    if (key === 'itch') {
        return 'will open first for indie-heavy search flows and be queried before the other automatic metadata providers.';
    }
    return 'will be queried first by Find Missing Sources and opened first in search modals that resolve uncertain matches.';
}

function sanitizeThemeMode(value) {
    const theme = String(value || '').toLowerCase();
    return AVAILABLE_THEME_MODES.includes(theme) ? theme : 'midnight';
}

function sanitizeAccentColor(value) {
    const accent = String(value || '').toLowerCase();
    return AVAILABLE_ACCENT_COLORS.includes(accent) ? accent : 'blue';
}

function applyAppearanceSettings(themeMode, accentColor) {
    const theme = sanitizeThemeMode(themeMode || appSettings?.theme_mode || 'midnight');
    const accent = sanitizeAccentColor(accentColor || appSettings?.accent_color || 'blue');
    document.body.dataset.theme = theme;
    document.body.dataset.accent = accent;
    try {
        localStorage.setItem('xdir_theme_mode', theme);
        localStorage.setItem('xdir_accent_color', accent);
    } catch (_) {
        // Ignore storage failures in restricted environments.
    }
}

function getExtensionPath() {
    const configured = String(appSettings?.extension_dir || '').trim();
    if (configured) return configured;
    return String(document.getElementById('ext-path-box')?.textContent || '').trim();
}

async function copyTextToClipboard(text) {
    const value = String(text || '').trim();
    if (!value) return false;

    try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(value);
            return true;
        }
    } catch (_) {
        // Fall through to the textarea fallback below.
    }

    const helper = document.createElement('textarea');
    helper.value = value;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    helper.style.pointerEvents = 'none';
    document.body.appendChild(helper);
    helper.select();
    helper.setSelectionRange(0, helper.value.length);

    let copied = false;
    try {
        copied = document.execCommand('copy');
    } catch (_) {
        copied = false;
    } finally {
        helper.remove();
    }

    return copied;
}

async function openDesktopPath(path, { select = false } = {}) {
    const normalized = String(path || '').trim();
    if (!normalized) return false;

    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_path) {
        return !!(await window.pywebview.api.open_path(normalized, select));
    }

    return false;
}

async function openExtensionFolder() {
    const extensionPath = getExtensionPath();
    if (!extensionPath) {
        alert('Extension path is not available yet.');
        return;
    }

    const opened = await openDesktopPath(extensionPath);
    if (!opened) {
        alert(`Unable to open the extension folder automatically.\n\n${extensionPath}`);
    }
}

async function copyExtensionPath(triggerButton = null) {
    const extensionPath = getExtensionPath();
    if (!extensionPath) {
        alert('Extension path is not available yet.');
        return;
    }

    const copied = await copyTextToClipboard(extensionPath);
    if (!copied) {
        alert(`Unable to copy the extension path automatically.\n\n${extensionPath}`);
        return;
    }

    if (triggerButton) {
        const originalHtml = triggerButton.innerHTML;
        triggerButton.innerHTML = `<i data-lucide="check"></i> <span>Copied</span>`;
        if (window.lucide) lucide.createIcons();
        window.setTimeout(() => {
            triggerButton.innerHTML = originalHtml;
            if (window.lucide) lucide.createIcons();
        }, 1400);
    }
}

function renderExtensionBrowserGuide(browserKey = currentExtensionBrowser) {
    const resolvedKey = Object.prototype.hasOwnProperty.call(EXTENSION_BROWSER_PRESETS, browserKey)
        ? browserKey
        : 'chrome';
    const preset = EXTENSION_BROWSER_PRESETS[resolvedKey];
    currentExtensionBrowser = resolvedKey;

    document.querySelectorAll('.extension-browser-chip').forEach((button) => {
        button.classList.toggle('active', button.dataset.browser === resolvedKey);
    });

    const browserLabel = document.getElementById('extension-browser-label');
    if (browserLabel) browserLabel.textContent = preset.label;

    const badge = document.getElementById('extension-install-badge');
    if (badge) badge.textContent = preset.badge;

    const title = document.getElementById('extension-install-title');
    if (title) title.textContent = preset.title;

    const copy = document.getElementById('extension-install-copy');
    if (copy) copy.textContent = preset.copy;

    const steps = document.getElementById('extension-install-steps');
    if (steps) {
        steps.innerHTML = preset.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('');
    }
}

function formatExtensionHeartbeat(lastSeenSeconds) {
    if (lastSeenSeconds == null || Number.isNaN(Number(lastSeenSeconds))) return 'Waiting';
    const seconds = Math.max(0, Number(lastSeenSeconds));
    if (seconds < 5) return 'Just now';
    if (seconds < 60) return `${Math.round(seconds)}s ago`;
    const minutes = Math.round(seconds / 60);
    return `${minutes}m ago`;
}

function renderSettingsPreferredSource(source) {
    const label = formatSourceLabel(source || appSettings?.preferred_source || 'f95zone');
    const summary = getPreferredSourceSummary(source || appSettings?.preferred_source || 'f95zone');

    const heroLabel = document.getElementById('settings-kpi-source');
    if (heroLabel) heroLabel.textContent = label;

    const heroDetail = document.getElementById('settings-kpi-source-detail');
    if (heroDetail) heroDetail.textContent = `${label} is used first for missing-source discovery and search defaults.`;

    const badge = document.getElementById('settings-source-active-badge');
    if (badge) badge.textContent = label;

    const summaryEl = document.getElementById('settings-source-summary');
    if (summaryEl) summaryEl.textContent = summary;
}

function renderSettingsSummary(stats) {
    const total = Number(stats?.total || 0);
    const installed = Number(stats?.installed || 0);
    const archives = Number(stats?.archives || 0);
    const wishlist = Number(stats?.wishlist || 0);
    const unidentified = Number(stats?.unidentified || 0);

    const heroTotal = document.getElementById('settings-kpi-library-total');
    if (heroTotal) heroTotal.textContent = String(total);

    const heroDetail = document.getElementById('settings-kpi-library-detail');
    if (heroDetail) heroDetail.textContent = `Installed ${installed}, archives ${archives}, wishlist ${wishlist}`;

    const unresolvedCount = document.getElementById('settings-kpi-unresolved-count');
    if (unresolvedCount) unresolvedCount.textContent = String(unidentified);

    const unresolvedDetail = document.getElementById('settings-kpi-unresolved-detail');
    if (unresolvedDetail) {
        unresolvedDetail.textContent = unidentified === 1
            ? '1 local entry still needs a confident identification or source match.'
            : `${unidentified} local entries still need a confident identification or source match.`;
    }

    const libraryCount = document.getElementById('settings-library-count');
    if (libraryCount) libraryCount.textContent = String(total);

    const installedCount = document.getElementById('settings-installed-count');
    if (installedCount) installedCount.textContent = String(installed);

    const archivesCount = document.getElementById('settings-archives-count');
    if (archivesCount) archivesCount.textContent = String(archives);

    const wishlistCount = document.getElementById('settings-wishlist-count');
    if (wishlistCount) wishlistCount.textContent = String(wishlist);

    renderSettingsPreferredSource(appSettings?.preferred_source || 'f95zone');
}

function renderSettingsExtensionStatus(status) {
    const connected = !!(status?.connected || status?.status === 'connected');
    const version = status?.version ? ` v${status.version}` : '';
    const statusText = connected ? `Connected${version}` : 'Offline';
    const detailText = connected
        ? 'Chrome companion heartbeat is active and background queue work can be monitored.'
        : 'No heartbeat detected from Chrome. Load the unpacked extension and keep the browser running.';

    const pill = document.getElementById('settings-extension-status');
    if (pill) {
        pill.textContent = statusText;
        pill.classList.toggle('connected', connected);
        pill.classList.toggle('offline', !connected);
    }

    const detail = document.getElementById('settings-extension-detail');
    if (detail) detail.textContent = detailText;

    const heroStatus = document.getElementById('settings-kpi-companion');
    if (heroStatus) heroStatus.textContent = statusText;

    const heroDetail = document.getElementById('settings-kpi-companion-detail');
    if (heroDetail) heroDetail.textContent = connected ? 'Companion is online and ready for queue work.' : 'Waiting for the Chrome companion heartbeat.';
}

async function refreshSettingsMetadataQueue({ force = false } = {}) {
    const list = document.getElementById('settings-metadata-queue-list');
    const count = document.getElementById('settings-metadata-queue-count');
    const detail = document.getElementById('settings-metadata-queue-detail');
    if (!list && !count && !detail) return;

    const now = Date.now();
    if (!force && now - lastSettingsMetadataQueueRefreshAt < 10000) return;
    lastSettingsMetadataQueueRefreshAt = now;

    try {
        const res = await fetch(`${API_BASE}/api/games/needs-metadata`);
        if (!res.ok) throw new Error('Failed to load metadata queue');

        const games = await res.json();
        const queueCount = Array.isArray(games) ? games.length : 0;

        if (count) count.textContent = String(queueCount);
        if (detail) {
            detail.textContent = queueCount === 0
                ? 'All identified games currently have covers and screenshots.'
                : `${queueCount} identified game${queueCount === 1 ? '' : 's'} still need cover art or screenshots.`;
        }

        if (!list) return;
        if (!queueCount) {
            list.innerHTML = '<div class="settings-queue-empty">All identified games currently have their metadata queue cleared.</div>';
            return;
        }

        list.innerHTML = games.slice(0, 5).map((game) => {
            const sourceLabel = formatSourceLabel(game.source_type || 'unknown');
            const localPath = game.folder_path || 'No local path recorded';
            return `
                <div class="settings-queue-item">
                    <strong>${game.title || game.raw_name || 'Unknown title'}</strong>
                    <span>${sourceLabel} · ${localPath}</span>
                </div>
            `;
        }).join('');
    } catch (error) {
        if (detail) detail.textContent = 'Unable to load the current queue snapshot.';
        if (list) list.innerHTML = '<div class="settings-queue-empty">Metadata queue is unavailable right now.</div>';
    }
}

function showSettingsJobProgress(message) {
    const shell = document.getElementById('settings-job-progress');
    const label = document.getElementById('settings-job-progress-label');
    const fill = document.getElementById('settings-job-progress-fill');
    const count = document.getElementById('settings-job-progress-count');
    const percent = document.getElementById('settings-job-progress-percent');
    const current = document.getElementById('settings-job-progress-current');
    if (!shell || !label || !fill || !count || !percent || !current) return;

    label.textContent = message;
    count.textContent = '0 / 0';
    percent.textContent = '0%';
    current.textContent = 'Waiting for the backend to begin...';
    shell.hidden = false;
    fill.style.width = '0%';
}

function hideSettingsJobProgress() {
    const shell = document.getElementById('settings-job-progress');
    const fill = document.getElementById('settings-job-progress-fill');
    if (!shell || !fill) return;

    shell.hidden = true;
    fill.style.width = '0%';
}

async function readJsonResponse(res) {
    const text = await res.text();
    if (!text) return {};
    try {
        return JSON.parse(text);
    } catch (error) {
        return { detail: text };
    }
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function escapeHtml(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sameDirectoryPath(left, right) {
    const normalize = (value) => String(value || '')
        .trim()
        .replace(/[\\/]+$/, '')
        .toLowerCase();
    return normalize(left) && normalize(left) === normalize(right);
}

function normalizeGamesDirList(rawDirs) {
    const normalized = [];
    const seen = new Set();
    const candidates = Array.isArray(rawDirs) ? rawDirs : [rawDirs];

    candidates.forEach((candidate) => {
        const clean = String(candidate || '').trim();
        if (!clean) return;
        const key = clean.replace(/[\\/]+$/, '').toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        normalized.push(clean);
    });

    return normalized;
}

function getConfiguredGamesDirs(settings = appSettings) {
    const directList = normalizeGamesDirList(settings?.games_dirs || []);
    if (directList.length) return directList;

    const primaryDir = String(settings?.games_dir || settings?.primary_games_dir || '').trim();
    return primaryDir ? [primaryDir] : [];
}

function getPrimaryGamesDir(settings = appSettings) {
    return getConfiguredGamesDirs(settings)[0] || '';
}

async function pickLibraryDirectory(initialDir = '') {
    try {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.browse_folder) {
            return await window.pywebview.api.browse_folder(initialDir || getPrimaryGamesDir() || '');
        }
    } catch (error) {
        alert(`Failed to open the folder picker: ${error.message}`);
        return null;
    }

    const manualPath = prompt('Enter the folder path that XDir should scan:', initialDir || getPrimaryGamesDir() || '');
    return manualPath ? manualPath.trim() : null;
}

function openLibraryDirectoryModal() {
    const modal = document.getElementById('library-directory-modal');
    const backdrop = document.getElementById('library-directory-backdrop');
    if (!modal || !backdrop) return;

    renderLibraryDirectories();
    backdrop.style.display = 'block';
    modal.style.display = 'flex';
    if (window.lucide) lucide.createIcons();
}

function closeLibraryDirectoryModal() {
    const modal = document.getElementById('library-directory-modal');
    const backdrop = document.getElementById('library-directory-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
}

function renderLibraryDirectories() {
    const listEl = document.getElementById('library-directory-list');
    const emptyEl = document.getElementById('library-directory-empty');
    const summaryEl = document.getElementById('sidebar-library-directory-summary');

    const configuredDirs = getConfiguredGamesDirs();
    const primaryDir = configuredDirs[0] || '';
    const extraCount = Math.max(0, configuredDirs.length - 1);

    if (summaryEl) {
        summaryEl.textContent = primaryDir
            ? (extraCount > 0 ? `${primaryDir} (+${extraCount} more)` : primaryDir)
            : 'No library folder configured yet.';
    }

    if (!listEl) return;

    listEl.innerHTML = configuredDirs.map((dir, index) => {
        const isPrimary = index === 0;
        const removeDisabled = configuredDirs.length <= 1 ? 'disabled' : '';
        return `
            <article class="library-directory-card ${isPrimary ? 'is-primary' : ''}">
                <div class="library-directory-card-head">
                    <div class="library-directory-badges">
                        <span class="library-directory-badge ${isPrimary ? 'primary' : ''}">
                            ${isPrimary ? 'Primary' : 'Scan Root'}
                        </span>
                        <span class="library-directory-subcopy">${isPrimary ? 'Used for portable export/import' : 'Scanned alongside the primary root'}</span>
                    </div>
                </div>
                <div class="library-directory-path">${escapeHtml(dir)}</div>
                <div class="library-directory-actions">
                    ${isPrimary ? '' : `
                        <button type="button" class="btn-primary" data-library-dir-action="set-primary" data-index="${index}">
                            <i data-lucide="arrow-up-right"></i>
                            <span>Make Primary</span>
                        </button>
                    `}
                    <button type="button" class="btn-secondary" data-library-dir-action="remove-directory" data-index="${index}" ${removeDisabled}>
                        <i data-lucide="trash-2"></i>
                        <span>Remove</span>
                    </button>
                </div>
            </article>
        `;
    }).join('');

    listEl.querySelectorAll('[data-library-dir-action="set-primary"]').forEach((button) => {
        button.addEventListener('click', async () => {
            await setPrimaryLibraryDirectory(Number(button.dataset.index));
        });
    });

    listEl.querySelectorAll('[data-library-dir-action="remove-directory"]').forEach((button) => {
        button.addEventListener('click', async () => {
            await removeLibraryDirectory(Number(button.dataset.index));
        });
    });

    if (emptyEl) emptyEl.style.display = configuredDirs.length ? 'none' : 'block';
    if (window.lucide) lucide.createIcons();
}

async function saveLibraryDirectories(nextDirs, { triggerScan = false } = {}) {
    const normalizedDirs = normalizeGamesDirList(nextDirs);
    if (!normalizedDirs.length) {
        alert('Keep at least one library directory configured before saving.');
        return false;
    }

    const managedButtons = Array.from(document.querySelectorAll('[data-library-dir-action], #btn-open-library-directory-modal, #btn-close-library-directory-modal, #btn-library-add-directory'));
    const previousDisabled = managedButtons.map((button) => button.disabled);
    managedButtons.forEach((button) => {
        button.disabled = true;
    });

    try {
        const res = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ games_dirs: normalizedDirs }),
        });
        const data = await readJsonResponse(res);
        if (!res.ok) {
            throw new Error(data.detail || 'Failed to save library directories');
        }

        const updatedSettings = {
            ...(data.settings || {}),
            games_dirs: normalizeGamesDirList(data.settings?.games_dirs || normalizedDirs),
        };
        updatedSettings.games_dir = updatedSettings.games_dirs[0] || '';
        updatedSettings.primary_games_dir = updatedSettings.games_dir;
        appSettings = updatedSettings;
        renderLibraryDirectories();

        if (triggerScan) {
            await triggerRescan(document.getElementById('btn-add-game'));
        } else {
            await Promise.allSettled([fetchStats(), loadGames()]);
        }

        return true;
    } catch (error) {
        alert(`Failed to save library directories: ${error.message}`);
        return false;
    } finally {
        managedButtons.forEach((button, index) => {
            if (button && button.isConnected) {
                button.disabled = previousDisabled[index];
            }
        });
    }
}

async function addLibraryDirectory() {
    const currentDirs = getConfiguredGamesDirs();
    const chosenDir = await pickLibraryDirectory(getPrimaryGamesDir() || '');
    if (!chosenDir) return;

    if (currentDirs.some((dir) => sameDirectoryPath(dir, chosenDir))) {
        alert('That folder is already part of your XDir library roots.');
        return;
    }

    let nextDirs = [...currentDirs, chosenDir];
    if (!currentDirs.length || confirm(`Make this the primary library directory used for portable export and import?\n\n${chosenDir}`)) {
        nextDirs = [chosenDir, ...currentDirs];
    }

    await saveLibraryDirectories(nextDirs, { triggerScan: true });
}

async function setPrimaryLibraryDirectory(index) {
    const currentDirs = getConfiguredGamesDirs();
    if (!Number.isInteger(index) || index < 0 || index >= currentDirs.length || index === 0) return;

    const nextPrimary = currentDirs[index];
    const remainingDirs = currentDirs.filter((_, currentIndex) => currentIndex !== index);
    await saveLibraryDirectories([nextPrimary, ...remainingDirs], { triggerScan: true });
}

async function removeLibraryDirectory(index) {
    const currentDirs = getConfiguredGamesDirs();
    if (!Number.isInteger(index) || index < 0 || index >= currentDirs.length) return;
    if (currentDirs.length <= 1) {
        alert('Keep at least one library directory configured. Add a replacement first, then remove the old one.');
        return;
    }

    const dirToRemove = currentDirs[index];
    const confirmed = confirm(`Remove this library directory from XDir?\n\n${dirToRemove}\n\nGames from this root will disappear from the library after the next scan.`);
    if (!confirmed) return;

    const nextDirs = currentDirs.filter((_, currentIndex) => currentIndex !== index);
    await saveLibraryDirectories(nextDirs, { triggerScan: true });
}

function getScanJobDefinition(scanKey = null) {
    const key = scanKey || activeScanModeKey || activeScanJobKey || MISSING_SOURCE_SCAN_JOB_KEY;
    return SCAN_JOB_DEFINITIONS[key] || SCAN_JOB_DEFINITIONS[MISSING_SOURCE_SCAN_JOB_KEY];
}

function setMetadataActionBusyState(isBusy, activeButtonId = null) {
    SETTINGS_JOB_KEYS.forEach((jobKey) => {
        const definition = SETTINGS_JOB_DEFINITIONS[jobKey];
        const button = document.getElementById(definition.buttonId);
        if (!button) return;
        button.disabled = isBusy;
        button.innerHTML = activeButtonId === definition.buttonId ? definition.loadingHtml : definition.idleHtml;
    });

    if (window.lucide) lucide.createIcons();
}

function renderSettingsJobProgress(state) {
    const label = document.getElementById('settings-job-progress-label');
    const fill = document.getElementById('settings-job-progress-fill');
    const count = document.getElementById('settings-job-progress-count');
    const percent = document.getElementById('settings-job-progress-percent');
    const current = document.getElementById('settings-job-progress-current');
    const cancelButton = document.getElementById('btn-settings-cancel-job');
    if (!label || !fill || !count || !percent || !current || !state) return;

    const total = Number(state.total || 0);
    const completed = Number(state.completed || 0);
    const safePercent = Math.max(0, Math.min(100, Number(state.percent || 0)));

    label.textContent = state.label || 'Working through your library...';
    count.textContent = `${completed} / ${total}`;
    percent.textContent = `${safePercent}%`;
    current.textContent = state.current_title
        ? `${state.detail || 'Processing...'} ${state.current_title}`
        : (state.detail || 'Preparing library job...');
    fill.style.width = `${safePercent}%`;
    if (cancelButton) cancelButton.hidden = state.job_key !== 'update-check';
    if (state.job_key === 'update-check') renderSettingsUpdateCheckSummary(appSettings, state);
}

async function getSettingsJobState(jobKey) {
    const res = await fetch(`${API_BASE}/api/library/jobs/${jobKey}`);
    const state = await readJsonResponse(res);
    if (!res.ok) {
        throw new Error(state.detail || `Failed to read ${jobKey} job progress`);
    }
    return state;
}

async function pollSettingsJobProgress(jobKey) {
    let pollFailures = 0;
    while (activeSettingsJobKey === jobKey) {
        try {
            const state = await getSettingsJobState(jobKey);
            pollFailures = 0;
            renderSettingsJobProgress(state);

            if (state.status === 'completed') {
                await Promise.allSettled([fetchStats(), loadGames(), fetchTags(), loadSettings()]);
                if (jobKey === 'update-check') renderSettingsUpdateCheckSummary(appSettings, state);
                alert(state.summary || 'Library job completed.');
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                return;
            }

            if (state.status === 'failed') {
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                throw new Error(state.error || 'Library job failed');
            }

            if (state.status === 'cancelled') {
                if (jobKey === 'update-check') renderSettingsUpdateCheckSummary(appSettings, state);
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                return;
            }
        } catch (err) {
            pollFailures += 1;
            if (pollFailures >= 5) {
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                throw err;
            }
            await wait(600 * pollFailures);
            continue;
        }

        await wait(350);
    }
}

async function resumeActiveSettingsJob(preferredJobKey = null, options = {}) {
    const { showAlertOnFailure = false } = options;
    const orderedJobKeys = preferredJobKey
        ? [preferredJobKey, ...SETTINGS_JOB_KEYS.filter(jobKey => jobKey !== preferredJobKey)]
        : SETTINGS_JOB_KEYS;

    for (const jobKey of orderedJobKeys) {
        try {
            const state = await getSettingsJobState(jobKey);
            if (state.status !== 'running') continue;

            const definition = SETTINGS_JOB_DEFINITIONS[jobKey];
            activeSettingsJobKey = jobKey;
            showSettingsJobProgress(state.label || definition.initialMessage);
            renderSettingsJobProgress(state);
            setMetadataActionBusyState(true, definition.buttonId);

            try {
                await pollSettingsJobProgress(jobKey);
            } finally {
                setMetadataActionBusyState(false);
            }

            return true;
        } catch (err) {
            if (showAlertOnFailure) {
                const definition = SETTINGS_JOB_DEFINITIONS[jobKey];
                alert(`${definition.genericFailureMessage}: ${err.message}`);
            }
            break;
        }
    }

    return false;
}

function confirmFlushAllMetadata() {
    const firstConfirmed = confirm('This will remove scraped covers, screenshots, descriptions, ratings, versions, and scraped tags from every game in your library. Local files, source links, custom tags, and notes will be kept. Continue?');
    if (!firstConfirmed) return false;

    const phrase = prompt('Type FLUSH to permanently remove scraped metadata from every game.', '');
    if (phrase === null) return false;
    if (phrase.trim().toUpperCase() !== 'FLUSH') {
        alert('Flush cancelled. Confirmation phrase did not match.');
        return false;
    }

    return true;
}

async function pickLibraryExportPath() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_library_export_file) {
        alert('Portable library export is only available in the desktop app build.');
        return null;
    }

    try {
        return await window.pywebview.api.save_library_export_file(getPrimaryGamesDir() || '');
    } catch (error) {
        alert(`Failed to open the export save dialog: ${error.message}`);
        return null;
    }
}

async function pickLibraryImportPath() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.browse_library_import_file) {
        alert('Portable library import is only available in the desktop app build.');
        return null;
    }

    try {
        return await window.pywebview.api.browse_library_import_file(getPrimaryGamesDir() || '');
    } catch (error) {
        alert(`Failed to open the import package picker: ${error.message}`);
        return null;
    }
}

async function startPortableLibraryExport() {
    const primaryDir = getPrimaryGamesDir();
    if (!primaryDir) {
        alert('Configure a primary library directory from the Library tab before exporting a library package.');
        return;
    }

    const exportPath = await pickLibraryExportPath();
    if (!exportPath) return;

    await startSettingsTrackedJob('export-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ export_path: exportPath }),
    });
}

async function startPortableLibraryImport() {
    const importPath = await pickLibraryImportPath();
    if (!importPath) return;

    const gamesDir = getPrimaryGamesDir();
    if (!gamesDir) {
        alert('Configure a primary library directory from the Library tab before importing a library package.');
        return;
    }

    const confirmed = confirm(`Import will restore files into your primary library directory:\n\n${gamesDir}\n\nContinue?`);
    if (!confirmed) return;

    await startSettingsTrackedJob('import-library', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ import_path: importPath }),
    });
}

async function startSettingsTrackedJob(jobKey, requestInit = null) {
    const definition = SETTINGS_JOB_DEFINITIONS[jobKey];
    if (!definition) return;

    if (activeSettingsJobKey === jobKey) return;
    if (activeSettingsJobKey && activeSettingsJobKey !== jobKey) {
        alert('Another library metadata job is already running. Please wait for it to finish.');
        return;
    }

    activeSettingsJobKey = jobKey;
    showSettingsJobProgress(definition.initialMessage);
    setMetadataActionBusyState(true, definition.buttonId);
    try {
        const res = await fetch(definition.startUrl, requestInit || definition.requestInit || { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) {
            if (res.status === 409) {
                const resumed = await resumeActiveSettingsJob(jobKey, { showAlertOnFailure: true });
                if (resumed) return;
            }
            throw new Error(data.detail || definition.genericFailureMessage);
        }
        renderSettingsJobProgress(data);
        await pollSettingsJobProgress(jobKey);
    } catch (err) {
        hideSettingsJobProgress();
        activeSettingsJobKey = null;
        alert(`${definition.genericFailureMessage}: ${err.message}`);
    } finally {
        setMetadataActionBusyState(false);
    }
}

async function getLibraryJobState(jobKey) {
    const res = await fetch(`${API_BASE}/api/library/jobs/${jobKey}`);
    const state = await readJsonResponse(res);
    if (!res.ok) {
        throw new Error(state.detail || `Failed to read ${jobKey} job status`);
    }
    return state;
}

async function openExternalUrl(url) {
    if (!url) return;
    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_external_url) {
        const opened = await window.pywebview.api.open_external_url(url);
        if (opened) return;
    }
    window.open(url, '_blank');
}

function buildSourceBrowserSearchUrl(query, platform = 'all') {
    const trimmedQuery = (query || '').trim();
    if (!trimmedQuery) return '';

    const encodedQuery = encodeURIComponent(trimmedQuery);
    if (platform === 'dlsite') return `https://www.google.com/search?q=site:dlsite.com+${encodedQuery}`;
    if (platform === 'itch') return `https://www.google.com/search?q=site:itch.io+${encodedQuery}`;
    if (platform === 'f95zone') return `https://www.google.com/search?q=site:f95zone.to+${encodedQuery}`;
    if (platform === 'steam') return `https://www.google.com/search?q=site:store.steampowered.com+${encodedQuery}`;
    return `https://www.google.com/search?q=${encodedQuery}`;
}

function setScanWorkflowView(viewId) {
    ['scan-workflow-choice-view'].forEach((id) => {
        const view = document.getElementById(id);
        if (view) {
            view.hidden = id !== viewId;
        }
    });
}

function setScanResultsView(viewId) {
    ['scan-results-progress-view', 'scan-results-summary-view', 'scan-results-review-view'].forEach((id) => {
        const view = document.getElementById(id);
        if (view) {
            view.hidden = id !== viewId;
        }
    });
}

function showScanWorkflowModal() {
    const modal = document.getElementById('scan-workflow-modal');
    const backdrop = document.getElementById('scan-workflow-backdrop');
    if (modal) modal.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';
}

function closeScanWorkflowModal(force = false) {
    if (!force && activeScanJobKey) return;
    const modal = document.getElementById('scan-workflow-modal');
    const backdrop = document.getElementById('scan-workflow-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    if (!activeScanJobKey) {
        setScanWorkflowView('scan-workflow-choice-view');
    }
}

function showScanResultsModal() {
    const modal = document.getElementById('scan-results-modal');
    const backdrop = document.getElementById('scan-results-backdrop');
    if (modal) modal.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';
}

function closeScanResultsModal(force = false) {
    const modal = document.getElementById('scan-results-modal');
    const backdrop = document.getElementById('scan-results-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    if (!activeScanJobKey || force) {
        setScanResultsView('scan-results-summary-view');
    }
}

function formatSmartScanSource(sourceType) {
    const source = String(sourceType || '').toLowerCase();
    if (source === 'f95zone') return 'F95Zone';
    if (source === 'dlsite') return 'DLsite';
    if (source === 'itch') return 'itch.io';
    return sourceType || 'Waiting...';
}

function getVisibleSmartScanReviewItems() {
    return (currentSmartScanResult?.review_items || []).filter(item => !item.dismissed);
}

function syncSmartScanResultFromState(state) {
    const scanDefinition = getScanJobDefinition(state?.job_key);
    activeScanModeKey = scanDefinition.jobKey;
    if (!state) return;
    currentSmartScanResult = {
        ...(currentSmartScanResult || {}),
        scanModeKey: scanDefinition.jobKey,
        processed: Number(state.completed || 0),
        total: Number(state.total || 0),
        matched: Number(state.matched_count || 0),
        manual_review: Number(state.manual_review_count || 0),
        not_found: Number(state.not_found_count || 0),
        failed: Number(state.failed_count || 0),
        review_items: currentSmartScanResult?.review_items || [],
        cancelled: state.status === 'cancelled',
    };
}

function renderScanToolbarProgress(state) {
    const shell = document.getElementById('scan-toolbar-progress');
    const label = document.getElementById('scan-toolbar-progress-label');
    const count = document.getElementById('scan-toolbar-progress-count');
    const fill = document.getElementById('scan-toolbar-progress-fill');
    if (!shell || !label || !count || !fill) return;

    const scanDefinition = getScanJobDefinition(state?.job_key);
    const total = Number(state?.total || 0);
    const completed = Number(state?.completed || 0);
    const currentIndex = Number(state?.current_index || completed || 0);
    const safeCurrent = total > 0 ? Math.min(total, Math.max(completed, currentIndex || completed)) : completed;
    const percent = Math.max(0, Math.min(100, Number(state?.percent || 0)));

    label.textContent = state?.cancel_requested ? `Cancelling ${scanDefinition.toolbarLabel.toLowerCase()}` : scanDefinition.toolbarLabel;
    count.textContent = total > 0 ? `${safeCurrent} / ${total}` : '0 / 0';
    fill.style.width = `${percent}%`;
    shell.hidden = false;
}

function hideScanToolbarProgress() {
    const shell = document.getElementById('scan-toolbar-progress');
    const label = document.getElementById('scan-toolbar-progress-label');
    const count = document.getElementById('scan-toolbar-progress-count');
    const fill = document.getElementById('scan-toolbar-progress-fill');
    const scanDefinition = getScanJobDefinition();
    if (shell) shell.hidden = true;
    if (label) label.textContent = scanDefinition.toolbarLabel;
    if (count) count.textContent = '0 / 0';
    if (fill) fill.style.width = '0%';
}

function renderSmartScanProgress(state) {
    syncSmartScanResultFromState(state);
    const scanDefinition = getScanJobDefinition(state?.job_key);
    setScanResultsView('scan-results-progress-view');
    const total = Number(state?.total || 0);
    const completed = Number(state?.completed || 0);
    const currentIndex = Number(state?.current_index || (state?.status === 'running' ? Math.min(total || 1, completed + 1) : completed));
    const percent = Math.max(0, Math.min(100, Number(state?.percent || 0)));
    const currentName = state?.current_title || 'Waiting for the backend to begin...';
    const currentSource = state?.current_source ? formatSmartScanSource(state.current_source) : 'Waiting...';
    const currentQuery = state?.current_query ? `"${state.current_query}"` : 'Waiting...';
    const detail = state?.detail || 'Preparing unresolved games...';

    document.getElementById('scan-results-title').textContent = scanDefinition.resultsTitle;
    document.getElementById('scan-results-copy').textContent = scanDefinition.resultsCopy;
    document.getElementById('smart-scan-status-title').textContent = state?.cancel_requested ? `Cancelling ${scanDefinition.resultsTitle.toLowerCase()}...` : 'Scanning metadata...';
    document.getElementById('smart-scan-status-text').textContent = detail;
    document.getElementById('smart-scan-game-counter').textContent = `Game ${Math.max(total ? 1 : 0, currentIndex)} / ${total}`;
    document.getElementById('smart-scan-progress-fill').style.width = `${percent}%`;
    document.getElementById('smart-scan-current-name').textContent = currentName;
    document.getElementById('smart-scan-current-source').textContent = currentSource;
    document.getElementById('smart-scan-current-query').textContent = currentQuery;
    document.getElementById('smart-scan-current-stage').textContent = detail;
    document.getElementById('smart-scan-count-matched').textContent = String(state?.matched_count || 0);
    document.getElementById('smart-scan-count-review').textContent = String(state?.manual_review_count || 0);
    document.getElementById('smart-scan-count-not-found').textContent = String(state?.not_found_count || 0);
    document.getElementById('smart-scan-count-failed').textContent = String(state?.failed_count || 0);

    const cancelButton = document.getElementById('btn-smart-scan-cancel');
    if (cancelButton) {
        cancelButton.disabled = !!state?.cancel_requested;
        cancelButton.innerHTML = state?.cancel_requested
            ? `<i data-lucide="loader" class="spin"></i><span>Cancelling...</span>`
            : `<i data-lucide="x-circle"></i><span>Cancel</span>`;
    }
    if (window.lucide) lucide.createIcons();
}

function renderSmartScanSummary(state = null) {
    const scanDefinition = getScanJobDefinition(state?.job_key || currentSmartScanResult?.scanModeKey);
    setScanResultsView('scan-results-summary-view');
    const fallbackResult = {
        processed: Number(state?.completed || 0),
        total: Number(state?.total || 0),
        matched: Number(state?.matched_count || 0),
        manual_review: Number(state?.manual_review_count || 0),
        not_found: Number(state?.not_found_count || 0),
        failed: Number(state?.failed_count || 0),
        review_items: currentSmartScanResult?.review_items || [],
        summary: state?.summary || state?.error || 'Missing source scan finished.',
        cancelled: state?.status === 'cancelled',
    };
    const result = state?.result || currentSmartScanResult || fallbackResult;
    currentSmartScanResult = {
        ...fallbackResult,
        ...(currentSmartScanResult || {}),
        ...result,
        scanModeKey: scanDefinition.jobKey,
        review_items: result.review_items || currentSmartScanResult?.review_items || fallbackResult.review_items,
        cancelled: Boolean(result.cancelled || state?.status === 'cancelled'),
    };

    const summaryTitle = state?.status === 'failed'
        ? `${scanDefinition.resultsTitle} failed`
        : currentSmartScanResult.cancelled
            ? `${scanDefinition.resultsTitle} cancelled`
            : `${scanDefinition.resultsTitle} complete`;
    document.getElementById('scan-results-title').textContent = 'Scan Results';
    document.getElementById('scan-results-copy').textContent = 'Review what the scan changed and decide what still needs manual attention.';
    document.getElementById('smart-scan-summary-eyebrow').textContent = currentSmartScanResult.cancelled ? scanDefinition.cancelledEyebrow : scanDefinition.eyebrow;
    document.getElementById('smart-scan-summary-title').textContent = summaryTitle;
    document.getElementById('smart-scan-summary-copy').textContent = currentSmartScanResult.summary || 'Missing source scan finished.';
    document.getElementById('smart-scan-summary-matched').textContent = String(currentSmartScanResult.matched || 0);
    document.getElementById('smart-scan-summary-review').textContent = String(currentSmartScanResult.manual_review || 0);
    document.getElementById('smart-scan-summary-not-found').textContent = String(currentSmartScanResult.not_found || 0);
    document.getElementById('smart-scan-summary-failed').textContent = String(currentSmartScanResult.failed || 0);

    const reviewButton = document.getElementById('btn-smart-scan-review');
    if (reviewButton) {
        reviewButton.style.display = getVisibleSmartScanReviewItems().length > 0 ? 'inline-flex' : 'none';
    }
    if (window.lucide) lucide.createIcons();
}

function renderSmartScanReviewList(reviewItems = null) {
    const scanDefinition = getScanJobDefinition(currentSmartScanResult?.scanModeKey);
    setScanResultsView('scan-results-review-view');
    document.getElementById('scan-results-title').textContent = scanDefinition.reviewTitle;
    document.getElementById('scan-results-copy').textContent = scanDefinition.reviewCopy;
    const list = document.getElementById('smart-scan-review-list');
    if (!list) return;

    const items = (reviewItems || getVisibleSmartScanReviewItems()).filter(item => !item.dismissed);
    if (!items.length) {
        list.innerHTML = `
            <div class="smart-review-card">
                <span class="smart-review-label">All clear</span>
                <strong>No unresolved games remain in this missing-source batch.</strong>
                <p class="smart-review-empty">Close the modal or run Find Missing Sources again whenever you want to retry unresolved entries.</p>
            </div>
        `;
        return;
    }

    list.innerHTML = items.map((item) => {
        const statusClass = String(item.status || 'review').replace('-', '_');
        const statusLabel = item.status === 'not_found'
            ? 'No match found'
            : item.status === 'failed'
                ? 'Source error'
                : 'Needs review';
        const groupedCandidates = (item.candidates || []).reduce((groups, candidate) => {
            const key = candidate.source_type || 'unknown';
            groups[key] = groups[key] || [];
            groups[key].push(candidate);
            return groups;
        }, {});
        const candidateGroups = Object.entries(groupedCandidates).map(([source, candidates]) => `
            <div class="smart-review-source-group">
                <div class="smart-review-source-head">
                    <span class="pill-primary">${escapeHtml(formatSmartScanSource(source).toUpperCase())}</span>
                    <span class="smart-review-empty">${candidates.length} candidate${candidates.length === 1 ? '' : 's'}</span>
                </div>
                ${candidates.map((candidate) => {
                    const confidenceClass = String(candidate.confidence || 'low').toLowerCase();
                    const candidatePayload = encodeURIComponent(JSON.stringify({
                        source_type: candidate.source_type,
                        source_url: candidate.url,
                        source_id: candidate.source_id || null,
                        title: candidate.title || '',
                        creator: candidate.creator || '',
                        cover: candidate.cover || '',
                        version: candidate.version || '',
                    }));
                    const reasonText = Array.isArray(candidate.reasons) && candidate.reasons.length
                        ? candidate.reasons.join(', ')
                        : 'Low-signal match';
                    return `
                        <div class="smart-review-candidate">
                            <div class="smart-review-candidate-copy">
                                <div class="smart-review-candidate-title">
                                    <strong>${escapeHtml(candidate.title || 'Unknown title')}</strong>
                                    <span class="confidence-chip ${escapeHtml(confidenceClass)}">${escapeHtml(candidate.confidence || 'low')}</span>
                                </div>
                                <div class="smart-review-candidate-meta">Developer / circle: ${escapeHtml(candidate.creator || 'Unknown')}</div>
                                <div class="smart-review-candidate-meta">Reason: ${escapeHtml(reasonText)}</div>
                                <div class="smart-review-candidate-meta">Score: ${escapeHtml(candidate.score || 0)}${candidate.matched_query ? ` | Query: ${escapeHtml(candidate.matched_query)}` : ''}</div>
                                ${candidate.url ? `<a href="${escapeHtml(candidate.url)}" class="smart-review-link" target="_blank">${escapeHtml(candidate.url)}</a>` : ''}
                            </div>
                            <div class="smart-review-candidate-actions">
                                <button type="button" class="btn-primary btn-apply-smart-review" data-game-id="${item.game_id}" data-candidate="${candidatePayload}">
                                    <i data-lucide="check"></i>
                                    <span>Apply Metadata</span>
                                </button>
                                <button type="button" class="btn-secondary btn-view-smart-review" data-url="${escapeHtml(candidate.url || '')}">
                                    <i data-lucide="external-link"></i>
                                    <span>View Candidate</span>
                                </button>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `).join('');

        const thumbnailMarkup = item.thumbnail_url
            ? `<img src="${escapeHtml(item.thumbnail_url)}" alt="${escapeHtml(item.current_title || item.local_name || 'Game cover')}" class="smart-review-thumb" loading="lazy" referrerpolicy="no-referrer">`
            : `<div class="smart-review-thumb-fallback">X</div>`;

        return `
            <div class="smart-review-card" data-game-id="${item.game_id}">
                <div class="smart-review-body">
                    <div class="smart-review-media">
                        ${thumbnailMarkup}
                    </div>
                    <div class="smart-review-content">
                        <div class="smart-review-top">
                            <div>
                                <span class="smart-review-label">Local game</span>
                                <h5 class="smart-review-title">${escapeHtml(item.local_name || item.current_title || 'Unknown')}</h5>
                                <p class="smart-review-copy">Current title: ${escapeHtml(item.current_title || 'Unknown')}<br>Metadata status: ${escapeHtml(item.metadata_status || 'Needs verification')}</p>
                            </div>
                            <span class="smart-review-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                        </div>
                        ${candidateGroups || `<div class="smart-review-empty">No matching game found.</div>`}
                        ${item.error_summary ? `<div class="smart-review-empty">Details: ${escapeHtml(item.error_summary)}</div>` : ''}
                        <div class="smart-review-row-actions">
                            <button type="button" class="btn-secondary btn-dismiss-smart-review" data-game-id="${item.game_id}">
                                <i data-lucide="clock-3"></i>
                                <span>${item.status === 'review' ? 'Skip' : 'Resolve later'}</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    }).join('');

    list.querySelectorAll('.btn-view-smart-review').forEach((button) => {
        button.addEventListener('click', async () => {
            const url = button.dataset.url;
            if (url) await openExternalUrl(url);
        });
    });

    list.querySelectorAll('.btn-dismiss-smart-review').forEach((button) => {
        button.addEventListener('click', async () => {
            const gameId = Number(button.dataset.gameId || 0);
            if (!gameId) return;
            try {
                const res = await fetch(`${API_BASE}/api/library/missing-source-scan/review/${gameId}/skip`, { method: 'POST' });
                if (!res.ok) throw new Error('Failed to skip candidate');
                currentSmartScanResult.review_items = (currentSmartScanResult.review_items || []).filter((item) => item.game_id !== gameId);
                renderSmartScanReviewList();
            } catch (error) {
                alert(`Failed to skip candidate: ${error.message}`);
            }
        });
    });

    list.querySelectorAll('.btn-apply-smart-review').forEach((button) => {
        button.addEventListener('click', async () => {
            const gameId = Number(button.dataset.gameId || 0);
            if (!gameId || !button.dataset.candidate) return;
            const candidate = JSON.parse(decodeURIComponent(button.dataset.candidate));
            const originalHtml = button.innerHTML;
            button.disabled = true;
            button.innerHTML = `<i data-lucide="loader" class="spin"></i><span>Applying...</span>`;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/library/missing-source-scan/review/${gameId}/apply`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(candidate),
                });
                const data = await readJsonResponse(res);
                if (!res.ok) {
                    throw new Error(data.detail || 'Failed to apply metadata');
                }
                const reviewItem = (currentSmartScanResult.review_items || []).find((item) => item.game_id === gameId);
                if (reviewItem) {
                    if (reviewItem.status === 'review') currentSmartScanResult.manual_review = Math.max(0, (currentSmartScanResult.manual_review || 0) - 1);
                    if (reviewItem.status === 'not_found') currentSmartScanResult.not_found = Math.max(0, (currentSmartScanResult.not_found || 0) - 1);
                    if (reviewItem.status === 'failed') currentSmartScanResult.failed = Math.max(0, (currentSmartScanResult.failed || 0) - 1);
                }
                currentSmartScanResult.matched = Number(currentSmartScanResult.matched || 0) + 1;
                currentSmartScanResult.review_items = (currentSmartScanResult.review_items || []).map((item) =>
                    item.game_id === gameId ? { ...item, dismissed: true, resolved: true } : item,
                );
                await Promise.allSettled([fetchStats(), fetchTags(), loadGames()]);
                renderSmartScanReviewList();
                if (data.warning) alert(data.warning);
            } catch (err) {
                alert(`Failed to apply metadata: ${err.message}`);
                button.disabled = false;
                button.innerHTML = originalHtml;
                if (window.lucide) lucide.createIcons();
            }
        });
    });

    if (window.lucide) lucide.createIcons();
}

let smartScanPollPromise = null;

function ensureSmartScanPolling(jobKey) {
    if (smartScanPollPromise) return smartScanPollPromise;
    smartScanPollPromise = pollSmartScanJob(jobKey).finally(() => {
        smartScanPollPromise = null;
    });
    return smartScanPollPromise;
}

async function pollSmartScanJob(jobKey) {
    activeScanModeKey = jobKey;
    let pollFailures = 0;
    while (activeScanJobKey === jobKey) {
        try {
            const state = await getLibraryJobState(jobKey);
            pollFailures = 0;
            renderScanToolbarProgress(state);
            renderSmartScanProgress(state);

            if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed') {
                activeScanJobKey = null;
                currentSmartScanResult = state.result || currentSmartScanResult;
                hideScanToolbarProgress();
                await Promise.allSettled([fetchStats(), fetchTags(), loadGames()]);
                showScanResultsModal();
                renderSmartScanSummary(state);
                return;
            }
        } catch (err) {
            pollFailures += 1;
            if (pollFailures >= 5) {
                activeScanJobKey = null;
                hideScanToolbarProgress();
                currentSmartScanResult = {
                    processed: Number(currentSmartScanResult?.processed || 0),
                    total: Number(currentSmartScanResult?.total || 0),
                    matched: Number(currentSmartScanResult?.matched || 0),
                    manual_review: Number(currentSmartScanResult?.manual_review || 0),
                    not_found: Number(currentSmartScanResult?.not_found || 0),
                    failed: Number(currentSmartScanResult?.failed || 0) + 1,
                    review_items: currentSmartScanResult?.review_items || [],
                    summary: `Missing source scan polling failed: ${err.message}`,
                };
                showScanResultsModal();
                renderSmartScanSummary({ status: 'failed', error: err.message, result: currentSmartScanResult });
                return;
            }
            await wait(600 * pollFailures);
            continue;
        }

        await wait(350);
    }
}

async function startTrackedMetadataScan(scanKey) {
    const scanDefinition = getScanJobDefinition(scanKey);
    activeScanModeKey = scanDefinition.jobKey;
    activeScanJobKey = scanDefinition.jobKey;
    currentSmartScanResult = null;
    closeScanWorkflowModal(true);
    closeScanResultsModal(true);
    const initialState = {
        job_key: scanDefinition.jobKey,
        status: 'running',
        total: 0,
        completed: 0,
        percent: 0,
        current_index: 0,
        current_title: '',
        current_source: '',
        current_query: '',
        detail: 'Preparing unresolved games...',
        matched_count: 0,
        manual_review_count: 0,
        not_found_count: 0,
        failed_count: 0,
    };
    renderScanToolbarProgress(initialState);
    renderSmartScanProgress({
        ...initialState,
    });

    try {
        const res = await fetch(scanDefinition.startUrl, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) {
            activeScanJobKey = null;
            hideScanToolbarProgress();
            showScanWorkflowModal();
            setScanWorkflowView('scan-workflow-choice-view');
            throw new Error(data.detail || `Failed to start ${scanDefinition.resultsTitle.toLowerCase()}`);
        }

        if (data.status === 'completed' || data.status === 'cancelled' || data.status === 'failed') {
            activeScanJobKey = null;
            currentSmartScanResult = data.result || null;
            if (currentSmartScanResult) currentSmartScanResult.scanModeKey = scanDefinition.jobKey;
            hideScanToolbarProgress();
            await Promise.allSettled([fetchStats(), fetchTags(), loadGames()]);
            showScanResultsModal();
            renderSmartScanSummary(data);
            return;
        }

        renderScanToolbarProgress(data);
        renderSmartScanProgress(data);
        ensureSmartScanPolling(scanDefinition.jobKey);
    } catch (err) {
        activeScanJobKey = null;
        hideScanToolbarProgress();
        alert(`Failed to start ${scanDefinition.resultsTitle.toLowerCase()}: ${err.message}`);
    }
}

async function startMissingSourceScan() {
    await startTrackedMetadataScan(MISSING_SOURCE_SCAN_JOB_KEY);
}

async function resumeActiveSmartScanJob({ openResults = false, onlyRunning = false } = {}) {
    for (const scanKey of Object.keys(SCAN_JOB_DEFINITIONS)) {
        try {
            const state = await getLibraryJobState(scanKey);
            if (state?.status === 'running') {
                activeScanModeKey = scanKey;
                activeScanJobKey = scanKey;
                currentSmartScanResult = state.result || null;
                if (currentSmartScanResult) currentSmartScanResult.scanModeKey = scanKey;
                renderScanToolbarProgress(state);
                renderSmartScanProgress(state);
                if (openResults) {
                    showScanResultsModal();
                }
                ensureSmartScanPolling(scanKey);
                return true;
            }

            if (!onlyRunning && (state?.status === 'completed' || state?.status === 'cancelled' || state?.status === 'failed') && state?.result) {
                activeScanModeKey = scanKey;
                activeScanJobKey = null;
                currentSmartScanResult = state.result;
                currentSmartScanResult.scanModeKey = scanKey;
                hideScanToolbarProgress();
                if (openResults) {
                    showScanResultsModal();
                    renderSmartScanSummary(state);
                }
                return true;
            }
        } catch (error) {
            console.debug(`Unable to restore ${scanKey} job state`, error);
        }
    }

    return false;
}

async function openScanWorkflowModal() {
    const resumed = await resumeActiveSmartScanJob({ openResults: true, onlyRunning: true });
    if (resumed) return;

    document.getElementById('scan-workflow-title').textContent = 'Scan Your Library';
    document.getElementById('scan-workflow-copy').textContent = 'Choose the scan mode that fits the work you want XDir to do right now.';
    setScanWorkflowView('scan-workflow-choice-view');
    showScanWorkflowModal();
}

async function runOverviewMetadataFetch(button, idleHtml, loadingHtml, failureMessage) {
    if (!currentGame || !button) return;

    button.disabled = true;
    button.innerHTML = loadingHtml;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
        if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Server error');
        }
        const data = await res.json();

        const wasIdentified = currentGame.is_identified;
        currentGame = data.game;
        renderOverview(currentGame);
        await fetchTags();
        await loadGames();

        if (!currentGame.is_identified) {
            openInteractiveSearch(currentGame.title || currentGame.raw_name, getPreferredSourcePlatform());
        } else if (!wasIdentified && currentGame.is_identified) {
            alert(`Successfully auto-identified as: ${currentGame.title}`);
        }
    } catch (err) {
        alert(`${failureMessage}: ${err.message}`);
    } finally {
        button.disabled = false;
        button.innerHTML = idleHtml;
        if (window.lucide) lucide.createIcons();
    }
}


// Filter States
let filterState = {
    preset: 'all',
    progress: 'all',
    updates: 'all',
    tag: 'all',
    source: 'all',
    search: '',
    sort: 'title'
};

document.addEventListener('DOMContentLoaded', () => {
    try {
        applyAppearanceSettings(localStorage.getItem('xdir_theme_mode'), localStorage.getItem('xdir_accent_color'));
    } catch (_) {
        applyAppearanceSettings('midnight', 'blue');
    }
    initApp();
});

function activateTab(tabId) {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.view-panel').forEach(v => v.classList.remove('active'));

    const activeTab = document.querySelector(`.nav-tab[data-tab="${tabId}"]`);
    const activeView = document.getElementById(`view-${tabId}`);
    if (!activeTab || !activeView) return;

    activeTab.classList.add('active');
    activeView.classList.add('active');

    if (tabId === 'library') loadGames();
    if (tabId === 'extension' && typeof loadExtensionQueue === 'function') loadExtensionQueue();
    if (tabId === 'settings') {
        fetchStats();
        refreshSettingsMetadataQueue({ force: true }).catch((error) => {
            console.debug('Failed to refresh settings metadata queue', error);
        });
    }
}

async function initApp() {
    setupWindowResizeHandles();
    setupEventListeners();
    renderExtensionBrowserGuide(currentExtensionBrowser);
    const statsTask = fetchStats();
    const settingsTask = loadSettings();
    const tagsTask = fetchTags();
    const gamesTask = loadGames();
    await Promise.allSettled([statsTask, settingsTask]);
    resumeActiveSettingsJob().catch((error) => {
        console.error('Failed to resume active settings job', error);
    });
    resumeActiveSmartScanJob({ onlyRunning: true }).catch((error) => {
        console.error('Failed to resume active missing-source scan job', error);
    });
    
    // Dismiss Splash Screen
    const splash = document.getElementById('app-splash');
    if (splash) {
        const statusEl = document.getElementById('splash-status');
        if (statusEl) statusEl.textContent = "Library loaded!";
        setTimeout(() => {
            splash.style.opacity = '0';
            splash.style.visibility = 'hidden';
            setTimeout(() => splash.remove(), 500);
        }, 300);
    }
    
    await Promise.allSettled([tagsTask, gamesTask]);
    await checkExtensionStatus();
    setInterval(checkExtensionStatus, 15000);
    setInterval(fetchStats, 3000);
}

async function checkExtensionStatus() {
    try {
        const res = await fetch(`${API_BASE}/api/extension/status`);
        const status = await res.json();
        
        const pill = document.getElementById('ext-status-pill');
        const dot = document.getElementById('ext-status-dot');
        const label = document.getElementById('ext-status-label');
        
        const indicator = document.getElementById('extension-status-indicator');
        const liveStatus = document.getElementById('extension-live-status');
        const liveDetail = document.getElementById('extension-live-detail');
        const lastSeen = document.getElementById('extension-last-seen');
        const connected = !!(status.connected || status.status === 'connected');

        if (connected) {
            if (pill) pill.className = 'quick-status ext-pill connected';
            if (dot) dot.className = 'status-dot';
            if (label) label.textContent = `Extension Connected (v${status.version || '1.0'})`;
            if (indicator) indicator.className = 'extension-status-indicator connected';
            if (liveStatus) liveStatus.textContent = `Connected${status.version ? ` (v${status.version})` : ''}`;
            if (liveDetail) liveDetail.textContent = 'Browser companion heartbeat is live. You can scrape and monitor the queue right now.';
            if (lastSeen) lastSeen.textContent = 'Just now';
        } else {
            if (pill) pill.className = 'quick-status ext-pill offline';
            if (dot) dot.className = 'status-dot offline';
            if (label) label.textContent = 'Extension Offline';
            if (indicator) indicator.className = 'extension-status-indicator offline';
            if (liveStatus) liveStatus.textContent = 'Offline';
            if (liveDetail) liveDetail.textContent = 'No heartbeat detected. Keep the browser open and load the unpacked extension from the folder shown here.';
            if (lastSeen) lastSeen.textContent = formatExtensionHeartbeat(status.last_seen_seconds);
        }

        renderSettingsExtensionStatus(status);

    } catch (e) {
        console.debug("Extension status check failed", e);
        const indicator = document.getElementById('extension-status-indicator');
        const liveStatus = document.getElementById('extension-live-status');
        const liveDetail = document.getElementById('extension-live-detail');
        const lastSeen = document.getElementById('extension-last-seen');
        if (indicator) indicator.className = 'extension-status-indicator offline';
        if (liveStatus) liveStatus.textContent = 'Offline';
        if (liveDetail) liveDetail.textContent = 'Unable to read extension heartbeat status right now.';
        if (lastSeen) lastSeen.textContent = 'Unavailable';
        renderSettingsExtensionStatus({ connected: false });
    }
}

function setupWindowResizeHandles() {
    const handles = document.querySelectorAll('.window-resize-hitbox[data-resize-edge]');
    if (!handles.length) return;
    const desktopResize = window.pywebview && window.pywebview.api && window.pywebview.api.start_resize;

    if (!desktopResize) {
        handles.forEach((handle) => {
            handle.style.display = 'none';
        });
        return;
    }

    handles.forEach((handle) => {
        handle.addEventListener('mousedown', async (event) => {
            if (event.button !== 0) return;

            const edge = handle.dataset.resizeEdge;
            if (!edge) return;

            event.preventDefault();
            event.stopPropagation();

            try {
                await desktopResize(edge);
            } catch (_) {
                // Ignore desktop shell resize failures so the app remains usable.
            }
        });
    });
}

function setupEventListeners() {
    // Navigation Tabs
    document.querySelectorAll('.nav-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activateTab(tab.dataset.tab);
        });
    });

    const homeLogoBtn = document.getElementById('btn-home-logo');
    if (homeLogoBtn) {
        homeLogoBtn.addEventListener('click', () => {
            activateTab('library');
        });
    }

    // Quick Scan / Add Game button
    const btnAddGame = document.getElementById('btn-add-game');
    if (btnAddGame) btnAddGame.addEventListener('click', () => openScanWorkflowModal());

    const scanToolbarProgressBtn = document.getElementById('btn-open-smart-scan-progress');
    if (scanToolbarProgressBtn) {
        scanToolbarProgressBtn.addEventListener('click', () => {
            resumeActiveSmartScanJob({ openResults: true, onlyRunning: true });
        });
    }

    const scanToolbarCancelBtn = document.getElementById('btn-cancel-smart-scan-toolbar');
    if (scanToolbarCancelBtn) {
        scanToolbarCancelBtn.addEventListener('click', async () => {
            if (!activeScanJobKey) return;
            try {
                await fetch(`${API_BASE}/api/library/jobs/${activeScanJobKey}/cancel`, { method: 'POST' });
            } catch (error) {
                alert(`Failed to cancel scan: ${error.message}`);
            }
        });
    }

    const closeScanWorkflowBtn = document.getElementById('btn-close-scan-workflow');
    if (closeScanWorkflowBtn) {
        closeScanWorkflowBtn.addEventListener('click', () => closeScanWorkflowModal());
    }

    const scanWorkflowBackdrop = document.getElementById('scan-workflow-backdrop');
    if (scanWorkflowBackdrop) {
        scanWorkflowBackdrop.addEventListener('click', () => closeScanWorkflowModal());
    }

    const closeScanResultsBtn = document.getElementById('btn-close-scan-results');
    if (closeScanResultsBtn) {
        closeScanResultsBtn.addEventListener('click', () => closeScanResultsModal());
    }

    const scanResultsBackdrop = document.getElementById('scan-results-backdrop');
    if (scanResultsBackdrop) {
        scanResultsBackdrop.addEventListener('click', () => closeScanResultsModal());
    }

    const normalScanBtn = document.getElementById('btn-scan-normal');
    if (normalScanBtn) {
        normalScanBtn.addEventListener('click', async () => {
            closeScanWorkflowModal(true);
            await triggerRescan(document.getElementById('btn-add-game'));
        });
    }

    const missingSourceScanBtn = document.getElementById('btn-scan-missing-source');
    if (missingSourceScanBtn) {
        missingSourceScanBtn.addEventListener('click', async () => {
            await startMissingSourceScan();
        });
    }

    const smartScanCancelBtn = document.getElementById('btn-smart-scan-cancel');
    if (smartScanCancelBtn) {
        smartScanCancelBtn.addEventListener('click', async () => {
            if (!activeScanJobKey) return;
            try {
                await fetch(`${API_BASE}/api/library/jobs/${activeScanJobKey}/cancel`, { method: 'POST' });
            } catch (error) {
                alert(`Failed to cancel scan: ${error.message}`);
            }
        });
    }

    const smartScanReviewBtn = document.getElementById('btn-smart-scan-review');
    if (smartScanReviewBtn) {
        smartScanReviewBtn.addEventListener('click', () => {
            renderSmartScanReviewList();
        });
    }

    const smartScanRunAgainBtn = document.getElementById('btn-smart-scan-run-again');
    if (smartScanRunAgainBtn) {
        smartScanRunAgainBtn.addEventListener('click', async () => {
            await startSmartScan();
        });
    }

    const smartScanCloseBtn = document.getElementById('btn-smart-scan-close');
    if (smartScanCloseBtn) {
        smartScanCloseBtn.addEventListener('click', () => closeScanResultsModal());
    }

    const smartScanReviewBackBtn = document.getElementById('btn-smart-scan-review-back');
    if (smartScanReviewBackBtn) {
        smartScanReviewBackBtn.addEventListener('click', () => renderSmartScanSummary());
    }
    
    // Window Controls (Minimize, Maximize, Close)
    const btnWinMin = document.getElementById('btn-win-min');
    if (btnWinMin) btnWinMin.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.minimize) pywebview.api.minimize();
        else await fetch(`${API_BASE}/api/window/minimize`, { method: 'POST' }).catch(() => {});
    });
    const btnWinMax = document.getElementById('btn-win-max');
    if (btnWinMax) btnWinMax.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.maximize) pywebview.api.maximize();
        else await fetch(`${API_BASE}/api/window/maximize`, { method: 'POST' }).catch(() => {});
    });
    const btnWinClose = document.getElementById('btn-win-close');
    if (btnWinClose) btnWinClose.addEventListener('click', async () => {
        if (window.pywebview && pywebview.api && pywebview.api.close) pywebview.api.close();
        else await fetch(`${API_BASE}/api/window/close`, { method: 'POST' }).catch(() => {});
    });
    
    // Add to Wishlist
    const addWishBtn = document.getElementById('btn-add-wishlist');
    if (addWishBtn) {
        addWishBtn.addEventListener('click', () => {
            if (typeof openWishlistModal === 'function') openWishlistModal();
        });
    }

    // Onboarding & Tutorial controls
    document.getElementById('btn-show-tutorial')?.addEventListener('click', () => {
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'flex';
    });
    document.getElementById('btn-close-onboarding')?.addEventListener('click', () => {
        localStorage.setItem('xdir_onboarding_completed', 'true');
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'none';
    });
    document.getElementById('btn-onboarding-got-it')?.addEventListener('click', () => {
        localStorage.setItem('xdir_onboarding_completed', 'true');
        const modal = document.getElementById('onboarding-modal');
        if (modal) modal.style.display = 'none';
    });

    document.getElementById('btn-open-library-directory-modal')?.addEventListener('click', () => {
        openLibraryDirectoryModal();
    });

    document.getElementById('btn-close-library-directory-modal')?.addEventListener('click', () => {
        closeLibraryDirectoryModal();
    });

    document.getElementById('library-directory-backdrop')?.addEventListener('click', () => {
        closeLibraryDirectoryModal();
    });

    document.getElementById('btn-library-add-directory')?.addEventListener('click', async () => {
        await addLibraryDirectory();
    });

    document.getElementById('btn-save-preferences')?.addEventListener('click', async () => {
        await persistSettings();
    });

    document.getElementById('set-preferred-source')?.addEventListener('change', (event) => {
        renderSettingsPreferredSource(event.target.value);
    });

    document.getElementById('set-theme-mode')?.addEventListener('change', (event) => {
        applyAppearanceSettings(event.target.value, document.getElementById('set-accent-color')?.value);
    });

    document.getElementById('set-accent-color')?.addEventListener('change', (event) => {
        applyAppearanceSettings(document.getElementById('set-theme-mode')?.value, event.target.value);
    });

    document.getElementById('btn-settings-scan-directory')?.addEventListener('click', async () => {
        await triggerRescan(document.getElementById('btn-settings-scan-directory'));
    });

    document.getElementById('btn-settings-missing-source-scan')?.addEventListener('click', async () => {
        await startMissingSourceScan();
    });

    document.getElementById('btn-settings-export-library')?.addEventListener('click', async () => {
        await startPortableLibraryExport();
    });

    document.getElementById('btn-settings-import-library')?.addEventListener('click', async () => {
        await startPortableLibraryImport();
    });

    document.getElementById('btn-settings-check-updates')?.addEventListener('click', async () => {
        await startSettingsTrackedJob('update-check');
    });

    document.getElementById('btn-settings-cancel-job')?.addEventListener('click', async () => {
        if (!activeSettingsJobKey) return;
        const button = document.getElementById('btn-settings-cancel-job');
        if (button) button.disabled = true;
        try {
            await fetch(`${API_BASE}/api/library/jobs/${activeSettingsJobKey}/cancel`, { method: 'POST' });
        } finally {
            if (button) button.disabled = false;
        }
    });

    document.getElementById('btn-settings-open-extension-tab')?.addEventListener('click', () => {
        activateTab('extension');
        if (typeof loadExtensionQueue === 'function') loadExtensionQueue();
    });

    document.getElementById('btn-extension-open-folder')?.addEventListener('click', async () => {
        await openExtensionFolder();
    });

    document.getElementById('btn-settings-open-extension-folder')?.addEventListener('click', async () => {
        await openExtensionFolder();
    });

    document.getElementById('btn-extension-copy-path')?.addEventListener('click', async (event) => {
        await copyExtensionPath(event.currentTarget);
    });

    document.getElementById('btn-settings-copy-extension-path')?.addEventListener('click', async (event) => {
        await copyExtensionPath(event.currentTarget);
    });

    document.querySelectorAll('.extension-browser-chip').forEach((button) => {
        button.addEventListener('click', () => {
            renderExtensionBrowserGuide(button.dataset.browser || 'chrome');
        });
    });

    // Filter Cards in Sidebar
    const filterAvailCard = document.getElementById('filter-available-card');
    if (filterAvailCard) {
        filterAvailCard.addEventListener('click', () => {
            const presetSelect = document.getElementById('filter-preset');
            if (presetSelect) presetSelect.value = 'available';
            filterState.preset = 'available';
            
            const updatesSelect = document.getElementById('filter-updates');
            if (updatesSelect) updatesSelect.value = 'all';
            filterState.updates = 'all';
            
            loadGames();
        });
    }

    const filterWishCard = document.getElementById('filter-wishlist-card');
    if (filterWishCard) {
        filterWishCard.addEventListener('click', () => {
            const updatesSelect = document.getElementById('filter-updates');
            if (updatesSelect) updatesSelect.value = 'wishlist';
            filterState.updates = 'wishlist';
            loadGames();
        });
    }

    // Left Filter Sidebar Selects
    ['preset', 'progress', 'updates', 'tag', 'source'].forEach(key => {
        const el = document.getElementById(`filter-${key}`);
        if (el) {
            el.addEventListener('change', (e) => {
                filterState[key] = e.target.value;
                loadGames();
            });
        }
    });

    // Search bar
    const searchInput = document.getElementById('search-input');
    const clearBtn = document.getElementById('clear-search');
    let searchTimeout;
    
    searchInput.addEventListener('input', (e) => {
        filterState.search = e.target.value.trim();
        clearBtn.style.display = filterState.search ? 'block' : 'none';
        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(() => loadGames(), 150);
    });

    clearBtn.addEventListener('click', () => {
        searchInput.value = '';
        filterState.search = '';
        clearBtn.style.display = 'none';
        loadGames();
    });

    // Sort select
    document.getElementById('sort-select').addEventListener('change', (e) => {
        filterState.sort = e.target.value;
        loadGames();
    });

    // Tiles per row select
    const tilesSelect = document.getElementById('tiles-per-row-select');
    if (tilesSelect) {
        const savedTiles = localStorage.getItem('xdir_tiles_per_row') || 'auto';
        tilesSelect.value = savedTiles;
        applyTilesPerRow(savedTiles);

        tilesSelect.addEventListener('change', (e) => {
            const val = e.target.value;
            localStorage.setItem('xdir_tiles_per_row', val);
            applyTilesPerRow(val);
        });
    }

    // Overview Back button
    document.getElementById('overview-back').addEventListener('click', async () => {
        document.getElementById('overview-modal').style.display = 'none';
        
        // Restore scroll position of the games grid
        const gridEl = document.getElementById('games-grid');
        const scrollPos = lastGridScrollPos || (gridEl ? gridEl.scrollTop : 0);
        if (gridEl) gridEl.scrollTop = scrollPos;
    });

    // Overview Launch button
    document.getElementById('ov-btn-launch').addEventListener('click', () => {
        if (currentGame) launchGame(currentGame.id);
    });
    document.getElementById('ov-btn-open-folder')?.addEventListener('click', () => {
        if (currentGame) openGameFolder(currentGame.id);
    });

    const updateBadgeBtn = document.getElementById('ov-badge-update');
    if (updateBadgeBtn) {
        updateBadgeBtn.addEventListener('click', async () => {
            const source = getPreferredGameUpdateSource(currentGame);
            if (source?.source_url) await openExternalUrl(source.source_url);
        });
    }

    document.getElementById('ov-btn-check-update')?.addEventListener('click', checkCurrentGameForUpdate);
    document.getElementById('ov-btn-save-local-version')?.addEventListener('click', saveCurrentGameLocalVersion);
    document.getElementById('ov-local-version-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentGameLocalVersion();
    });
    document.getElementById('ov-btn-mark-latest-installed')?.addEventListener('click', markCurrentGameLatestInstalled);
    document.getElementById('ov-btn-open-update-page')?.addEventListener('click', async () => {
        const source = getPreferredGameUpdateSource(currentGame);
        if (source?.source_url) await openExternalUrl(source.source_url);
    });

    // Overview Progress Selector
    document.getElementById('ov-progress-select').addEventListener('change', async (e) => {
        if (!currentGame) return;
        const newProg = e.target.value;
        try {
            await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ playing_progress: newProg })
            });
            currentGame.playing_progress = newProg;
        } catch (err) {
            console.error("Failed to update progress", err);
        }
    });

    // Overview User Star Rating Selector
    const starBtns = document.querySelectorAll('.user-star-btn');
    starBtns.forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!currentGame) return;
            const val = btn.getAttribute('data-val');
            const scoreStr = `${val}/5`;
            try {
                await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_score: scoreStr })
                });
                currentGame.user_score = scoreStr;
                updateStarPickerUI(scoreStr);
                const gridCardScore = document.querySelector(`.game-card[data-id="${currentGame.id}"] .card-rating-box span:nth-child(2)`);
                if (gridCardScore && currentGame.user_score) gridCardScore.textContent = currentGame.user_score;
            } catch (err) {
                console.error("Failed to set user score", err);
            }
        });
    });

    const clearStarBtn = document.getElementById('ov-clear-star');
    if (clearStarBtn) {
        clearStarBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            try {
                await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ user_score: '' })
                });
                currentGame.user_score = '';
                updateStarPickerUI('');
                const gridCardScore = document.querySelector(`.game-card[data-id="${currentGame.id}"] .card-rating-box span:nth-child(2)`);
                if (gridCardScore) gridCardScore.textContent = currentGame.rating || 'N/A';
            } catch (err) {
                console.error("Failed to clear user score", err);
            }
        });
    }

    // Custom Tag adder
    document.getElementById('ov-btn-add-tag').addEventListener('click', async () => {
        const input = document.getElementById('ov-new-tag-input');
        const tag = input.value.trim();
        if (!tag || !currentGame) return;
        
        try {
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/custom_tags`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tag_name: tag })
            });
            currentGame = await res.json();
            input.value = '';
            renderOverview(currentGame);
            await fetchTags();
        } catch (err) {
            console.error("Failed to add custom tag", err);
        }
    });

    // Journal Entry adder
    document.getElementById('ov-btn-add-journal').addEventListener('click', async () => {
        const text = prompt("Enter game journal note or patch activity:");
        if (!text || !text.trim() || !currentGame) return;
        
        try {
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/journal`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ entry_text: text.trim() })
            });
            currentGame = await res.json();
            renderOverview(currentGame);
        } catch (err) {
            console.error("Failed to add journal", err);
        }
    });

    // Settings Section Navigation
    document.querySelectorAll('.settings-nav-item').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.settings-nav-item').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.set-panel').forEach(p => p.classList.remove('active'));
            
            btn.classList.add('active');
            const secId = btn.dataset.section;
            const target = document.getElementById(`set-${secId}`);
            if (target) target.classList.add('active');
        });
    });

    // Lightbox Close
    document.getElementById('lightbox-close').addEventListener('click', () => {
        document.getElementById('lightbox-modal').style.display = 'none';
    });

    // Per-game fetch info button
    const fetchBtn = document.getElementById('ov-btn-fetch');
    if (fetchBtn) {
        fetchBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            fetchBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Fetching...</span>`;
            if (window.lucide) lucide.createIcons();
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/fetch-metadata`, { method: 'POST' });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Server error");
                }
                const data = await res.json();
                
                const wasIdentified = currentGame.is_identified;
                currentGame = data.game;
                renderOverview(currentGame);
                await fetchTags();
                await loadGames();
                
                if (!currentGame.is_identified) {
                    openInteractiveSearch(currentGame.title || currentGame.raw_name, getPreferredSourcePlatform());
                } else if (!wasIdentified && currentGame.is_identified) {
                    alert(`Successfully auto-identified as: ${currentGame.title}`);
                } else {
                    // It was already identified, just updated
                    alert("Metadata refreshed successfully!");
                }
            } catch (err) {
                alert("Failed to fetch information: " + err.message);
            } finally {
                fetchBtn.innerHTML = `<i data-lucide="download-cloud"></i> <span id="ov-fetch-text">Fetch Info</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Copy title button
    const copyTitleBtn = document.getElementById('ov-btn-copy-title');
    if (copyTitleBtn) {
        copyTitleBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            try {
                await navigator.clipboard.writeText(currentGame.title || currentGame.raw_name);
                const originalHTML = copyTitleBtn.innerHTML;
                copyTitleBtn.innerHTML = `<i data-lucide="check" style="width: 18px; height: 18px; color: var(--success);"></i>`;
                if (window.lucide) lucide.createIcons();
                setTimeout(() => {
                    copyTitleBtn.innerHTML = originalHTML;
                    if (window.lucide) lucide.createIcons();
                }, 1500);
            } catch (err) {
                console.error("Failed to copy", err);
            }
        });
    }

    // Translation Logic
    async function translateTextsBackend(texts) {
        try {
            const res = await fetch(`${API_BASE}/api/translate`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texts: texts })
            });
            const data = await res.json();
            return data.translations;
        } catch (err) {
            console.error("Translation failed", err);
            return texts;
        }
    }

    const translateBtn = document.getElementById('ov-btn-translate');
    if (translateBtn) {
        translateBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            
            if (isTranslated) {
                // Restore originals
                document.getElementById('ov-title-top').textContent = originalMetadata.title;
                document.getElementById('ov-title').textContent = originalMetadata.title;
                const descEl = document.getElementById('ov-description');
                if (descEl) descEl.textContent = originalMetadata.description || "No description available yet. Use Fetch Info above or the companion extension to auto-scrape from F95zone or DLsite!";
                
                const tagsCloud = document.getElementById('ov-tag-cloud');
                if (tagsCloud) tagsCloud.innerHTML = originalMetadata.tagsHtml;
                
                isTranslated = false;
                translateBtn.innerHTML = renderTranslateButtonLabel('translate');
                translateBtn.style.color = '#93c5fd';
                return;
            }
            
            const origHtml = translateBtn.innerHTML;
            const origColor = translateBtn.style.color;
            try {
                translateBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Translating...</span>`;
                translateBtn.style.color = '#fbbf24';
                translateBtn.disabled = true;
                if (window.lucide) lucide.createIcons();
                
                // Save originals
                if (!originalMetadata) {
                    const tagsCloud = document.getElementById('ov-tag-cloud');
                    originalMetadata = {
                        title: currentGame.title || currentGame.raw_name,
                        description: currentGame.description,
                        tagsHtml: tagsCloud ? tagsCloud.innerHTML : ''
                    };
                }
                
                const allTags = [...(currentGame.tags || []), ...(currentGame.custom_tags || [])];
                const toTranslate = [originalMetadata.title, originalMetadata.description || '', ...allTags];
                
                const translated = await translateTextsBackend(toTranslate);
                if (!translated || translated.length === 0) {
                    throw new Error("Empty translation response");
                }
                
                const tTitle = translated[0];
                const tDesc = translated[1];
                const tTags = translated.slice(2);
                
                const tagsHtml = tTags.length > 0
                    ? tTags.map(t => `<span class="tag-chip">${t}</span>`).join('')
                    : `<span class="tag-chip">${currentGame.category || 'General'}</span>`;
                
                document.getElementById('ov-title-top').textContent = tTitle;
                document.getElementById('ov-title').textContent = tTitle;
                const descEl = document.getElementById('ov-description');
                if (descEl) descEl.textContent = tDesc || "No description available yet.";
                const tagsCloudEl = document.getElementById('ov-tag-cloud');
                if (tagsCloudEl) tagsCloudEl.innerHTML = tagsHtml;
                
                isTranslated = true;
                translateBtn.innerHTML = renderTranslateButtonLabel('revert');
                translateBtn.style.color = '#fca5a5';
            } catch (err) {
                console.error("Translation error:", err);
                alert("Translation failed. Please check your internet connection or try again!");
                translateBtn.innerHTML = origHtml;
                translateBtn.style.color = origColor;
            } finally {
                translateBtn.disabled = false;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Rename title button
    const editTitleBtn = document.getElementById('ov-btn-edit-title');
    if (editTitleBtn) {
        editTitleBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            const newTitle = prompt("Enter new title for this game:", currentGame.title || currentGame.raw_name);
            if (newTitle && newTitle.trim() !== "" && newTitle !== currentGame.title) {
                try {
                    const res = await fetch(`${API_BASE}/api/games/${currentGame.id}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ title: newTitle.trim() })
                    });
                    if (res.ok) {
                        const updatedGame = await res.json();
                        currentGame.title = updatedGame.title;
                        document.getElementById('ov-title').textContent = currentGame.title;
                        loadGames(); // Refresh grid in background
                    }
                } catch(e) {
                    alert("Failed to update title.");
                }
            }
        });
    }

    // Fix Titles & Refetch Metadata button in Settings -> Media
    const fixMetaBtn = document.getElementById('btn-fix-metadata');
    if (fixMetaBtn) {
        fixMetaBtn.addEventListener('click', async () => {
            await startSettingsTrackedJob('fix-metadata');
        });
    }

    // F95zone Rematch button in Settings -> Media
    const rematchBtn = document.getElementById('btn-rematch-f95');
    if (rematchBtn) {
        rematchBtn.addEventListener('click', async () => {
            await startSettingsTrackedJob('rematch-f95zone');
        });
    }

    const flushMetaBtn = document.getElementById('btn-flush-metadata');
    if (flushMetaBtn) {
        flushMetaBtn.addEventListener('click', async () => {
            if (!confirmFlushAllMetadata()) return;
            await startSettingsTrackedJob('flush-metadata');
        });
    }

    // === GAME SOURCE ACTION BUTTONS (in overlay) ===

    const ignoreBtn = document.getElementById('ov-btn-ignore');
    if (ignoreBtn) {
        ignoreBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            if (!confirm(`Are you sure you want to completely hide "${currentGame.title}" from your library? (This is useful for mods or junk folders)`)) return;
            
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/ignore`, {
                    method: 'PATCH',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({is_ignored: true})
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || "Server error");
                }
                document.getElementById('overview-modal').style.display = 'none';
                loadGames();
                fetchStats();
            } catch (err) {
                alert("Failed to ignore game: " + err.message);
            }
        });
    }

    // Interactive Search & Picker Functions
    function showSourceModalBackdrop(show) {
        const bd = document.getElementById('ov-source-modal-backdrop');
        if (bd) bd.style.display = show ? 'block' : 'none';
    }

    // Wishlist Modal Functions & Listeners
    let currentWishlistPlatform = 'all';

    function openWishlistModal(defaultQuery = "") {
        const modal = document.getElementById('ov-wishlist-modal');
        const urlInput = document.getElementById('wishlist-url-input');
        const searchInput = document.getElementById('wishlist-search-input');
        const resultsDiv = document.getElementById('wishlist-search-results');
        const statusDiv = document.getElementById('wishlist-search-status');
        if (!modal) return;

        const formSearch = document.getElementById('ov-interactive-search-form');
        const formLink = document.getElementById('ov-link-form');
        const formLocal = document.getElementById('ov-local-link-form');
        if (formSearch) formSearch.style.display = 'none';
        if (formLink) formLink.style.display = 'none';
        if (formLocal) formLocal.style.display = 'none';

        modal.style.display = 'block';
        showSourceModalBackdrop(true);
        currentWishlistPlatform = getPreferredSourcePlatform();

        const chipsDiv = document.getElementById('wishlist-search-platforms');
        if (chipsDiv) {
            chipsDiv.querySelectorAll('.platform-chip').forEach(chip => {
                const isMatch = chip.dataset.platform === currentWishlistPlatform;
                chip.classList.toggle('active', isMatch);
                chip.style.borderColor = isMatch ? '#38bdf8' : 'rgba(255,255,255,0.1)';
                chip.style.background = isMatch ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)';
                chip.style.color = isMatch ? '#fff' : '#94a3b8';
            });
        }

        if (urlInput) urlInput.value = '';
        if (searchInput) searchInput.value = defaultQuery || '';
        if (resultsDiv) resultsDiv.innerHTML = '';
        if (statusDiv) {
            statusDiv.style.display = 'none';
            statusDiv.textContent = '';
        }

        if (defaultQuery && defaultQuery.trim().length >= 2) {
            doWishlistSearch(defaultQuery.trim());
        } else if (searchInput) {
            searchInput.focus();
        } else if (urlInput) {
            urlInput.focus();
        }
    }

    async function openWishlistBrowserSearch(query = "") {
        const searchInput = document.getElementById('wishlist-search-input');
        const resolvedQuery = (query || searchInput?.value || '').trim();
        if (resolvedQuery.length < 2) {
            if (searchInput) searchInput.focus();
            alert("Enter at least 2 characters to search in your browser.");
            return;
        }

        const browserUrl = buildSourceBrowserSearchUrl(resolvedQuery, currentWishlistPlatform);
        if (browserUrl) {
            await openExternalUrl(browserUrl);
        }
    }

    async function doWishlistSearch(query) {
        const resultsDiv = document.getElementById('wishlist-search-results');
        const statusDiv = document.getElementById('wishlist-search-status');
        if (!resultsDiv || !statusDiv) return;

        statusDiv.style.display = 'block';
        statusDiv.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"></i> Searching ${currentWishlistPlatform.toUpperCase()} for "${query}"...`;
        if (window.lucide) lucide.createIcons();
        resultsDiv.innerHTML = '';

        try {
            const res = await fetch(`${API_BASE}/api/search/universal?query=${encodeURIComponent(query)}&platform=${currentWishlistPlatform}`);
            const data = await res.json();
            
            if (!data.results || data.results.length === 0) {
                statusDiv.innerHTML = `No matching entries found on ${currentWishlistPlatform.toUpperCase()} for "${query}". Try different keywords or switch tabs!`;
                return;
            }

            statusDiv.style.display = 'none';
            resultsDiv.innerHTML = data.results.map(item => `
                <div style="display:flex; align-items:center; justify-content:space-between; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); padding: 12px 16px; border-radius: 10px; gap: 16px;">
                    <div style="display:flex; align-items:center; gap: 14px; flex: 1; min-width: 0;">
                        ${item.cover ? `<img src="${item.cover}" style="width: 48px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" onerror="this.style.display='none'">` : `<div style="width:48px;height:60px;background:rgba(255,255,255,0.05);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><i data-lucide="gamepad-2" style="width:24px;height:24px;color:#64748b;"></i></div>`}
                        <div style="min-width: 0; flex: 1;">
                            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                                <span class="pill-primary" style="font-size:0.7rem; padding:2px 8px;">${(item.source_type || 'unknown').toUpperCase()}</span>
                                <span style="font-weight: 700; font-size: 0.95rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.title}">${item.title}</span>
                            </div>
                            <div style="font-size: 0.8rem; color: #94a3b8; display:flex; gap: 12px;">
                                <span><i data-lucide="user" style="width:13px;height:13px;display:inline-block;vertical-align:middle;"></i> ${item.creator || 'Unknown'}</span>
                                ${item.version ? `<span><i data-lucide="tag" style="width:13px;height:13px;display:inline-block;vertical-align:middle;"></i> ${item.version}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex; gap:8px; flex-shrink: 0;">
                        <button class="btn-primary btn-wishlist-select-item" data-url="${item.url}" data-title="${encodeURIComponent(item.title || '')}" data-creator="${encodeURIComponent(item.creator || '')}" data-cover="${encodeURIComponent(item.cover || '')}" data-version="${encodeURIComponent(item.version || '')}" title="Add to Wishlist" style="padding: 8px 16px; font-size: 0.85rem; font-weight: 700; display: flex; align-items: center; gap: 6px; border-radius: 6px; cursor: pointer;">
                            <i data-lucide="plus-circle" style="width:16px;height:16px;fill:#fff;"></i>
                            <span>Add to Wishlist</span>
                        </button>
                    </div>
                </div>
            `).join('');

            if (window.lucide) lucide.createIcons();

            resultsDiv.querySelectorAll('.btn-wishlist-select-item').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const url = btn.dataset.url;
                    if (!url) return;
                    await submitWishlistItem(
                        url,
                        decodeURIComponent(btn.dataset.title || ''),
                        decodeURIComponent(btn.dataset.cover || ''),
                        decodeURIComponent(btn.dataset.creator || ''),
                        decodeURIComponent(btn.dataset.version || ''),
                        btn
                    );
                });
            });

            const fallbackWishlistSearchHtml = `
                <div style="text-align:center; margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1);">
                    <button type="button" class="btn-secondary btn-wishlist-fallback-search" style="font-size:0.75rem; padding: 6px 12px; display:inline-flex; align-items:center; gap:6px;">
                        <i data-lucide="external-link" style="width:13px;height:13px;"></i> Search ${currentWishlistPlatform.toUpperCase()} in Browser
                    </button>
                </div>
            `;
            resultsDiv.insertAdjacentHTML('beforeend', fallbackWishlistSearchHtml);
            if (window.lucide) lucide.createIcons();
            const extBtn = resultsDiv.querySelector('.btn-wishlist-fallback-search');
            if (extBtn) {
                extBtn.addEventListener('click', async () => {
                    await openWishlistBrowserSearch(query);
                });
            }
        } catch (err) {
            statusDiv.innerHTML = `Error searching sources: ${err.message}`;
        }
    }

    async function submitWishlistItem(url, title = null, cover = null, creator = null, version = null, btnEl = null) {
        if (!url) { alert("Please enter or select a valid URL."); return; }
        
        let originalHtml = "";
        if (btnEl) {
            originalHtml = btnEl.innerHTML;
            btnEl.disabled = true;
            btnEl.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px;height:14px;"></i> <span>Adding...</span>`;
            if (window.lucide) lucide.createIcons();
        }

        try {
            const payload = {
                url: url,
                title: title || null,
                cover_url: cover || null,
                developer: creator || null,
                version: version || null
            };
            const res = await fetch(`${API_BASE}/api/games/wishlist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
            if (res.ok) {
                alert("Added to Wishlist instantly! Cover and metadata are downloading in the background.");
                const formWishlist = document.getElementById('ov-wishlist-modal');
                if (formWishlist) formWishlist.style.display = 'none';
                showSourceModalBackdrop(false);
                if (typeof loadGames === 'function') loadGames();
                if (typeof fetchStats === 'function') fetchStats();
            } else {
                const data = await res.json();
                alert(data.detail || "Failed to add to wishlist.");
                if (btnEl) {
                    btnEl.disabled = false;
                    btnEl.innerHTML = originalHtml;
                    if (window.lucide) lucide.createIcons();
                }
            }
        } catch (e) {
            alert("Network error while adding to wishlist.");
            if (btnEl) {
                btnEl.disabled = false;
                btnEl.innerHTML = originalHtml;
                if (window.lucide) lucide.createIcons();
            }
        }
    }

    const closeWishlistBtn = document.getElementById('wishlist-btn-close');
    if (closeWishlistBtn) {
        closeWishlistBtn.addEventListener('click', () => {
            const form = document.getElementById('ov-wishlist-modal');
            if (form) form.style.display = 'none';
            showSourceModalBackdrop(false);
        });
    }

    const addWishlistUrlBtn = document.getElementById('wishlist-btn-add-url');
    const wishlistUrlInput = document.getElementById('wishlist-url-input');
    if (addWishlistUrlBtn && wishlistUrlInput) {
        addWishlistUrlBtn.addEventListener('click', () => {
            const url = wishlistUrlInput.value.trim();
            if (url) submitWishlistItem(url, null, null, null, null, addWishlistUrlBtn);
        });
        wishlistUrlInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                const url = wishlistUrlInput.value.trim();
                if (url) submitWishlistItem(url, null, null, null, null, addWishlistUrlBtn);
            }
        });
    }

    const doWishlistSearchBtn = document.getElementById('wishlist-btn-do-search');
    const wishlistSearchInput = document.getElementById('wishlist-search-input');
    if (doWishlistSearchBtn && wishlistSearchInput) {
        doWishlistSearchBtn.addEventListener('click', () => {
            if (wishlistSearchInput.value.trim().length >= 2) {
                doWishlistSearch(wishlistSearchInput.value.trim());
            }
        });
        wishlistSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && wishlistSearchInput.value.trim().length >= 2) {
                doWishlistSearch(wishlistSearchInput.value.trim());
            }
        });
    }

    const wishlistBrowserSearchBtn = document.getElementById('wishlist-btn-browser-search');
    if (wishlistBrowserSearchBtn) {
        wishlistBrowserSearchBtn.addEventListener('click', async () => {
            await openWishlistBrowserSearch();
        });
    }

    const wishlistPlatformsDiv = document.getElementById('wishlist-search-platforms');
    if (wishlistPlatformsDiv) {
        wishlistPlatformsDiv.querySelectorAll('.platform-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                currentWishlistPlatform = chip.dataset.platform || 'all';
                wishlistPlatformsDiv.querySelectorAll('.platform-chip').forEach(c => {
                    const isMatch = c.dataset.platform === currentWishlistPlatform;
                    c.classList.toggle('active', isMatch);
                    c.style.borderColor = isMatch ? '#38bdf8' : 'rgba(255,255,255,0.1)';
                    c.style.background = isMatch ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)';
                    c.style.color = isMatch ? '#fff' : '#94a3b8';
                });
                const wishlistSearchInput = document.getElementById('wishlist-search-input');
                if (wishlistSearchInput && wishlistSearchInput.value.trim().length >= 2) {
                    doWishlistSearch(wishlistSearchInput.value.trim());
                }
            });
        });
    }

    let currentSearchPlatform = 'all';

    function openInteractiveSearch(queryText, defaultPlatform = '') {
        const form = document.getElementById('ov-interactive-search-form');
        const input = document.getElementById('ov-interactive-search-input');
        const resultsDiv = document.getElementById('ov-interactive-search-results');
        const statusDiv = document.getElementById('ov-interactive-search-status');
        if (!form || !input || !resultsDiv) return;

        const linkFormEl = document.getElementById('ov-link-form');
        const localFormEl = document.getElementById('ov-local-link-form');
        const wishlistModalEl = document.getElementById('ov-wishlist-modal');
        if (linkFormEl) linkFormEl.style.display = 'none';
        if (localFormEl) localFormEl.style.display = 'none';
        if (wishlistModalEl) wishlistModalEl.style.display = 'none';

        form.style.display = 'block';
        showSourceModalBackdrop(true);
        currentSearchPlatform = defaultPlatform || getPreferredSourcePlatform();

        const chipsDiv = document.getElementById('ov-interactive-search-platforms');
        if (chipsDiv) {
            chipsDiv.querySelectorAll('.platform-chip').forEach(chip => {
                const isMatch = chip.dataset.platform === currentSearchPlatform;
                chip.classList.toggle('active', isMatch);
                chip.style.borderColor = isMatch ? '#38bdf8' : 'rgba(255,255,255,0.1)';
                chip.style.background = isMatch ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)';
                chip.style.color = isMatch ? '#fff' : '#94a3b8';
            });
        }
        
        let clean = (queryText || "").replace(/(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|\b\d+\b|windows|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*/gi, '').replace(/[_\-\.\[\]\(\)\{\}]/g, ' ').trim();
        input.value = clean || queryText || "";
        input.focus();
        
        if (input.value.trim().length >= 2) {
            doInteractiveSearch(input.value.trim());
        }
    }

    async function doInteractiveSearch(query) {
        const resultsDiv = document.getElementById('ov-interactive-search-results');
        const statusDiv = document.getElementById('ov-interactive-search-status');
        if (!resultsDiv || !statusDiv) return;

        statusDiv.style.display = 'block';
        statusDiv.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;"></i> Searching ${currentSearchPlatform.toUpperCase()} for "${query}"...`;
        if (window.lucide) lucide.createIcons();
        resultsDiv.innerHTML = '';

        try {
            const res = await fetch(`${API_BASE}/api/search/universal?query=${encodeURIComponent(query)}&platform=${currentSearchPlatform}`);
            const data = await res.json();
            
            if (!data.results || data.results.length === 0) {
                statusDiv.innerHTML = `No matching entries found on ${currentSearchPlatform.toUpperCase()} for "${query}". Try different keywords or switch tabs!`;
                return;
            }

            statusDiv.style.display = 'none';
            resultsDiv.innerHTML = data.results.map(item => `
                <div style="display:flex; align-items:center; justify-content:space-between; background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08); padding: 12px 16px; border-radius: 10px; gap: 16px;">
                    <div style="display:flex; align-items:center; gap: 14px; flex: 1; min-width: 0;">
                        ${item.cover ? `<img src="${item.cover}" style="width: 48px; height: 60px; object-fit: cover; border-radius: 6px; flex-shrink: 0;" onerror="this.style.display='none'">` : `<div style="width:48px;height:60px;background:rgba(255,255,255,0.05);border-radius:6px;flex-shrink:0;display:flex;align-items:center;justify-content:center;"><i data-lucide="gamepad-2" style="width:24px;height:24px;color:#64748b;"></i></div>`}
                        <div style="min-width: 0; flex: 1;">
                            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                                <span class="pill-primary" style="font-size:0.7rem; padding:2px 8px;">${(item.source_type || 'unknown').toUpperCase()}</span>
                                <span style="font-weight: 700; font-size: 0.95rem; color: #f8fafc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${item.title}">${item.title}</span>
                            </div>
                            <div style="font-size: 0.8rem; color: #94a3b8; display:flex; gap: 12px;">
                                <span><i data-lucide="user" style="width:13px;height:13px;display:inline-block;vertical-align:middle;"></i> ${item.creator || 'Unknown'}</span>
                                ${item.version ? `<span><i data-lucide="tag" style="width:13px;height:13px;display:inline-block;vertical-align:middle;"></i> ${item.version}</span>` : ''}
                            </div>
                        </div>
                    </div>
                    <div style="display:flex; gap:8px; flex-shrink: 0;">
                        <button type="button" class="btn-primary btn-src-select-link" data-url="${item.url}" data-title="${encodeURIComponent(item.title || '')}" data-creator="${encodeURIComponent(item.creator || '')}" data-cover="${encodeURIComponent(item.cover || '')}" data-version="${encodeURIComponent(item.version || '')}" title="Link selected source" style="padding: 8px 16px; font-size: 0.85rem; font-weight: 700; display: flex; align-items: center; gap: 6px; border-radius: 6px; cursor: pointer;">
                            <i data-lucide="link-2" style="width:14px;height:14px;"></i>
                            <span>Link</span>
                        </button>
                    </div>
                </div>
            `).join('');

            if (window.lucide) lucide.createIcons();

            resultsDiv.querySelectorAll('.btn-src-select-link').forEach(btn => {
                btn.addEventListener('click', async () => {
                    const url = btn.dataset.url;
                    if (!url || !currentGame) return;

                    const originalHtml = btn.innerHTML;
                    btn.disabled = true;
                    btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px;height:14px;"></i>`;
                    if (window.lucide) lucide.createIcons();

                    try {
                        const payload = {
                            source_url: url,
                            make_preferred: false,
                            title: decodeURIComponent(btn.dataset.title || ''),
                            developer: decodeURIComponent(btn.dataset.creator || ''),
                            cover_url: decodeURIComponent(btn.dataset.cover || ''),
                            version: decodeURIComponent(btn.dataset.version || '')
                        };
                        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/sources`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });
                        const data = await res.json();
                        if (!res.ok) throw new Error(data.detail || "Failed to link source");
                        currentGame = data.game;

                        document.getElementById('ov-interactive-search-form').style.display = 'none';
                        const backdrop = document.getElementById('ov-source-modal-backdrop');
                        if (backdrop) backdrop.style.display = 'none';
                        renderOverview(currentGame);
                        await loadGames();
                        if (data.warning) alert(data.warning);
                    } catch (err) {
                        alert(err.message || "Failed to link selected source.");
                        btn.disabled = false;
                        btn.innerHTML = originalHtml;
                        if (window.lucide) lucide.createIcons();
                    }
                });
            });

            const fallbackSearchHtml = `
                <div style="text-align:center; margin-top: 10px; padding-top: 8px; border-top: 1px dashed rgba(255,255,255,0.1);">
                    <button type="button" class="btn-secondary btn-ext-fallback-search" style="font-size:0.75rem; padding: 6px 12px; display:inline-flex; align-items:center; gap:6px;">
                        <i data-lucide="external-link" style="width:13px;height:13px;"></i> Search ${currentSearchPlatform.toUpperCase()} in Browser
                    </button>
                </div>
            `;
            resultsDiv.insertAdjacentHTML('beforeend', fallbackSearchHtml);
            if (window.lucide) lucide.createIcons();
            const extBtn = resultsDiv.querySelector('.btn-ext-fallback-search');
            if (extBtn) {
                extBtn.addEventListener('click', async () => {
                    const browserUrl = buildSourceBrowserSearchUrl(query, currentSearchPlatform);
                    if (browserUrl) await openExternalUrl(browserUrl);
                });
            }
        } catch (err) {
            statusDiv.innerHTML = `Error searching sources: ${err.message}`;
        }
    }

    const sourceModalBackdrop = document.getElementById('ov-source-modal-backdrop');
    if (sourceModalBackdrop) {
        sourceModalBackdrop.addEventListener('click', () => {
            const formSearch = document.getElementById('ov-interactive-search-form');
            const formLink = document.getElementById('ov-link-form');
            const formLocal = document.getElementById('ov-local-link-form');
            const formWishlist = document.getElementById('ov-wishlist-modal');
            if (formSearch) formSearch.style.display = 'none';
            if (formLink) formLink.style.display = 'none';
            if (formLocal) formLocal.style.display = 'none';
            if (formWishlist) formWishlist.style.display = 'none';
            showSourceModalBackdrop(false);
        });
    }

    const closeInteractiveSearchBtn = document.getElementById('ov-btn-close-interactive-search');
    if (closeInteractiveSearchBtn) {
        closeInteractiveSearchBtn.addEventListener('click', () => {
            const form = document.getElementById('ov-interactive-search-form');
            if (form) form.style.display = 'none';
            showSourceModalBackdrop(false);
        });
    }

    const doInteractiveSearchBtn = document.getElementById('ov-btn-do-interactive-search');
    const interactiveSearchInput = document.getElementById('ov-interactive-search-input');
    if (doInteractiveSearchBtn && interactiveSearchInput) {
        doInteractiveSearchBtn.addEventListener('click', () => {
            if (interactiveSearchInput.value.trim().length >= 2) {
                doInteractiveSearch(interactiveSearchInput.value.trim());
            }
        });
        interactiveSearchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && interactiveSearchInput.value.trim().length >= 2) {
                doInteractiveSearch(interactiveSearchInput.value.trim());
            }
        });
    }

    const platformsDiv = document.getElementById('ov-interactive-search-platforms');
    if (platformsDiv) {
        platformsDiv.querySelectorAll('.platform-chip').forEach(chip => {
            chip.addEventListener('click', () => {
                currentSearchPlatform = chip.dataset.platform || 'all';
                platformsDiv.querySelectorAll('.platform-chip').forEach(c => {
                    const isMatch = c.dataset.platform === currentSearchPlatform;
                    c.classList.toggle('active', isMatch);
                    c.style.borderColor = isMatch ? '#38bdf8' : 'rgba(255,255,255,0.1)';
                    c.style.background = isMatch ? 'rgba(56, 189, 248, 0.2)' : 'rgba(255,255,255,0.05)';
                    c.style.color = isMatch ? '#fff' : '#94a3b8';
                });
                const interactiveSearchInput = document.getElementById('ov-interactive-search-input');
                if (interactiveSearchInput && interactiveSearchInput.value.trim().length >= 2) {
                    doInteractiveSearch(interactiveSearchInput.value.trim());
                }
            });
        });
    }

    // 1. "Wrong Data / Re-scrape": Clears source and opens interactive search list picker
    const markWrongBtn = document.getElementById('ov-btn-mark-wrong');
    if (markWrongBtn) {
        markWrongBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            if (!confirm(`Clear scraped metadata for "${currentGame.title || currentGame.raw_name}" and search for the correct game?`)) return;
            
            markWrongBtn.disabled = true;
            markWrongBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Clearing...</span>`;
            if (window.lucide) lucide.createIcons();
            
            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/clear-source`, { method: 'POST' });
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await loadGames();
                openInteractiveSearch(currentGame.title || currentGame.raw_name, getPreferredSourcePlatform());
            } catch (err) {
                alert("Failed to clear source data.");
            } finally {
                markWrongBtn.disabled = false;
                markWrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>Clear Data</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // 2. Shared Search Button: Opens the interactive search modal across all supported sources
    const searchSourceBtn = document.getElementById('ov-btn-search-source');
    if (searchSourceBtn) {
        searchSourceBtn.addEventListener('click', () => {
            if (!currentGame) return;
            openInteractiveSearch(currentGame.title || currentGame.raw_name, 'all');
        });
    }

    // 3. "Link Source URL": Toggle the manual URL input form
    const linkSourceBtn = document.getElementById('ov-btn-link-source');
    const linkForm = document.getElementById('ov-link-form');
    const cancelLinkBtn = document.getElementById('ov-btn-cancel-link');
    const submitLinkBtn = document.getElementById('ov-btn-submit-link');
    const linkInput = document.getElementById('ov-link-url-input');
    const localLinkBtn = document.getElementById('ov-btn-link-local');
    const pickFolderArchiveBtn = document.getElementById('ov-btn-link-folder-archive');
    const localLinkForm = document.getElementById('ov-local-link-form');
    const localLinkSearch = document.getElementById('ov-local-link-search');
    const localLinkSelect = document.getElementById('ov-local-link-select');
    const cancelLocalLinkBtn = document.getElementById('ov-btn-cancel-local-link');
    const submitLocalLinkBtn = document.getElementById('ov-btn-submit-local-link');
    let localLinkSearchTimer = null;

    const closeLinkFormBtn = document.getElementById('ov-btn-close-link-form');
    if (closeLinkFormBtn && linkForm) {
        closeLinkFormBtn.addEventListener('click', () => {
            linkForm.style.display = 'none';
            showSourceModalBackdrop(false);
        });
    }

    if (linkSourceBtn && linkForm) {
        linkSourceBtn.addEventListener('click', () => {
            if (localLinkForm) localLinkForm.style.display = 'none';
            const shouldShow = linkForm.style.display === 'none';
            linkForm.style.display = shouldShow ? 'block' : 'none';
            showSourceModalBackdrop(shouldShow);
            if (shouldShow) {
                linkInput.value = '';
                linkInput.focus();
            }
        });
    }

    if (cancelLinkBtn && linkForm) {
        cancelLinkBtn.addEventListener('click', () => {
            linkForm.style.display = 'none';
            linkInput.value = '';
            showSourceModalBackdrop(false);
        });
    }

    if (submitLinkBtn) {
        submitLinkBtn.addEventListener('click', async () => {
            if (!currentGame) return;
            const url = linkInput.value.trim();
            if (!url) { alert("Please paste a URL or DLsite code (e.g. RJ01234567)"); return; }

            submitLinkBtn.disabled = true;
            submitLinkBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Linking...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/link`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ source_url: url })
                });
                
                if (!res.ok) {
                    const err = await res.json();
                    alert(err.detail || "Failed to link source.");
                    return;
                }
                
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await loadGames();
                linkForm.style.display = 'none';
                linkInput.value = '';
                showSourceModalBackdrop(false);
                if (data.warning) alert(data.warning);
            } catch (err) {
                alert("Failed to link source. Check the URL and try again.");
            } finally {
                submitLinkBtn.disabled = false;
                submitLinkBtn.innerHTML = `<i data-lucide="check"></i> <span>Link & Fetch</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    if (pickFolderArchiveBtn) {
        pickFolderArchiveBtn.addEventListener('click', async () => {
            if (!currentGame || currentGame.file_type !== 'wishlist') return;
            await window.pickWishlistLocalPath(currentGame.id, currentGame.title);
        });
    }

    async function loadWishlistLocalCandidates(searchValue = '') {
        if (!currentGame || currentGame.file_type !== 'wishlist' || !localLinkSelect) return;
        localLinkSelect.innerHTML = '<option value="">Loading local entries...</option>';
        try {
            const query = searchValue.trim()
                ? `?search=${encodeURIComponent(searchValue.trim())}`
                : '';
            const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/linkable-local${query}`);
            if (!res.ok) {
                throw new Error('Failed to load local link candidates');
            }
            const items = await res.json();
            if (!items.length) {
                localLinkSelect.innerHTML = '<option value="">No matching local entries found</option>';
                return;
            }
            localLinkSelect.innerHTML = items.map(item => {
                const pathTail = item.folder_path || '';
                const sourceLabel = item.source_type && item.source_type !== 'unknown'
                    ? ` | ${item.source_type.toUpperCase()}`
                    : '';
                return `<option value="${item.id}">${item.title} (${item.file_type.toUpperCase()})${sourceLabel} - ${pathTail}</option>`;
            }).join('');
        } catch (err) {
            localLinkSelect.innerHTML = '<option value="">Failed to load local entries</option>';
        }
    }

    const closeLocalLinkFormBtn = document.getElementById('ov-btn-close-local-link-form');
    if (closeLocalLinkFormBtn && localLinkForm) {
        closeLocalLinkFormBtn.addEventListener('click', () => {
            localLinkForm.style.display = 'none';
            showSourceModalBackdrop(false);
        });
    }

    if (localLinkBtn && localLinkForm) {
        localLinkBtn.addEventListener('click', async () => {
            if (linkForm) linkForm.style.display = 'none';
            const shouldShow = localLinkForm.style.display === 'none';
            localLinkForm.style.display = shouldShow ? 'block' : 'none';
            showSourceModalBackdrop(shouldShow);
            if (!shouldShow) return;
            if (localLinkSearch) localLinkSearch.value = currentGame?.title || '';
            await loadWishlistLocalCandidates(localLinkSearch?.value || currentGame?.title || '');
            if (localLinkSearch) localLinkSearch.focus();
        });
    }

    if (localLinkSearch) {
        localLinkSearch.addEventListener('input', () => {
            clearTimeout(localLinkSearchTimer);
            localLinkSearchTimer = setTimeout(() => {
                loadWishlistLocalCandidates(localLinkSearch.value || '');
            }, 180);
        });
    }

    if (cancelLocalLinkBtn && localLinkForm) {
        cancelLocalLinkBtn.addEventListener('click', () => {
            localLinkForm.style.display = 'none';
            if (localLinkSearch) localLinkSearch.value = '';
            if (localLinkSelect) localLinkSelect.innerHTML = '';
            showSourceModalBackdrop(false);
        });
    }

    if (submitLocalLinkBtn) {
        submitLocalLinkBtn.addEventListener('click', async () => {
            if (!currentGame || currentGame.file_type !== 'wishlist' || !localLinkSelect) return;
            const targetId = parseInt(localLinkSelect.value || '', 10);
            if (!targetId) {
                alert('Please select a scanned local entry to link.');
                return;
            }

            submitLocalLinkBtn.disabled = true;
            submitLocalLinkBtn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Linking...</span>`;
            if (window.lucide) lucide.createIcons();

            try {
                const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/link-local`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ target_game_id: targetId })
                });
                if (!res.ok) {
                    const err = await res.json();
                    throw new Error(err.detail || 'Failed to link wishlist item to local entry');
                }
                const data = await res.json();
                currentGame = data.game;
                renderOverview(currentGame);
                await Promise.allSettled([loadGames(), fetchStats(), fetchTags()]);
                if (localLinkForm) localLinkForm.style.display = 'none';
                if (localLinkSearch) localLinkSearch.value = '';
                if (localLinkSelect) localLinkSelect.innerHTML = '';
                showSourceModalBackdrop(false);
            } catch (err) {
                alert(`Failed to link wishlist item: ${err.message}`);
            } finally {
                submitLocalLinkBtn.disabled = false;
                submitLocalLinkBtn.innerHTML = `<i data-lucide="link-2"></i> <span>Link Wishlist to Local Game</span>`;
                if (window.lucide) lucide.createIcons();
            }
        });
    }

    // Allow Enter key to submit link form
    if (linkInput) {
        linkInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && submitLinkBtn) {
                submitLinkBtn.click();
            }
        });
    }
}

async function triggerRescan(triggerButton = null) {
    const btn = triggerButton || document.getElementById('btn-add-game');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i>`;
        btn.disabled = true;
    }
    if (window.lucide) lucide.createIcons();
    
    try {
        const res = await fetch(`${API_BASE}/api/library/scan`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) {
            throw new Error(data.detail || 'Scan failed');
        }
        await fetchStats();
        await fetchTags();
        await loadGames();
        return true;
    } catch (err) {
        console.error("Scan failed", err);
        alert(`Failed to scan directory: ${err.message}`);
        return false;
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
        if (window.lucide) lucide.createIcons();
    }
}

function collectSettingsPayload() {
    return {
        games_dirs: getConfiguredGamesDirs(),
        archive_mode: document.getElementById('set-launch-archive-mode')?.value || 'explorer',
        startup_scan: !!document.getElementById('toggle-startup-scan')?.checked,
        automatic_game_update_checks: document.getElementById('toggle-automatic-game-update-checks')?.checked !== false,
        game_update_check_interval_days: Number(appSettings?.game_update_check_interval_days || 7),
        missing_grace_scans: parseInt(document.getElementById('setting-missing-grace-scans')?.value || '3', 10) || 3,
        preferred_source: document.getElementById('set-preferred-source')?.value || appSettings?.preferred_source || 'f95zone',
        theme_mode: sanitizeThemeMode(document.getElementById('set-theme-mode')?.value || appSettings?.theme_mode || 'midnight'),
        accent_color: sanitizeAccentColor(document.getElementById('set-accent-color')?.value || appSettings?.accent_color || 'blue'),
    };
}

function renderSettingsUpdateCheckSummary(settings = appSettings, jobState = null) {
    const lastCheck = document.getElementById('settings-update-last-check');
    const nextCheck = document.getElementById('settings-update-next-check');
    const updateCount = document.getElementById('settings-update-count');
    const jobSummary = document.getElementById('settings-update-job-summary');
    const enabled = settings?.automatic_game_update_checks !== false;
    const intervalDays = Math.max(1, Number(settings?.game_update_check_interval_days || 7));
    const lastValue = settings?.last_game_update_check_at;

    if (lastCheck) lastCheck.textContent = lastValue ? formatDateTime(lastValue) : 'Never';
    if (nextCheck) {
        if (!enabled) {
            nextCheck.textContent = 'Automatic checks disabled';
        } else if (!lastValue || Number.isNaN(new Date(lastValue).getTime())) {
            nextCheck.textContent = 'Eligible next launch';
        } else {
            const nextDate = new Date(new Date(lastValue).getTime() + intervalDays * 24 * 60 * 60 * 1000);
            nextCheck.textContent = nextDate <= new Date() ? 'Eligible next launch' : formatDateTime(nextDate.toISOString());
        }
    }
    if (updateCount) updateCount.textContent = String(lastKnownUpdateCount || 0);
    if (jobSummary && jobState) {
        const processed = Number(jobState.processed ?? jobState.completed ?? 0);
        const total = Number(jobState.total || 0);
        const updates = Number(jobState.updates_found || jobState.result?.updates_found || 0);
        const failures = Number(jobState.failed_count || jobState.result?.failed_count || 0);
        const unsupported = Number(jobState.unsupported_count || jobState.result?.unsupported_count || 0);
        jobSummary.textContent = `${processed} / ${total} checked · ${updates} updates · ${failures} failed · ${unsupported} unsupported`;
    }
}

async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (!res.ok) throw new Error('Failed to load settings');
        const settings = await res.json();
        const normalizedDirs = normalizeGamesDirList(settings.games_dirs || [settings.games_dir || settings.primary_games_dir || '']);
        settings.games_dirs = normalizedDirs;
        settings.games_dir = normalizedDirs[0] || settings.games_dir || settings.primary_games_dir || '';
        settings.primary_games_dir = settings.games_dir;
        appSettings = settings;
        renderLibraryDirectories();

        const archiveMode = document.getElementById('set-launch-archive-mode');
        if (archiveMode) archiveMode.value = settings.archive_mode || 'explorer';

        const startupScan = document.getElementById('toggle-startup-scan');
        if (startupScan) startupScan.checked = settings.startup_scan !== false;

        const automaticUpdateChecks = document.getElementById('toggle-automatic-game-update-checks');
        if (automaticUpdateChecks) automaticUpdateChecks.checked = settings.automatic_game_update_checks !== false;

        const missingGrace = document.getElementById('setting-missing-grace-scans');
        if (missingGrace) missingGrace.value = String(settings.missing_grace_scans || 3);

        const preferredSource = document.getElementById('set-preferred-source');
        if (preferredSource) preferredSource.value = settings.preferred_source || 'f95zone';

        const themeMode = sanitizeThemeMode(settings.theme_mode || 'midnight');
        const themeSelect = document.getElementById('set-theme-mode');
        if (themeSelect) themeSelect.value = themeMode;

        const accentColor = sanitizeAccentColor(settings.accent_color || 'blue');
        const accentSelect = document.getElementById('set-accent-color');
        if (accentSelect) accentSelect.value = accentColor;

        const extensionPath = document.getElementById('settings-extension-path');
        if (extensionPath) extensionPath.textContent = settings.extension_dir || 'Waiting for extension path...';
        const extensionPathMain = document.getElementById('ext-path-box');
        if (extensionPathMain) extensionPathMain.textContent = settings.extension_dir || 'Waiting for extension path...';

        applyAppearanceSettings(themeMode, accentColor);
        renderSettingsPreferredSource(settings.preferred_source || 'f95zone');
        renderSettingsUpdateCheckSummary(settings);
        renderExtensionBrowserGuide(currentExtensionBrowser);
        refreshSettingsMetadataQueue({ force: true }).catch((error) => {
            console.debug('Failed to refresh settings metadata queue', error);
        });
    } catch (error) {
        console.error('Failed to load settings', error);
    }
}

async function persistSettings() {
    const payload = collectSettingsPayload();

    const btn = document.getElementById('btn-save-preferences');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Saving Preferences...</span>`;
    }
    if (window.lucide) lucide.createIcons();

    try {
        const res = await fetch(`${API_BASE}/api/settings`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Unknown error');
        }
        const normalizedDirs = normalizeGamesDirList(data.settings?.games_dirs || payload.games_dirs);
        appSettings = {
            ...(data.settings || {}),
            games_dirs: normalizedDirs,
            games_dir: normalizedDirs[0] || data.settings?.games_dir || '',
            primary_games_dir: normalizedDirs[0] || data.settings?.primary_games_dir || '',
        };
        renderLibraryDirectories();
        await Promise.all([fetchStats(), fetchTags(), loadGames(), loadSettings(), refreshSettingsMetadataQueue({ force: true })]);
    } catch (error) {
        alert(`Error saving settings: ${error.message}`);
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
        if (window.lucide) lucide.createIcons();
    }
}

let lastKnownStatsTotal = null;
let lastKnownStatsWishlist = null;
let lastKnownUpdateCount = 0;
let isFetchingGames = false;

async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const stats = await res.json();
        
        const totalChanged = lastKnownStatsTotal !== null && lastKnownStatsTotal !== stats.total;
        const wishlistChanged = lastKnownStatsWishlist !== null && lastKnownStatsWishlist !== stats.wishlist;
        lastKnownStatsTotal = stats.total;
        lastKnownStatsWishlist = stats.wishlist;
        lastKnownUpdateCount = Number(stats.updates_available || 0);
        
        document.getElementById('stat-total-games').textContent = stats.total;
        document.getElementById('stat-wishlist-games').textContent = stats.wishlist;

        renderSettingsSummary(stats);
        renderSettingsUpdateCheckSummary(appSettings);

        if (stats.games_dir || Array.isArray(stats.games_dirs)) {
            const nextSettings = {
                ...(appSettings || {}),
                games_dir: stats.games_dir || getPrimaryGamesDir(appSettings),
                primary_games_dir: stats.primary_games_dir || stats.games_dir || getPrimaryGamesDir(appSettings),
                games_dirs: normalizeGamesDirList(stats.games_dirs || [stats.games_dir || getPrimaryGamesDir(appSettings)]),
            };
            appSettings = nextSettings;
            renderLibraryDirectories();
        }
        if (stats.extension_dir) {
            const extBox = document.getElementById('ext-path-box');
            if (extBox) extBox.textContent = stats.extension_dir;
            const onbBox = document.getElementById('onboarding-ext-path');
            if (onbBox) onbBox.textContent = stats.extension_dir;
            const settingsPath = document.getElementById('settings-extension-path');
            if (settingsPath) settingsPath.textContent = stats.extension_dir;
        }

        const settingsView = document.getElementById('view-settings');
        if (settingsView && settingsView.classList.contains('active')) {
            refreshSettingsMetadataQueue().catch((error) => {
                console.debug('Failed to refresh settings metadata queue', error);
            });
        }
        
        const onboardingDone = localStorage.getItem('xdir_onboarding_completed');
        if (!onboardingDone && stats.total === 0) {
            const onbModal = document.getElementById('onboarding-modal');
            if (onbModal) onbModal.style.display = 'flex';
        }
        
        if ((totalChanged || wishlistChanged) && !isFetchingGames && typeof loadGames === 'function') {
            loadGames();
        }
    } catch (e) {
        console.debug("Failed to fetch stats", e);
    }
}

async function fetchTags() {
    try {
        const res = await fetch(`${API_BASE}/api/tags/all`);
        const tags = await res.json();
        
        const select = document.getElementById('filter-tag');
        select.innerHTML = '<option value="all">All tags</option>';
        tags.forEach(t => {
            select.innerHTML += `<option value="${t}">${t}</option>`;
        });
    } catch (e) {
        console.error("Failed to load tags", e);
    }
}

function applyTilesPerRow(val) {
    const gridEl = document.getElementById('games-grid');
    if (!gridEl) return;
    if (val === 'auto' || !val) {
        gridEl.style.gridTemplateColumns = '';
    } else {
        const cols = parseInt(val, 10);
        if (cols >= 3 && cols <= 7) {
            gridEl.style.gridTemplateColumns = `repeat(${cols}, minmax(0, 1fr))`;
        } else {
            gridEl.style.gridTemplateColumns = '';
        }
    }
}

function resetFilters() {
    filterState = { preset: 'all', progress: 'all', updates: 'all', tag: 'all', source: 'all', search: '', sort: 'title' };
    document.getElementById('filter-preset').value = 'all';
    document.getElementById('filter-progress').value = 'all';
    document.getElementById('filter-updates').value = 'all';
    document.getElementById('filter-tag').value = 'all';
    document.getElementById('filter-source').value = 'all';
    document.getElementById('search-input').value = '';
    document.getElementById('clear-search').style.display = 'none';
    loadGames();
}

async function loadGames() {
    isFetchingGames = true;
    fetchStats();
    const grid = document.getElementById('games-grid');
    const empty = document.getElementById('empty-state');
    grid.innerHTML = '';
    empty.style.display = 'none';
    applyTilesPerRow(localStorage.getItem('xdir_tiles_per_row') || 'auto');

    let url = `${API_BASE}/api/games?sort=${encodeURIComponent(filterState.sort)}&`;
    if (filterState.preset !== 'all') {
        if (filterState.preset === 'exe' || filterState.preset === 'archive' || filterState.preset === 'available') {
            url += `status=${filterState.preset}&`;
        }
        if (filterState.preset === 'review') url += `identified=false&`;
    }
    if (filterState.progress !== 'all') url += `progress=${encodeURIComponent(filterState.progress)}&`;
    
    // Updates overrides
    if (filterState.updates === 'updates') url += `update=true&`;
    if (filterState.updates === 'wishlist') url += `status=wishlist&`;
    if (filterState.updates === 'missing_meta') url += `identified=false&`;
    
    if (filterState.tag !== 'all') url += `tag=${encodeURIComponent(filterState.tag)}&`;
    if (filterState.source !== 'all') url += `source=${encodeURIComponent(filterState.source)}&`;
    if (filterState.search) url += `search=${encodeURIComponent(filterState.search)}&`;

    try {
        const res = await fetch(url);
        let data = await res.json();
        
        // Filter out ignored games
        data = data.filter(g => !g.is_ignored);
        
        // Apply wishlist filter
        if (filterState.updates === 'wishlist') {
            data = data.filter(g => g.file_type === 'wishlist');
        } else {
            // By default, hide wishlist games from the main list unless specifically selected
            data = data.filter(g => g.file_type !== 'wishlist');
        }
        
        allGames = data;
        
        document.getElementById('results-count').textContent = `Showing ${allGames.length} titles`;

        if (allGames.length === 0) {
            empty.style.display = 'flex';
            return;
        }

        const fragment = document.createDocumentFragment();
        allGames.forEach(game => {
            fragment.appendChild(createGameCard(game));
        });
        grid.appendChild(fragment);

        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Failed to fetch games", err);
    } finally {
        isFetchingGames = false;
    }
}

function createGameCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    
    const isExe = game.file_type === 'exe' || game.file_type === 'folder';
    const isWishlist = game.file_type === 'wishlist';
    const escapedTitle = (game.title || '').replace(/'/g, "\\'");
    
    let pillClass = isExe ? 'pill-exe' : 'pill-archive';
    let pillText = isExe ? 'INSTALLED' : 'ARCHIVE';
    if (isWishlist) {
        pillClass = 'pill-wishlist';
        pillText = 'WISHLIST';
    }
    
    const sourceText = game.source_type !== 'unknown' ? game.source_type.toUpperCase() : 'LOCAL';
    
    const topPillHtml = `<span class="card-top-pill ${pillClass}" ${isWishlist ? 'style="background:rgba(96,165,250,0.15); color:#93c5fd; border-color:rgba(96,165,250,0.3);"' : ''}>${pillText}</span>`;
    const updatePillHtml = game.update_available
        ? `<button class="card-update-pill" type="button" title="Open version and update details">UPDATE AVAILABLE</button>`
        : '';

    const deleteWishlistHtml = isWishlist 
        ? `<button class="btn-card-delete-wishlist" title="Remove from Wishlist" style="position: absolute; top: 8px; right: 8px; z-index: 10; background: rgba(0, 0, 0, 0.85); border: 1px solid rgba(239, 68, 68, 0.4); color: #f87171; border-radius: 6px; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 4px 10px rgba(0,0,0,0.5); transition: all 0.2s;" onmouseover="this.style.background='rgba(239, 68, 68, 0.9)'; this.style.color='#ffffff';" onmouseout="this.style.background='rgba(0, 0, 0, 0.85)'; this.style.color='#f87171';" onclick="event.stopPropagation(); window.removeWishlistGame(${game.id}, '${escapedTitle}');">
               <i data-lucide="trash-2" style="width: 14px; height: 14px;"></i>
           </button>` 
        : '';

    const wishlistLocalActionsHtml = isWishlist
        ? `
            <div class="wishlist-link-row">
                <button class="wishlist-link-btn btn-card-link-folder-archive" title="Link this wishlist game to a local folder or archive" onclick="event.stopPropagation(); window.pickWishlistLocalPath(${game.id}, '${escapedTitle}');">
                    <i data-lucide="folder-archive"></i>
                    <span>Link Folder / Archive</span>
                </button>
            </div>
        `
        : '';

    const coverHtml = game.cover_url
        ? `<img src="${game.cover_url}" alt="${game.title}" class="card-img" loading="lazy" referrerpolicy="no-referrer" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
           <div class="card-fallback" style="display:none;">${game.title.charAt(0)}</div>`
        : `<div class="card-fallback">${game.title.charAt(0)}</div>`;

    // Tag chips (show up to 6)
    const allTagNames = [...(game.tags || []), ...(game.custom_tags || [])];
    const displayTags = allTagNames.slice(0, 6);
    const extraCount = allTagNames.length - displayTags.length;
    
    const tagsHtml = displayTags.map(t => `<span class="card-tag">${t}</span>`).join('') +
                     (extraCount > 0 ? `<span class="card-tag">+${extraCount}</span>` : '');

    card.innerHTML = `
        <div class="card-img-box" style="position: relative;">
            ${topPillHtml}
            ${updatePillHtml}
            ${deleteWishlistHtml}
            ${coverHtml}
        </div>
        <div class="card-info">
            <div class="card-title-row">
                <div class="card-title" title="${game.title}">${game.title}</div>
                <div class="card-rating-box">
                    <span>&#9733;</span>
                    <span>${normalizeRatingText(game.rating)}</span>
                </div>
            </div>
            <div class="card-sub-line">
                <span>by ${game.developer || 'Unknown Dev'}</span>
                <span class="card-separator" aria-hidden="true"></span>
                <span class="source-tag">${sourceText}</span>
            </div>
            <div class="card-tags-row">
                ${tagsHtml || `<span class="card-tag">${game.category || 'General'}</span>`}
            </div>
            ${wishlistLocalActionsHtml}
        </div>
    `;

    card.querySelector('.card-update-pill')?.addEventListener('click', (event) => {
        event.stopPropagation();
        openOverviewPage(game.id);
    });

    card.addEventListener('click', () => {
        const gridEl = document.getElementById('games-grid');
        if (gridEl) lastGridScrollPos = gridEl.scrollTop;
        openOverviewPage(game.id);
    });

    return card;
}

async function openOverviewPage(gameId) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}`);
        currentGame = await res.json();
        
        isTranslated = false;
        originalMetadata = null;
        const tBtn = document.getElementById('ov-btn-translate');
        if (tBtn) {
            tBtn.innerHTML = renderTranslateButtonLabel('translate');
            tBtn.style.color = '#93c5fd';
        }
        
        renderOverview(currentGame);
        document.getElementById('overview-modal').style.display = 'flex';
        if (window.lucide) lucide.createIcons();
    } catch (err) {
        console.error("Failed to load game details", err);
    }
}

function formatDateTime(value) {
    if (!value) return 'N/A';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return date.toLocaleString([], {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

const GAME_UPDATE_STATUS_PRESENTATION = {
    never: { label: 'Never checked', tone: 'muted' },
    checking: { label: 'Checking...', tone: 'checking' },
    up_to_date: { label: 'Up to date', tone: 'success' },
    update_available: { label: 'Update available', tone: 'warning' },
    local_version_unknown: { label: 'Local version unknown', tone: 'neutral' },
    remote_version_unavailable: { label: 'Remote version unavailable', tone: 'neutral' },
    version_differs: { label: 'Version differs', tone: 'neutral' },
    unsupported_source: { label: 'Unsupported source', tone: 'neutral' },
    failed: { label: 'Check failed', tone: 'error' },
};

function getPreferredGameUpdateSource(game) {
    const preferred = (game?.sources || []).find(source => source.is_preferred);
    if (preferred) return preferred;
    if (game?.source_url || game?.source_id) {
        return {
            source_type: game.source_type || 'unknown',
            source_url: game.source_url || null,
            source_id: game.source_id || null,
        };
    }
    return null;
}

function getGameUpdateExplanation(game, status) {
    const local = game.local_version || 'Unknown';
    const latest = game.latest_version || 'Unknown';
    const source = getPreferredGameUpdateSource(game);
    if (status === 'checking') return 'Reading the linked preferred source for an explicit version.';
    if (status === 'up_to_date') return `Your local version (${local}) matches or is newer than the latest linked release (${latest}).`;
    if (status === 'update_available') return `You have ${local}. The latest linked release is ${latest}.`;
    if (status === 'local_version_unknown') return `Latest linked release: ${latest}. Enter your installed version to compare.`;
    if (status === 'remote_version_unavailable') return 'The linked source did not expose a reliable version.';
    if (status === 'version_differs') return `Local: ${local}. Online: ${latest}. XDir cannot safely determine which is newer.`;
    if (status === 'unsupported_source') return `Automatic version checking is not currently available for ${(source?.source_type || 'this source').toUpperCase()}.`;
    if (status === 'failed') return 'The linked source could not be checked. Your previous version and update state were preserved.';
    return 'Check the linked source to compare your installed version with its latest explicit release.';
}

function renderGameUpdatePanel(game) {
    const status = game.last_update_check_status || 'never';
    const presentation = GAME_UPDATE_STATUS_PRESENTATION[status] || GAME_UPDATE_STATUS_PRESENTATION.never;
    const source = getPreferredGameUpdateSource(game);
    const statusEl = document.getElementById('ov-version-status');
    const explanation = document.getElementById('ov-version-explanation');
    const errorEl = document.getElementById('ov-version-error');
    const input = document.getElementById('ov-local-version-input');
    const sourceEl = document.getElementById('ov-preferred-update-source');
    const lastChecked = document.getElementById('ov-last-update-check-text');
    const checkButton = document.getElementById('ov-btn-check-update');
    const markButton = document.getElementById('ov-btn-mark-latest-installed');
    const openButton = document.getElementById('ov-btn-open-update-page');

    if (statusEl) {
        statusEl.textContent = presentation.label;
        statusEl.dataset.tone = presentation.tone;
    }
    if (explanation) explanation.textContent = getGameUpdateExplanation(game, status);
    if (input) input.value = game.local_version || '';
    if (sourceEl) sourceEl.textContent = source ? String(source.source_type || 'unknown').toUpperCase() : 'Unlinked';
    if (lastChecked) lastChecked.textContent = game.last_update_check_at ? formatDateTime(game.last_update_check_at) : 'Never';
    if (errorEl) {
        errorEl.textContent = game.last_update_check_error || '';
        errorEl.hidden = !game.last_update_check_error;
    }
    if (checkButton) {
        const checking = status === 'checking';
        checkButton.disabled = checking || !source;
        checkButton.innerHTML = checking
            ? `<i data-lucide="loader" class="spin"></i><span>Checking...</span>`
            : `<i data-lucide="search-check"></i><span>${game.last_update_check_at ? 'Check Again' : 'Check for Update'}</span>`;
    }
    if (markButton) {
        const canMarkLatestInstalled = Boolean(game.latest_version) && (
            game.update_available || ['local_version_unknown', 'version_differs'].includes(game.last_update_check_status)
        );
        markButton.hidden = !canMarkLatestInstalled;
    }
    if (openButton) openButton.hidden = !(game.update_available && source?.source_url);
}

function setOverviewVersionError(message = '') {
    const errorEl = document.getElementById('ov-version-error');
    if (!errorEl) return;
    errorEl.textContent = message;
    errorEl.hidden = !message;
}

async function refreshGameAfterVersionAction(game) {
    currentGame = game;
    renderOverview(currentGame);
    await Promise.allSettled([loadGames(), fetchStats()]);
}

async function checkCurrentGameForUpdate() {
    if (!currentGame) return;
    const button = document.getElementById('ov-btn-check-update');
    if (button?.disabled) return;
    if (button) {
        button.disabled = true;
        button.innerHTML = `<i data-lucide="loader" class="spin"></i><span>Checking...</span>`;
    }
    setOverviewVersionError('');
    if (window.lucide) lucide.createIcons();
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/check-update`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Update check failed');
        await refreshGameAfterVersionAction(data.game);
    } catch (error) {
        setOverviewVersionError(error.message || 'Update check failed');
    } finally {
        const currentButton = document.getElementById('ov-btn-check-update');
        if (currentButton) {
            currentButton.disabled = false;
            currentButton.innerHTML = `<i data-lucide="search-check"></i><span>${currentGame?.last_update_check_at ? 'Check Again' : 'Check for Update'}</span>`;
        }
        if (window.lucide) lucide.createIcons();
    }
}

async function saveCurrentGameLocalVersion() {
    if (!currentGame) return;
    const input = document.getElementById('ov-local-version-input');
    const button = document.getElementById('ov-btn-save-local-version');
    if (!input || !button || button.disabled) return;
    button.disabled = true;
    setOverviewVersionError('');
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/version`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ local_version: input.value }),
        });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Failed to save the local version');
        await refreshGameAfterVersionAction(data.game);
    } catch (error) {
        setOverviewVersionError(error.message || 'Failed to save the local version');
    } finally {
        button.disabled = false;
    }
}

async function markCurrentGameLatestInstalled() {
    if (!currentGame) return;
    const button = document.getElementById('ov-btn-mark-latest-installed');
    if (!button || button.disabled) return;
    button.disabled = true;
    setOverviewVersionError('');
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/mark-latest-installed`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Failed to mark the latest version as installed');
        await refreshGameAfterVersionAction(data.game);
    } catch (error) {
        setOverviewVersionError(error.message || 'Failed to mark the latest version as installed');
    } finally {
        button.disabled = false;
    }
}

function formatPlaytimeDuration(totalSeconds) {
    const seconds = Math.max(0, Number(totalSeconds || 0));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);

    if (hours <= 0) {
        return `${Math.max(0, minutes)}m`;
    }
    if (minutes <= 0) {
        return `${hours}h`;
    }
    return `${hours}h ${String(minutes).padStart(2, '0')}m`;
}

function guessEngineLabel(game) {
    const knownEngines = ['Ren\'Py', 'RPGM', 'Wolf RPG', 'Unity', 'HTML', 'Flash', 'VN', 'QTE'];
    const allTags = [...(game.tags || []), ...(game.custom_tags || [])];
    const match = knownEngines.find(engine => allTags.some(tag => String(tag).toLowerCase() === engine.toLowerCase()));
    if (match) return match;
    if (game.file_type === 'archive') return 'Archive Build';
    if (game.source_type && game.source_type !== 'unknown') return `${game.source_type.toUpperCase()} Linked`;
    return 'Standalone Build';
}

function updateOverviewCover(coverUrl, title = '') {
    const coverFrame = document.getElementById('ov-cover-frame');
    const coverImg = document.getElementById('ov-cover-image');
    const coverFallback = document.getElementById('ov-cover-fallback');
    if (!coverFrame || !coverImg || !coverFallback) return;

    const fallbackLabel = (title || '?').charAt(0).toUpperCase();
    coverFallback.textContent = fallbackLabel;
    coverImg.alt = title ? `${title} cover art` : 'Game cover';

    if (!coverUrl) {
        delete coverImg.dataset.pendingSrc;
        delete coverFrame.dataset.coverShape;
        coverImg.removeAttribute('src');
        coverImg.style.display = 'none';
        coverFallback.style.display = 'flex';
        return;
    }

    const nextUrl = String(coverUrl).trim();
    if (!nextUrl) {
        delete coverImg.dataset.pendingSrc;
        delete coverFrame.dataset.coverShape;
        coverImg.removeAttribute('src');
        coverImg.style.display = 'none';
        coverFallback.style.display = 'flex';
        return;
    }

    coverImg.dataset.pendingSrc = nextUrl;
    delete coverFrame.dataset.coverShape;

    const preloader = new Image();
    preloader.referrerPolicy = 'no-referrer';
    preloader.onload = () => {
        if (coverImg.dataset.pendingSrc !== nextUrl) return;
        if (preloader.naturalWidth && preloader.naturalHeight) {
            coverFrame.dataset.coverShape = preloader.naturalWidth >= preloader.naturalHeight ? 'landscape' : 'portrait';
        }
    };
    preloader.onerror = () => {
        // Ignore preloader errors so external CDN referrer checks on detached JS images do not break DOM image loading
    };
    preloader.src = nextUrl;

    coverImg.onload = () => {
        if (coverImg.dataset.pendingSrc !== nextUrl) return;
        if (coverImg.naturalWidth && coverImg.naturalHeight) {
            coverFrame.dataset.coverShape = coverImg.naturalWidth >= coverImg.naturalHeight ? 'landscape' : 'portrait';
        }
        coverImg.style.display = 'block';
        coverFallback.style.display = 'none';
    };
    coverImg.onerror = () => {
        if (coverImg.dataset.pendingSrc !== nextUrl) return;
        delete coverFrame.dataset.coverShape;
        coverImg.removeAttribute('src');
        coverImg.style.display = 'none';
        coverFallback.style.display = 'flex';
    };

    coverImg.referrerPolicy = 'no-referrer';
    coverImg.src = nextUrl;
    coverImg.style.display = 'block';
    coverFallback.style.display = 'none';
    if (coverImg.complete && coverImg.naturalWidth > 0) {
        coverFrame.dataset.coverShape = coverImg.naturalWidth >= coverImg.naturalHeight ? 'landscape' : 'portrait';
    }
}

function renderOverview(game) {
    currentGame = game;
    const isExe = game.file_type === 'exe' || game.file_type === 'folder';
    const isWishlist = game.file_type === 'wishlist';
    const currentIndex = allGames.findIndex(entry => entry.id === game.id);

    // Topbar
    document.getElementById('ov-title-top').textContent = game.title;
    document.getElementById('ov-page-num').textContent = currentIndex >= 0 ? `${currentIndex + 1} of ${allGames.length}` : 'Library view';
    
    // Hero
    const heroBg = document.getElementById('ov-hero-bg');
    if (game.cover_url) {
        heroBg.style.backgroundImage = `url('${game.cover_url}')`;
    } else {
        heroBg.style.backgroundImage = `none`;
        heroBg.style.backgroundColor = `#161820`;
    }
    
    document.getElementById('ov-title').textContent = game.title;
    document.getElementById('ov-dev').textContent = `Developer: ${game.developer || 'Unknown Dev / Circle'}`;
    document.getElementById('ov-engine').textContent = `Engine: ${guessEngineLabel(game)}`;
    
    document.getElementById('ov-badge-update').style.display = game.update_available ? 'inline-block' : 'none';
    document.getElementById('ov-badge-version').textContent = `DATA: ${game.local_version || 'UNKNOWN'}`;
    document.getElementById('ov-badge-date').textContent = `RELEASED: ${game.release_date || 'N/A'}`;
    
    // Controls box
    document.getElementById('ov-launch-text').textContent = isWishlist ? 'Wishlist Item' : (isExe ? 'Launch' : 'Open Folder');
    document.getElementById('ov-path-short').textContent = isWishlist
        ? 'No local folder linked yet'
        : (game.folder_path.length > 30 ? game.folder_path.substring(0, 30) + '...' : game.folder_path);
    document.getElementById('ov-type-text').textContent = isWishlist ? 'WISHLIST ENTRY' : (isExe ? 'INSTALLED EXE' : 'ZIP/RAR ARCHIVE');
    const launchBtn = document.getElementById('ov-btn-launch');
    if (launchBtn) launchBtn.disabled = isWishlist;
    const openFolderBtn = document.getElementById('ov-btn-open-folder');
    if (openFolderBtn) openFolderBtn.disabled = isWishlist;
    
    // Metrics
    updateStarPickerUI(game.user_score);
    document.getElementById('ov-source-name').textContent = game.source_type.toUpperCase() || 'LOCAL';
    document.getElementById('ov-platform-score').textContent = normalizeRatingText(game.rating);
    document.getElementById('ov-progress-select').value = game.playing_progress || 'unplayed';
    document.getElementById('ov-size-text').textContent = `${game.file_type.toUpperCase()} | ${game.folder_path}`;
    document.getElementById('ov-folder-full').textContent = isWishlist ? 'Link this wishlist item to a scanned local folder or executable.' : (game.folder_path || 'Unknown path');
    document.getElementById('ov-total-playtime-text').textContent = formatPlaytimeDuration(game.total_playtime_seconds);
    document.getElementById('ov-last-played-text').textContent = formatDateTime(game.last_played);
    document.getElementById('ov-local-version-text').textContent = game.local_version || 'Unknown';
    document.getElementById('ov-latest-version-text').textContent = game.latest_version || 'Not fetched';
    document.getElementById('ov-added-at-text').textContent = formatDateTime(game.added_at);
    document.getElementById('ov-last-seen-text').textContent = formatDateTime(game.last_seen_at);
    document.getElementById('ov-missing-status-text').textContent = `${game.missing_scan_count || 0} missed scan(s)`;
    renderGameUpdatePanel(game);

    updateOverviewCover(game.cover_url, game.title);
    
    // Gallery
    const gallery = document.getElementById('ov-gallery');
    gallery.innerHTML = '';
    const shots = game.screenshots || [];
    document.getElementById('ov-gallery-count').textContent = shots.length;
    
    if (shots.length > 0) {
        shots.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'ov-gallery-img';
            img.referrerPolicy = 'no-referrer';
            img.onerror = () => { img.style.display = 'none'; };
            img.onclick = () => {
                document.getElementById('lightbox-img').src = url;
                document.getElementById('lightbox-modal').style.display = 'flex';
            };
            gallery.appendChild(img);
        });
    } else {
        gallery.innerHTML = `<div style="grid-column: span 3; padding: 24px; background: rgba(59, 130, 246, 0.08); border: 1px dashed rgba(96, 165, 250, 0.35); border-radius: 12px; color: #fff; text-align: center;">No screenshots scraped yet. Visit this game's F95zone or DLsite thread in Chrome and click the floating badge to auto-sync.</div>`;
    }

    // Tags
    const cloud = document.getElementById('ov-tag-cloud');
    cloud.innerHTML = '';
    const allTags = [...(game.tags || []), ...(game.custom_tags || [])];
    if (allTags.length > 0) {
        allTags.forEach(t => {
            cloud.innerHTML += `<span class="tag-chip">${t}</span>`;
        });
    } else {
        cloud.innerHTML = `<span class="tag-chip">${game.category || 'General'}</span>`;
    }

    // Description
    document.getElementById('ov-description').textContent = game.description || 'No description available yet. Use Fetch Info above or the companion extension to auto-scrape from F95zone or DLsite!';

    // Journal
    const jList = document.getElementById('ov-journal-list');
    const entries = game.journal_entries || [];
    if (entries.length > 0) {
        jList.innerHTML = entries.map(j => `
            <div style="padding: 12px; background: var(--bg-box); border: 1px solid var(--border-dark); border-radius: 10px; margin-bottom: 10px;">
                <div style="font-size: 0.75rem; color: var(--accent-red); font-weight: 700; margin-bottom: 4px;">${j.date}</div>
                <div style="font-size: 0.9rem; color: #fff;">${j.text}</div>
            </div>
        `).join('');
    } else {
        jList.innerHTML = `
            <div class="journal-empty">
                <i data-lucide="file-text"></i>
                <h4>No journal entries yet</h4>
                <p>Start documenting your gameplay experience or patch notes.</p>
            </div>
        `;
    }

    // Sources
    const sList = document.getElementById('ov-source-list');
    const sources = game.sources && game.sources.length > 0 ? game.sources : (game.source_url ? [{id: 'legacy', source_type: game.source_type || 'unknown', source_url: game.source_url, source_id: game.source_id, is_preferred: true}] : []);
    
    if (sources.length > 0) {
        sList.innerHTML = sources.map(s => `
            <div class="source-card" style="display:flex; flex-direction:column; gap:6px; border: 1px solid ${s.is_preferred ? 'rgba(56, 189, 248, 0.4)' : 'rgba(255, 255, 255, 0.08)'}; background: ${s.is_preferred ? 'rgba(56, 189, 248, 0.05)' : 'rgba(255, 255, 255, 0.02)'}; border-radius: 8px; padding: 10px; margin-bottom: 6px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div style="display:flex; align-items:center; gap: 8px;">
                        <span class="pill-primary" style="background: ${s.is_preferred ? '#0284c7' : 'rgba(255,255,255,0.1)'};">${(s.source_type || 'unknown').toUpperCase()}</span>
                        ${s.is_preferred ? `<span style="font-size:0.7rem; color:#38bdf8; font-weight:700; display:flex; align-items:center; gap:3px;"><i data-lucide="star" style="width:12px;height:12px;fill:#38bdf8;"></i> Preferred</span>` : ''}
                        <span style="font-size:0.75rem; color:#94a3b8;">ID: ${s.source_id || 'N/A'}</span>
                    </div>
                    <div style="display:flex; gap:6px;">
                        ${!s.is_preferred && s.id !== 'legacy' ? `<button class="btn-secondary btn-src-prefer" data-id="${s.id}" title="Make Preferred" style="padding: 3px 8px; font-size: 0.7rem; display:flex; align-items:center; gap:4px;"><i data-lucide="star" style="width:12px;height:12px;"></i> Prefer</button>` : ''}
                        ${s.id !== 'legacy' ? `<button class="btn-secondary btn-src-delete" data-id="${s.id}" title="Remove Source" style="padding: 3px 6px; font-size: 0.7rem; color:#fca5a5; border-color:rgba(239,68,68,0.3);"><i data-lucide="trash-2" style="width:12px;height:12px;"></i></button>` : ''}
                    </div>
                </div>
                <a href="${s.source_url}" target="_blank" class="source-link" style="font-size:0.8rem; word-break:break-all;">${s.source_url}</a>
            </div>
        `).join('');
        
        if (window.lucide) lucide.createIcons();
        
        sList.querySelectorAll('.btn-src-prefer').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sid = btn.dataset.id;
                if (!sid || !currentGame) return;
                btn.disabled = true;
                try {
                    const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/sources/${sid}/prefer`, { method: 'POST' });
                    if (!res.ok) throw new Error("Failed to prefer source");
                    const data = await res.json();
                    currentGame = data.game;
                    renderOverview(currentGame);
                    await loadGames();
                    if (data.warning) alert(data.warning);
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                }
            });
        });
        
        sList.querySelectorAll('.btn-src-delete').forEach(btn => {
            btn.addEventListener('click', async () => {
                const sid = btn.dataset.id;
                if (!sid || !currentGame) return;
                if (!confirm("Are you sure you want to remove this metadata source?")) return;
                btn.disabled = true;
                try {
                    const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/sources/${sid}`, { method: 'DELETE' });
                    if (!res.ok) throw new Error("Failed to remove source");
                    const data = await res.json();
                    currentGame = data.game;
                    renderOverview(currentGame);
                    await loadGames();
                } catch (err) {
                    alert(err.message);
                    btn.disabled = false;
                }
            });
        });
    } else {
        sList.innerHTML = `
            <div class="source-card">
                <div class="source-top">
                    <div class="source-badge-main">
                        <span class="pill-primary">LOCAL FOLDER</span>
                        <span>Unlinked</span>
                    </div>
                </div>
                <p style="font-size: 0.8rem; color: var(--text-muted);">Manually managed game folder: ${game.folder_path || 'Local library'}</p>
            </div>
        `;
    }

    // Archive inspector
    const archBox = document.getElementById('ov-archive-inspector');
    const archList = document.getElementById('ov-archive-list');
    if (game.file_type === 'archive' && game.archive_contents && game.archive_contents.length > 0) {
        archBox.style.display = 'flex';
        archList.innerHTML = '<ul style="list-style:none; font-size:0.85rem; color:var(--text-silver); display:flex; flex-direction:column; gap:6px;">' +
            game.archive_contents.map(f => `<li>${f}</li>`).join('') + '</ul>';
    } else if (archBox) {
        archBox.style.display = 'none';
    }

    // Reset link form when switching games
    const linkFormEl = document.getElementById('ov-link-form');
    if (linkFormEl) linkFormEl.style.display = 'none';
    const linkInputEl = document.getElementById('ov-link-url-input');
    if (linkInputEl) linkInputEl.value = '';
    const localLinkBtnEl = document.getElementById('ov-btn-link-local');
    if (localLinkBtnEl) localLinkBtnEl.style.display = isWishlist ? 'flex' : 'none';
    const pickFolderArchiveBtnEl = document.getElementById('ov-btn-link-folder-archive');
    if (pickFolderArchiveBtnEl) pickFolderArchiveBtnEl.style.display = isWishlist ? 'flex' : 'none';
    const localLinkFormEl = document.getElementById('ov-local-link-form');
    if (localLinkFormEl) localLinkFormEl.style.display = 'none';
    const localLinkSearchEl = document.getElementById('ov-local-link-search');
    if (localLinkSearchEl) localLinkSearchEl.value = '';
    const localLinkSelectEl = document.getElementById('ov-local-link-select');
    if (localLinkSelectEl) localLinkSelectEl.innerHTML = '';

    // Update "Wrong Data" button label based on source state
    const wrongBtn = document.getElementById('ov-btn-mark-wrong');
    if (wrongBtn) {
        if (game.source_type === 'unknown' || !game.source_url) {
            wrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>No Source / Try Re-scrape</span>`;
        } else {
            wrongBtn.innerHTML = `<i data-lucide="alert-triangle"></i> <span>Wrong Data / Re-scrape</span>`;
        }
    }

    if (window.lucide) lucide.createIcons();
}

async function launchGame(gameId) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}/launch`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Failed to launch game');
        if (data.game && currentGame && currentGame.id === gameId) {
            currentGame = data.game;
            renderOverview(currentGame);
        }
        if (typeof loadGames === 'function') {
            await loadGames();
        }
    } catch (err) {
        alert(`Failed to launch executable or open Explorer folder: ${err.message}`);
    }
}

async function openGameFolder(gameId) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}/open-folder`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Failed to open folder');
    } catch (err) {
        alert(`Failed to open folder: ${err.message}`);
    }
}

async function loadExtensionQueue() {
    const list = document.getElementById('ext-queue-list');
    if (!list) return;
    list.innerHTML = '';
    
    try {
        const res = await fetch(`${API_BASE}/api/games/needs-metadata`);
        const games = await res.json();
        refreshSettingsMetadataQueue({ force: true }).catch((error) => {
            console.debug('Failed to refresh settings metadata queue', error);
        });
        
        if (games.length === 0) {
            list.innerHTML = `<div class="settings-queue-empty">All identified games currently have their cover images and screenshots synced.</div>`;
            return;
        }

        list.innerHTML = games.slice(0, 8).map((game) => {
            const query = encodeURIComponent(game.title || game.raw_name || '');
            const f95Url = `https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search=${query}`;
            const dlsiteUrl = `https://www.dlsite.com/home/fsr/=/keyword/${query}`;
            return `
                <div class="queue-item">
                    <div class="queue-info">
                        <h4>${escapeHtml(game.title || game.raw_name || 'Unknown title')}</h4>
                        <span>${escapeHtml(game.folder_path || 'No local path recorded')}</span>
                    </div>
                    <div class="extension-queue-actions">
                        <button class="btn-secondary btn-xs-action extension-queue-link" type="button" data-url="${escapeHtml(f95Url)}">F95Zone</button>
                        <button class="btn-secondary btn-xs-action extension-queue-link" type="button" data-url="${escapeHtml(dlsiteUrl)}">DLsite</button>
                    </div>
                </div>
            `;
        }).join('');

        list.querySelectorAll('.extension-queue-link').forEach((button) => {
            button.addEventListener('click', async () => {
                await openExternalUrl(button.dataset.url || '');
            });
        });
    } catch (err) {
        console.error("Failed to load queue", err);
        list.innerHTML = `<div class="settings-queue-empty">Unable to load the current metadata queue.</div>`;
    }
}

function updateStarPickerUI(scoreStr) {
    const starBtns = document.querySelectorAll('.user-star-btn');
    const clearBtn = document.getElementById('ov-clear-star');
    const scoreNum = document.getElementById('ov-score-num');
    let num = 0;
    if (scoreStr && scoreStr !== 'N/A') {
        num = parseInt(scoreStr, 10) || 0;
    }
    starBtns.forEach(btn => {
        const val = parseInt(btn.getAttribute('data-val'), 10);
        if (val <= num) {
            btn.style.color = '#fbbf24';
            btn.style.transform = 'scale(1.15)';
            btn.style.textShadow = '0 0 10px rgba(251, 191, 36, 0.5)';
        } else {
            btn.style.color = '#334155';
            btn.style.transform = 'scale(1)';
            btn.style.textShadow = 'none';
        }
    });
    if (num > 0) {
        if (clearBtn) clearBtn.style.display = 'inline-block';
        if (scoreNum) scoreNum.textContent = `${num}/5`;
    } else {
        if (clearBtn) clearBtn.style.display = 'none';
        if (scoreNum) scoreNum.textContent = 'N/A';
    }
}

window.removeWishlistGame = async function(id, title) {
    if (!confirm(`Remove "${title}" from your Wishlist?`)) return;
    try {
        const res = await fetch(`${API_BASE}/api/games/${id}`, {
            method: 'DELETE'
        });
        if (res.ok) {
            const ovModal = document.getElementById('overview-modal');
            if (ovModal && ovModal.style.display === 'flex' && currentGame && currentGame.id === id) {
                ovModal.style.display = 'none';
            }
            await fetchStats();
            await loadGames();
        } else {
            alert("Failed to remove game from wishlist.");
        }
    } catch (e) {
        alert("Error removing game: " + e);
    }
};

window.pickWishlistLocalPath = async function(id, title, pickMode) {
    if (!window.pywebview || !window.pywebview.api) {
        alert("Local path picking is only available in the desktop app build.");
        return;
    }

    if (!pickMode || (pickMode !== 'folder' && pickMode !== 'archive')) {
        const choiceModal = document.getElementById('local-path-choice-modal');
        const choiceTitle = document.getElementById('local-path-choice-title');
        const btnFolder = document.getElementById('btn-choice-pick-folder');
        const btnArchive = document.getElementById('btn-choice-pick-archive');
        const btnClose = document.getElementById('btn-close-local-path-choice');
        if (choiceModal && btnFolder && btnArchive) {
            if (choiceTitle) choiceTitle.textContent = `Link "${title}" to Local Source`;
            choiceModal.style.display = 'flex';

            const cleanup = () => {
                choiceModal.style.display = 'none';
                btnFolder.onclick = null;
                btnArchive.onclick = null;
                if (btnClose) btnClose.onclick = null;
            };

            if (btnClose) btnClose.onclick = cleanup;
            choiceModal.onclick = (e) => {
                if (e.target === choiceModal) cleanup();
            };

            btnFolder.onclick = () => {
                cleanup();
                window.pickWishlistLocalPath(id, title, 'folder');
            };
            btnArchive.onclick = () => {
                cleanup();
                window.pickWishlistLocalPath(id, title, 'archive');
            };
            if (window.lucide) lucide.createIcons();
            return;
        }
    }

    const initialDir = getPrimaryGamesDir();
    const picker = pickMode === 'archive'
        ? window.pywebview.api.browse_local_game_file
        : window.pywebview.api.browse_folder;

    if (!picker) {
        alert("This desktop build does not expose the required local picker yet.");
        return;
    }

    try {
        const selectedPath = await picker(initialDir);
        if (!selectedPath) return;

        const res = await fetch(`${API_BASE}/api/games/${id}/link-picked-local`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ selected_path: selectedPath })
        });
        const data = await res.json();
        if (!res.ok) {
            throw new Error(data.detail || 'Failed to link wishlist item to the selected local source');
        }

        await fetchStats();
        await loadGames();

        if (currentGame && currentGame.id === id) {
            await openOverviewPage(data.game.id);
        } else {
            alert(data.message || `Linked "${title}" to your local library successfully.`);
        }
    } catch (err) {
        alert(`Failed to link "${title}" to a local source: ${err.message}`);
    }
};
