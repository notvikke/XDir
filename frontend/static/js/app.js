const API_BASE = window.location.origin.includes('localhost') || window.location.origin.includes('127.0.0.1') 
    ? '' 
    : 'http://127.0.0.1:8765';

let allGames = [];
let currentGame = null;
let isTranslated = false;
let originalMetadata = null;
let lastGridScrollPos = 0;
let appSettings = null;
let settingsBaseline = null;
let activeSettingsJobKey = null;
let activeScanJobKey = null;
let activeScanModeKey = null;
let currentSmartScanResult = null;
let lastSettingsMetadataQueueRefreshAt = 0;
const MISSING_SOURCE_SCAN_JOB_KEY = 'missing-source-scan';
const REFRESH_METADATA_JOB_KEY = 'refresh-all-metadata';
const CHECK_UPDATES_JOB_KEY = 'check-updates';
const LIBRARY_JOB_DEFINITIONS = {
    [MISSING_SOURCE_SCAN_JOB_KEY]: {
        jobKey: MISSING_SOURCE_SCAN_JOB_KEY,
        startUrl: `${API_BASE}/api/library/missing-source-scan`,
        toolbarLabel: 'Finding missing sources',
        resultsTitle: 'Find Missing Sources',
        resultsCopy: 'Track source matches and review plausible candidates without interrupting the job.',
        reviewTitle: 'Review Missing Sources',
        reviewCopy: 'Apply the best source candidate when it looks correct, or skip it and resolve the game later.',
        eyebrow: 'Find Missing Sources',
        cancelledEyebrow: 'Source Discovery Cancelled',
        runningTitle: 'Searching unlinked games...',
        metrics: [['matched', 'Automatically linked'], ['manual_review', 'Needs review'], ['not_found', 'Not found'], ['failed', 'Failed']],
    },
    [REFRESH_METADATA_JOB_KEY]: {
        jobKey: REFRESH_METADATA_JOB_KEY,
        startUrl: `${API_BASE}/api/library/refresh-all-metadata`,
        toolbarLabel: 'Refreshing metadata',
        resultsTitle: 'Refresh All Metadata',
        resultsCopy: 'Refetch metadata from existing links without rematching games.',
        eyebrow: 'Metadata Refresh',
        cancelledEyebrow: 'Metadata Refresh Cancelled',
        runningTitle: 'Refreshing linked games...',
        metrics: [['refreshed', 'Refreshed'], ['skipped', 'Skipped'], ['unsupported', 'Unsupported'], ['failed', 'Failed']],
    },
    [CHECK_UPDATES_JOB_KEY]: {
        jobKey: CHECK_UPDATES_JOB_KEY,
        startUrl: `${API_BASE}/api/library/check-updates`,
        toolbarLabel: 'Checking for updates',
        resultsTitle: 'Library Update Check',
        resultsCopy: 'Check installed versions against supported linked sources.',
        eyebrow: 'Update Check',
        cancelledEyebrow: 'Update Check Cancelled',
        runningTitle: 'Checking game versions...',
        metrics: [['updates_available', 'Updates found'], ['up_to_date', 'Up to date'], ['unsupported', 'Unsupported'], ['failed', 'Failed']],
    },
};
const SETTINGS_JOB_DEFINITIONS = {
    'fix-metadata': {
        buttonId: 'btn-fix-metadata',
        startUrl: `${API_BASE}/api/library/fix-metadata`,
        initialMessage: 'Fixing titles, covers, and screenshots across your library...',
        genericFailureMessage: 'Failed to fix titles and refetch metadata',
        idleHtml: `<i data-lucide="wand-2"></i> <span>Run Repair</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Repairing...</span>`,
    },
    'rematch-f95zone': {
        buttonId: 'btn-rematch-f95',
        startUrl: `${API_BASE}/api/library/rematch-f95zone`,
        initialMessage: 'Rematching unidentified games against F95Zone and refreshing matches...',
        genericFailureMessage: 'Failed to rematch F95Zone titles',
        idleHtml: `<i data-lucide="search"></i> <span>Run Rematch</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Rematching...</span>`,
    },
    'flush-metadata': {
        buttonId: 'btn-flush-metadata',
        startUrl: `${API_BASE}/api/library/flush-metadata`,
        initialMessage: 'Removing scraped metadata while keeping local records and source links intact...',
        genericFailureMessage: 'Failed to flush scraped metadata',
        idleHtml: `<i data-lucide="trash-2"></i> <span>Flush Metadata</span>`,
        loadingHtml: `<i data-lucide="loader" class="spin"></i> <span>Flushing...</span>`,
        requestInit: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ confirmation_phrase: 'FLUSH' }),
        },
    },
};
const SETTINGS_JOB_KEYS = Object.keys(SETTINGS_JOB_DEFINITIONS);

function renderTranslateButtonLabel(mode = 'translate') {
    const label = mode === 'revert' ? 'Revert' : 'Translate';
    return `<i data-lucide="languages" style="width:14px;height:14px;"></i><span>${label}</span>`;
}

function showAppNotification(message, tone = 'info') {
    const toast = document.getElementById('app-toast');
    if (!toast) return;
    toast.textContent = message;
    toast.dataset.tone = tone;
    toast.hidden = false;
    clearTimeout(showAppNotification.timer);
    showAppNotification.timer = setTimeout(() => { toast.hidden = true; }, 4500);
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
        return 'will be searched first when unlinked games need a source match.';
    }
    if (key === 'itch') {
        return 'will open first for indie-heavy search flows and be queried before the other automatic metadata providers.';
    }
    return 'will be queried first for missing-source discovery and opened first in manual search.';
}

function renderSettingsPreferredSource(source) {
    const label = formatSourceLabel(source || appSettings?.preferred_source || 'f95zone');
    const summary = getPreferredSourceSummary(source || appSettings?.preferred_source || 'f95zone');

    const heroLabel = document.getElementById('settings-kpi-source');
    if (heroLabel) heroLabel.textContent = label;

    const heroDetail = document.getElementById('settings-kpi-source-detail');
    if (heroDetail) heroDetail.textContent = `${label} is used first for source discovery and search defaults.`;

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
    const versionElement = document.getElementById('settings-extension-version');
    if (versionElement) versionElement.textContent = status?.version || 'Not reported';
    const heartbeatElement = document.getElementById('settings-extension-heartbeat');
    if (heartbeatElement) heartbeatElement.textContent = status?.last_heartbeat ? formatDateTime(status.last_heartbeat) : (connected ? 'Just now' : 'Never');

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

function getScanJobDefinition(scanKey = null) {
    const key = scanKey || activeScanModeKey || activeScanJobKey || MISSING_SOURCE_SCAN_JOB_KEY;
    return LIBRARY_JOB_DEFINITIONS[key] || LIBRARY_JOB_DEFINITIONS[MISSING_SOURCE_SCAN_JOB_KEY];
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

function setLibraryJobActionBusyState(isBusy) {
    ['btn-add-game', 'btn-refresh-metadata', 'btn-check-library-updates'].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = isBusy;
    });
}

function renderSettingsJobProgress(state) {
    const label = document.getElementById('settings-job-progress-label');
    const fill = document.getElementById('settings-job-progress-fill');
    const count = document.getElementById('settings-job-progress-count');
    const percent = document.getElementById('settings-job-progress-percent');
    const current = document.getElementById('settings-job-progress-current');
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
                await Promise.allSettled([fetchStats(), loadGames(), fetchTags()]);
                showAppNotification(state.summary || 'Library job completed.', 'success');
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                return;
            }

            if (state.status === 'failed') {
                hideSettingsJobProgress();
                activeSettingsJobKey = null;
                throw new Error(state.error || 'Library job failed');
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
                showAppNotification(`${definition.genericFailureMessage}: ${err.message}`, 'error');
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
        showAppNotification('Flush cancelled. Confirmation phrase did not match.', 'info');
        return false;
    }

    return true;
}

async function startSettingsTrackedJob(jobKey, requestInit = null) {
    const definition = SETTINGS_JOB_DEFINITIONS[jobKey];
    if (!definition) return;

    if (activeSettingsJobKey === jobKey) return;
    if (activeScanJobKey) {
        showAppNotification(`${getScanJobDefinition(activeScanJobKey).resultsTitle} is already running.`, 'warning');
        return;
    }
    if (activeSettingsJobKey && activeSettingsJobKey !== jobKey) {
        showAppNotification('Another library metadata job is already running.', 'warning');
        return;
    }

    activeSettingsJobKey = jobKey;
    showSettingsJobProgress(definition.initialMessage);
    setMetadataActionBusyState(true, definition.buttonId);
    setLibraryJobActionBusyState(true);
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
        showAppNotification(`${definition.genericFailureMessage}: ${err.message}`, 'error');
    } finally {
        setMetadataActionBusyState(false);
        setLibraryJobActionBusyState(false);
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
    syncModalScrollLock();
    document.getElementById('btn-close-scan-workflow')?.focus();
}

function closeScanWorkflowModal(force = false) {
    if (!force && activeScanJobKey) return;
    const modal = document.getElementById('scan-workflow-modal');
    const backdrop = document.getElementById('scan-workflow-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    syncModalScrollLock();
    if (!activeScanJobKey) {
        setScanWorkflowView('scan-workflow-choice-view');
    }
}

function showScanResultsModal() {
    const modal = document.getElementById('scan-results-modal');
    const backdrop = document.getElementById('scan-results-backdrop');
    if (modal) modal.style.display = 'block';
    if (backdrop) backdrop.style.display = 'block';
    syncModalScrollLock();
    document.getElementById('btn-close-scan-results')?.focus();
}

function closeScanResultsModal(force = false) {
    const modal = document.getElementById('scan-results-modal');
    const backdrop = document.getElementById('scan-results-backdrop');
    if (modal) modal.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
    syncModalScrollLock();
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
        ...(state.result || {}),
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

function getTrackedJobMetricValues(state, definition) {
    const result = state?.result || currentSmartScanResult || {};
    return (definition.metrics || []).map(([key, label]) => ({
        key,
        label,
        value: Number(result[key] ?? state?.[`${key}_count`] ?? 0),
    }));
}

function renderTrackedJobMetrics(state, summary = false) {
    const definition = getScanJobDefinition(state?.job_key || currentSmartScanResult?.scanModeKey);
    const values = getTrackedJobMetricValues(state, definition);
    const prefix = summary ? 'smart-scan-summary-' : 'smart-scan-count-';
    const ids = summary ? ['matched', 'review', 'not-found', 'failed'] : ['matched', 'review', 'not-found', 'failed'];
    ids.forEach((suffix, index) => {
        const value = document.getElementById(`${prefix}${suffix}`);
        const card = value?.closest('.scan-counter-card');
        const label = card?.querySelector('.scan-counter-label');
        if (value) value.textContent = String(values[index]?.value || 0);
        if (label) label.textContent = values[index]?.label || '';
    });
}

function syncModalScrollLock() {
    const openModal = ['scan-workflow-modal', 'scan-results-modal', 'refresh-metadata-confirm']
        .map(id => document.getElementById(id))
        .some(modal => modal && modal.style.display !== 'none');
    document.body.classList.toggle('modal-open', openModal);
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
    const currentQuery = state?.current_query
        ? `"${state.current_query}"`
        : scanDefinition.jobKey === MISSING_SOURCE_SCAN_JOB_KEY
            ? 'Waiting...'
            : 'Using the existing source link';
    const detail = state?.detail || 'Preparing unresolved games...';

    document.getElementById('scan-results-title').textContent = scanDefinition.resultsTitle;
    document.getElementById('scan-results-copy').textContent = scanDefinition.resultsCopy;
    document.getElementById('smart-scan-status-title').textContent = state?.cancel_requested ? `Cancelling ${scanDefinition.resultsTitle.toLowerCase()}...` : scanDefinition.runningTitle;
    document.getElementById('smart-scan-status-text').textContent = detail;
    document.getElementById('smart-scan-game-counter').textContent = `Game ${Math.max(total ? 1 : 0, currentIndex)} / ${total}`;
    document.getElementById('smart-scan-progress-fill').style.width = `${percent}%`;
    document.getElementById('smart-scan-current-name').textContent = currentName;
    document.getElementById('smart-scan-current-source').textContent = currentSource;
    document.getElementById('smart-scan-current-query').textContent = currentQuery;
    document.getElementById('smart-scan-current-stage').textContent = detail;
    renderTrackedJobMetrics(state);

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
        summary: state?.summary || state?.error || 'Library job finished.',
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
    document.getElementById('scan-results-title').textContent = `${scanDefinition.resultsTitle} Results`;
    document.getElementById('scan-results-copy').textContent = scanDefinition.resultsCopy;
    document.getElementById('smart-scan-summary-eyebrow').textContent = currentSmartScanResult.cancelled ? scanDefinition.cancelledEyebrow : scanDefinition.eyebrow;
    document.getElementById('smart-scan-summary-title').textContent = summaryTitle;
    document.getElementById('smart-scan-summary-copy').textContent = currentSmartScanResult.summary || 'Library job finished.';
    renderTrackedJobMetrics({ ...state, result: currentSmartScanResult }, true);

    const reviewButton = document.getElementById('btn-smart-scan-review');
    if (reviewButton) {
        reviewButton.style.display = getVisibleSmartScanReviewItems().length > 0 ? 'inline-flex' : 'none';
    }
    const runAgain = document.getElementById('btn-smart-scan-run-again');
    if (runAgain) runAgain.querySelector('span').textContent = scanDefinition.jobKey === MISSING_SOURCE_SCAN_JOB_KEY ? 'Find again' : 'Run again';
    showAppNotification(currentSmartScanResult.summary || summaryTitle, state?.status === 'failed' ? 'error' : 'success');
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
                <strong>No unresolved games remain in this source-discovery batch.</strong>
                <p class="smart-review-empty">Close the dialog or run source discovery again whenever you want to retry unresolved entries.</p>
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
                                <div class="smart-review-candidate-meta">Candidate source: ${escapeHtml(formatSmartScanSource(candidate.source_type))}</div>
                                <div class="smart-review-candidate-meta">Developer / creator: ${escapeHtml(candidate.creator || 'Unknown')}</div>
                                <div class="smart-review-candidate-meta">Reported version: ${escapeHtml(candidate.version || 'Not reported')}</div>
                                <div class="smart-review-candidate-meta">Reason: ${escapeHtml(reasonText)}</div>
                                <div class="smart-review-candidate-meta">Score: ${escapeHtml(candidate.score || 0)}${candidate.matched_query ? ` | Query: ${escapeHtml(candidate.matched_query)}` : ''}</div>
                                ${candidate.url ? `<span class="smart-review-link">${escapeHtml(candidate.url)}</span>` : ''}
                            </div>
                            <div class="smart-review-candidate-actions">
                                <button type="button" class="btn-primary btn-apply-smart-review" data-game-id="${item.game_id}" data-candidate="${candidatePayload}">
                                    <i data-lucide="check"></i>
                                    <span>Apply Match</span>
                                </button>
                                <button type="button" class="btn-secondary btn-view-smart-review" data-url="${escapeHtml(candidate.url || '')}">
                                    <i data-lucide="external-link"></i>
                                    <span>Open Source</span>
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
                                <h5 class="smart-review-title">${escapeHtml(item.current_title || item.local_name || 'Unknown')}</h5>
                                <p class="smart-review-copy">Local folder / archive: ${escapeHtml(item.archive_name || item.raw_name || item.local_name || 'Unknown')}<br><span class="smart-review-path">${escapeHtml(item.folder_path || '')}</span></p>
                            </div>
                            <span class="smart-review-status ${statusClass}">${escapeHtml(statusLabel)}</span>
                        </div>
                        ${candidateGroups || `<div class="smart-review-empty">No matching game found.</div>`}
                        ${item.error_summary ? `<div class="smart-review-empty">Details: ${escapeHtml(item.error_summary)}</div>` : ''}
                        <div class="smart-review-row-actions review-item-actions">
                            <button type="button" class="btn-secondary btn-dismiss-smart-review" data-game-id="${item.game_id}">
                                <i data-lucide="clock-3"></i>
                                <span>Skip</span>
                            </button>
                            <button type="button" class="btn-ghost btn-resolve-later-review" data-game-id="${item.game_id}">Resolve Later</button>
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

    list.querySelectorAll('.btn-dismiss-smart-review, .btn-resolve-later-review').forEach((button) => {
        button.addEventListener('click', () => {
            const gameId = Number(button.dataset.gameId || 0);
            currentSmartScanResult.review_items = (currentSmartScanResult.review_items || []).map((item) =>
                item.game_id === gameId ? { ...item, dismissed: true } : item,
            );
            renderSmartScanReviewList();
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
                const res = await fetch(`${API_BASE}/api/library/smart-scan/review/${gameId}/apply`, {
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
                currentSmartScanResult.review_items = (currentSmartScanResult.review_items || []).filter((item) => item.game_id !== gameId);
                await Promise.allSettled([fetchStats(), fetchTags(), loadGames()]);
                const row = list.querySelector(`.smart-review-card[data-game-id="${gameId}"]`);
                if (row) {
                    row.dataset.reviewState = 'resolved';
                    row.querySelector('.review-item-actions').innerHTML = `<span class="status-note success">Match applied${data.warning ? ` with warning: ${escapeHtml(data.warning)}` : ''}</span>`;
                }
                showAppNotification(data.warning || 'Source match applied.', data.warning ? 'warning' : 'success');
            } catch (err) {
                const row = button.closest('.smart-review-card');
                const actions = row?.querySelector('.review-item-actions');
                if (actions) actions.insertAdjacentHTML('beforeend', `<span class="status-note error">${escapeHtml(err.message)}</span>`);
                button.disabled = false;
                button.innerHTML = originalHtml;
                if (window.lucide) lucide.createIcons();
            }
        });
    });

    if (window.lucide) lucide.createIcons();
}

let smartScanPollPromise = null;

async function refreshLibraryStateAfterJob() {
    await Promise.allSettled([fetchStats(), fetchTags(), loadGames()]);
    const overview = document.getElementById('overview-modal');
    if (!currentGame || !overview || overview.style.display === 'none') return;
    try {
        const response = await fetch(`${API_BASE}/api/games/${currentGame.id}`);
        const game = await readJsonResponse(response);
        if (response.ok) {
            replaceGameState(game);
            renderOverview(game);
        }
    } catch (error) {
        console.debug('Unable to refresh the open overview after a library job', error);
    }
}

function renderTrackedJobProgress(state) {
    return renderSmartScanProgress(state);
}

function renderTrackedJobSummary(state = null) {
    return renderSmartScanSummary(state);
}

function ensureSmartScanPolling(jobKey) {
    if (smartScanPollPromise) return smartScanPollPromise;
    smartScanPollPromise = pollTrackedJob(jobKey).finally(() => {
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
            renderTrackedJobProgress(state);

            if (state.status === 'completed' || state.status === 'cancelled' || state.status === 'failed') {
                activeScanJobKey = null;
                setMetadataActionBusyState(false);
                setLibraryJobActionBusyState(false);
                currentSmartScanResult = state.result || currentSmartScanResult;
                hideScanToolbarProgress();
                await refreshLibraryStateAfterJob();
                showScanResultsModal();
                renderTrackedJobSummary(state);
                return;
            }
        } catch (err) {
            pollFailures += 1;
            if (pollFailures >= 5) {
                activeScanJobKey = null;
                setMetadataActionBusyState(false);
                setLibraryJobActionBusyState(false);
                hideScanToolbarProgress();
                currentSmartScanResult = {
                    processed: Number(currentSmartScanResult?.processed || 0),
                    total: Number(currentSmartScanResult?.total || 0),
                    matched: Number(currentSmartScanResult?.matched || 0),
                    manual_review: Number(currentSmartScanResult?.manual_review || 0),
                    not_found: Number(currentSmartScanResult?.not_found || 0),
                    failed: Number(currentSmartScanResult?.failed || 0) + 1,
                    review_items: currentSmartScanResult?.review_items || [],
                    summary: `Library job polling failed: ${err.message}`,
                };
                showScanResultsModal();
                renderTrackedJobSummary({ status: 'failed', error: err.message, result: currentSmartScanResult });
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
    if (activeScanJobKey) {
        showAppNotification(`${getScanJobDefinition(activeScanJobKey).resultsTitle} is already running.`, 'warning');
        showScanResultsModal();
        return;
    }
    if (activeSettingsJobKey) {
        showAppNotification('An advanced maintenance job is already running.', 'warning');
        return;
    }
    activeScanModeKey = scanDefinition.jobKey;
    activeScanJobKey = scanDefinition.jobKey;
    currentSmartScanResult = null;
    setMetadataActionBusyState(true);
    setLibraryJobActionBusyState(true);
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
        detail: 'Preparing library job...',
        matched_count: 0,
        manual_review_count: 0,
        not_found_count: 0,
        failed_count: 0,
    };
    renderScanToolbarProgress(initialState);
    renderTrackedJobProgress({
        ...initialState,
    });

    try {
        const res = await fetch(scanDefinition.startUrl, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) {
            activeScanJobKey = null;
            setMetadataActionBusyState(false);
            setLibraryJobActionBusyState(false);
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
            await refreshLibraryStateAfterJob();
            showScanResultsModal();
            renderTrackedJobSummary(data);
            return;
        }

        renderScanToolbarProgress(data);
        renderTrackedJobProgress(data);
        ensureSmartScanPolling(scanDefinition.jobKey);
    } catch (err) {
        activeScanJobKey = null;
        setMetadataActionBusyState(false);
        setLibraryJobActionBusyState(false);
        hideScanToolbarProgress();
        showAppNotification(`Failed to start ${scanDefinition.resultsTitle.toLowerCase()}: ${err.message}`, 'error');
    }
}

async function startMissingSourceScan() {
    await startTrackedMetadataScan(MISSING_SOURCE_SCAN_JOB_KEY);
}

async function startTrackedJob(jobKey) {
    return startTrackedMetadataScan(jobKey);
}

async function pollTrackedJob(jobKey) {
    return pollSmartScanJob(jobKey);
}

async function cancelTrackedJob(jobKey = activeScanJobKey) {
    if (!jobKey) return;
    await fetch(`${API_BASE}/api/library/jobs/${jobKey}/cancel`, { method: 'POST' });
}

async function resumeActiveSmartScanJob({ openResults = false, onlyRunning = false } = {}) {
    for (const scanKey of Object.keys(LIBRARY_JOB_DEFINITIONS)) {
        try {
            const state = await getLibraryJobState(scanKey);
            if (state?.status === 'running') {
                activeScanModeKey = scanKey;
                activeScanJobKey = scanKey;
                setMetadataActionBusyState(true);
                setLibraryJobActionBusyState(true);
                currentSmartScanResult = state.result || null;
                if (currentSmartScanResult) currentSmartScanResult.scanModeKey = scanKey;
                renderScanToolbarProgress(state);
                renderTrackedJobProgress(state);
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
                    renderTrackedJobSummary(state);
                }
                return true;
            }
        } catch (error) {
            console.debug(`Unable to restore ${scanKey} job state`, error);
        }
    }

    return false;
}

async function restoreTrackedJobs(options = {}) {
    return resumeActiveSmartScanJob(options);
}

async function openScanWorkflowModal() {
    if (activeSettingsJobKey) {
        showAppNotification('An advanced maintenance job is already running.', 'warning');
        return;
    }
    const resumed = await restoreTrackedJobs({ openResults: true, onlyRunning: true });
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
        loadSettings();
        refreshSettingsMetadataQueue({ force: true }).catch((error) => {
            console.debug('Failed to refresh settings metadata queue', error);
        });
    }
}

async function initApp() {
    setupWindowResizeHandles();
    setupEventListeners();
    const statsTask = fetchStats();
    const settingsTask = loadSettings();
    const tagsTask = fetchTags();
    const gamesTask = loadGames();
    await Promise.allSettled([statsTask, settingsTask]);
    resumeActiveSettingsJob().catch((error) => {
        console.error('Failed to resume active settings job', error);
    });
    restoreTrackedJobs({ onlyRunning: true }).catch((error) => {
        console.error('Failed to resume active library job', error);
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
        
        const banner = document.getElementById('ext-banner-box');
        const bTitle = document.getElementById('ext-banner-title');
        const bDesc = document.getElementById('ext-banner-desc');
        if (status.connected || status.status === 'connected') {
            if (pill) pill.className = 'quick-status ext-pill connected';
            if (dot) dot.className = 'status-dot';
            if (label) label.textContent = `Extension Connected (v${status.version || '1.0'})`;
            if (banner) banner.style.display = 'none';
        } else {
            if (pill) pill.className = 'quick-status ext-pill offline';
            if (dot) dot.className = 'status-dot offline';
            if (label) label.textContent = 'Extension Offline';
            if (banner) {
                banner.style.display = 'flex';
                banner.className = 'ext-status-banner offline';
                if (bTitle) bTitle.textContent = 'Chrome Companion Offline';
                if (bDesc) bDesc.textContent = `No heartbeat received from Chrome. Open Chrome and make sure the extension is loaded from your application's extension folder.`;
            }
        }

        renderSettingsExtensionStatus(status);

    } catch (e) {
        console.debug("Extension status check failed", e);
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
            restoreTrackedJobs({ openResults: true, onlyRunning: true });
        });
    }

    const scanToolbarCancelBtn = document.getElementById('btn-cancel-smart-scan-toolbar');
    if (scanToolbarCancelBtn) {
        scanToolbarCancelBtn.addEventListener('click', async () => {
            if (!activeScanJobKey) return;
            try {
                await cancelTrackedJob();
            } catch (error) {
                showAppNotification(`Failed to cancel job: ${error.message}`, 'error');
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
                await cancelTrackedJob();
            } catch (error) {
                showAppNotification(`Failed to cancel job: ${error.message}`, 'error');
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
            await startTrackedJob(activeScanModeKey || MISSING_SOURCE_SCAN_JOB_KEY);
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

    const refreshButton = document.getElementById('btn-refresh-metadata');
    const refreshDialog = document.getElementById('refresh-metadata-confirm');
    const refreshBackdrop = document.getElementById('refresh-metadata-backdrop');
    const closeRefreshDialog = () => {
        if (refreshDialog) refreshDialog.style.display = 'none';
        if (refreshBackdrop) refreshBackdrop.style.display = 'none';
        syncModalScrollLock();
    };
    refreshButton?.addEventListener('click', async () => {
        if (await restoreTrackedJobs({ openResults: true, onlyRunning: true })) return;
        if (refreshDialog) refreshDialog.style.display = 'block';
        if (refreshBackdrop) refreshBackdrop.style.display = 'block';
        syncModalScrollLock();
        document.getElementById('btn-confirm-refresh-metadata')?.focus();
    });
    document.getElementById('btn-close-refresh-metadata')?.addEventListener('click', closeRefreshDialog);
    document.getElementById('btn-cancel-refresh-metadata')?.addEventListener('click', closeRefreshDialog);
    refreshBackdrop?.addEventListener('click', closeRefreshDialog);
    document.getElementById('btn-confirm-refresh-metadata')?.addEventListener('click', async () => {
        closeRefreshDialog();
        await startTrackedJob(REFRESH_METADATA_JOB_KEY);
    });

    document.getElementById('btn-check-library-updates')?.addEventListener('click', async () => {
        await startTrackedJob(CHECK_UPDATES_JOB_KEY);
    });
    document.addEventListener('keydown', (event) => {
        const dialogs = ['refresh-metadata-confirm', 'scan-results-modal', 'scan-workflow-modal']
            .map(id => document.getElementById(id));
        const dialog = dialogs.find(element => element && element.style.display !== 'none');
        if (!dialog) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (dialog.id === 'refresh-metadata-confirm') closeRefreshDialog();
            if (dialog.id === 'scan-results-modal') closeScanResultsModal();
            if (dialog.id === 'scan-workflow-modal') closeScanWorkflowModal();
            return;
        }
        if (event.key !== 'Tab') return;
        const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])')]
            .filter(element => !element.hidden && element.offsetParent !== null);
        if (!focusable.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
        }
    });
    
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

    // Settings Primary Game Setups Directory controls
    document.getElementById('btn-browse-dir')?.addEventListener('click', async () => {
        if (window.pywebview && window.pywebview.api && window.pywebview.api.browse_folder) {
            const currentVal = document.getElementById('setting-games-dir').value;
            const chosen = await window.pywebview.api.browse_folder(currentVal);
            if (chosen) {
                document.getElementById('setting-games-dir').value = chosen;
                syncSettingsDirtyState();
            }
        } else {
            showAppNotification('Paste the library folder path into the field.', 'info');
        }
    });

    document.getElementById('btn-save-preferences')?.addEventListener('click', async () => {
        await persistSettings();
    });

    document.getElementById('set-preferred-source')?.addEventListener('change', (event) => {
        renderSettingsPreferredSource(event.target.value);
    });
    document.querySelectorAll('#settings-view input, #settings-view select').forEach((control) => {
        control.addEventListener(control.matches('input[type="text"], input[type="number"]') ? 'input' : 'change', syncSettingsDirtyState);
    });

    document.getElementById('btn-settings-open-extension-tab')?.addEventListener('click', () => {
        activateTab('extension');
        if (typeof loadExtensionQueue === 'function') loadExtensionQueue();
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

    const updateBadgeBtn = document.getElementById('ov-badge-update');
    if (updateBadgeBtn) {
        updateBadgeBtn.addEventListener('click', async () => {
            if (currentGame?.source_url) await openExternalUrl(currentGame.source_url);
        });
    }

    document.getElementById('btn-check-update')?.addEventListener('click', checkCurrentGameForUpdate);
    document.getElementById('btn-edit-local-version')?.addEventListener('click', () => {
        const editor = document.getElementById('local-version-editor');
        const input = document.getElementById('local-version-input');
        if (input) input.value = currentGame?.local_version || '';
        if (editor) editor.hidden = false;
        input?.focus();
    });
    document.getElementById('btn-cancel-local-version')?.addEventListener('click', () => {
        document.getElementById('local-version-editor').hidden = true;
        setVersionInlineMessage('');
    });
    document.getElementById('btn-save-local-version')?.addEventListener('click', saveCurrentLocalVersion);
    document.getElementById('local-version-input')?.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentLocalVersion();
        if (event.key === 'Escape') document.getElementById('btn-cancel-local-version')?.click();
    });
    document.getElementById('btn-mark-latest-installed')?.addEventListener('click', markLatestAsInstalled);
    document.getElementById('btn-open-update-page')?.addEventListener('click', async () => {
        if (currentGame?.source_url) await openExternalUrl(currentGame.source_url);
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
        games_dir: document.getElementById('setting-games-dir')?.value.trim() || '',
        archive_mode: document.getElementById('set-launch-archive-mode')?.value || 'explorer',
        startup_scan: !!document.getElementById('toggle-startup-scan')?.checked,
        missing_grace_scans: parseInt(document.getElementById('setting-missing-grace-scans')?.value || '3', 10) || 3,
        preferred_source: document.getElementById('set-preferred-source')?.value || appSettings?.preferred_source || 'f95zone',
        automatic_update_checks: !!document.getElementById('toggle-automatic-update-checks')?.checked,
    };
}

function syncSettingsDirtyState(state = null) {
    const button = document.getElementById('btn-save-preferences');
    const status = document.getElementById('settings-save-status');
    if (!button || !status) return;
    if (state) {
        status.textContent = state;
        status.dataset.state = state.toLowerCase().replace(/\s+/g, '-');
    }
    const dirty = settingsBaseline !== null && JSON.stringify(collectSettingsPayload()) !== JSON.stringify(settingsBaseline);
    button.disabled = !dirty || state === 'Saving';
    if (!state) {
        status.textContent = dirty ? 'Unsaved changes' : 'Saved';
        status.dataset.state = dirty ? 'unsaved' : 'saved';
    }
}

async function loadSettings() {
    try {
        const res = await fetch(`${API_BASE}/api/settings`);
        if (!res.ok) throw new Error('Failed to load settings');
        const settings = await res.json();
        appSettings = settings;

        const dirInput = document.getElementById('setting-games-dir');
        if (dirInput) dirInput.value = settings.games_dir || '';

        const archiveMode = document.getElementById('set-launch-archive-mode');
        if (archiveMode) archiveMode.value = settings.archive_mode || 'explorer';

        const startupScan = document.getElementById('toggle-startup-scan');
        if (startupScan) startupScan.checked = settings.startup_scan !== false;

        const missingGrace = document.getElementById('setting-missing-grace-scans');
        if (missingGrace) missingGrace.value = String(settings.missing_grace_scans || 3);

        const preferredSource = document.getElementById('set-preferred-source');
        if (preferredSource) preferredSource.value = settings.preferred_source || 'f95zone';

        const automaticChecks = document.getElementById('toggle-automatic-update-checks');
        if (automaticChecks) automaticChecks.checked = settings.automatic_update_checks ?? settings.auto_update ?? true;

        const lastUpdateCheck = document.getElementById('settings-last-update-check');
        if (lastUpdateCheck) lastUpdateCheck.textContent = settings.last_update_check_at ? formatDateTime(settings.last_update_check_at) : 'Never';
        const confirmedUpdates = document.getElementById('settings-confirmed-updates');
        if (confirmedUpdates) confirmedUpdates.textContent = String(allGames.filter(game => game.update_available === true).length);

        const extensionPath = document.getElementById('settings-extension-path');
        if (extensionPath) extensionPath.textContent = settings.extension_dir || 'Waiting for extension path...';

        renderSettingsPreferredSource(settings.preferred_source || 'f95zone');
        settingsBaseline = collectSettingsPayload();
        syncSettingsDirtyState();
        refreshSettingsMetadataQueue({ force: true }).catch((error) => {
            console.debug('Failed to refresh settings metadata queue', error);
        });
    } catch (error) {
        console.error('Failed to load settings', error);
    }
}

async function persistSettings() {
    const payload = collectSettingsPayload();
    if (!payload.games_dir) {
        syncSettingsDirtyState('Failed');
        showAppNotification('Choose a valid library directory before saving.', 'error');
        return;
    }

    const btn = document.getElementById('btn-save-preferences');
    const originalHtml = btn ? btn.innerHTML : '';
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin"></i> <span>Saving...</span>`;
    }
    syncSettingsDirtyState('Saving');
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
        appSettings = data.settings;
        settingsBaseline = collectSettingsPayload();
        syncSettingsDirtyState('Saved');
        await Promise.all([fetchStats(), fetchTags(), loadGames(), refreshSettingsMetadataQueue({ force: true })]);
        showAppNotification('Settings saved.', 'success');
    } catch (error) {
        syncSettingsDirtyState('Failed');
        showAppNotification(`Could not save settings: ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.innerHTML = originalHtml;
        }
        syncSettingsDirtyState();
        if (window.lucide) lucide.createIcons();
    }
}

let lastKnownStatsTotal = null;
let lastKnownStatsWishlist = null;
let isFetchingGames = false;

async function fetchStats() {
    try {
        const res = await fetch(`${API_BASE}/api/stats`);
        const stats = await res.json();
        
        const totalChanged = lastKnownStatsTotal !== null && lastKnownStatsTotal !== stats.total;
        const wishlistChanged = lastKnownStatsWishlist !== null && lastKnownStatsWishlist !== stats.wishlist;
        lastKnownStatsTotal = stats.total;
        lastKnownStatsWishlist = stats.wishlist;
        
        document.getElementById('stat-total-games').textContent = stats.total;
        document.getElementById('stat-wishlist-games').textContent = stats.wishlist;
        const confirmedUpdates = document.getElementById('settings-confirmed-updates');
        if (confirmedUpdates) confirmedUpdates.textContent = String(stats.confirmed_updates || 0);

        renderSettingsSummary(stats);
        
        if (stats.games_dir) {
            const dirInput = document.getElementById('setting-games-dir');
            if (dirInput && !dirInput.value) dirInput.value = stats.games_dir;
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
    const updateBadgeHtml = game.update_available === true
        ? `<button type="button" class="card-update-badge" aria-label="Update available for ${escapeHtml(game.title)}">Update available</button>`
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
            ${updateBadgeHtml}
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

    card.addEventListener('click', () => {
        const gridEl = document.getElementById('games-grid');
        if (gridEl) lastGridScrollPos = gridEl.scrollTop;
        openOverviewPage(game.id);
    });
    card.querySelector('.card-update-badge')?.addEventListener('click', (event) => {
        event.stopPropagation();
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

const UPDATE_STATUS_LABELS = {
    never_checked: 'Never checked',
    checking: 'Checking',
    up_to_date: 'Up to date',
    update_available: 'Update available',
    local_version_unknown: 'Local version unknown',
    remote_version_unavailable: 'Remote version unavailable',
    version_differs: 'Version differs',
    unsupported_source: 'Unsupported source',
    check_failed: 'Check failed',
};

function getGameUpdateStatus(game) {
    if (game?.update_status && UPDATE_STATUS_LABELS[game.update_status]) return game.update_status;
    return game?.update_available === true ? 'update_available' : 'never_checked';
}

function replaceGameState(game) {
    currentGame = game;
    const index = allGames.findIndex((entry) => entry.id === game.id);
    if (index >= 0) allGames[index] = game;
}

function setVersionInlineMessage(message = '', tone = 'info') {
    const element = document.getElementById('version-inline-message');
    if (!element) return;
    element.textContent = message;
    element.dataset.tone = tone;
}

function renderVersionUpdates(game) {
    const status = getGameUpdateStatus(game);
    const statusElement = document.getElementById('ov-update-status');
    if (statusElement) {
        statusElement.textContent = UPDATE_STATUS_LABELS[status];
        statusElement.dataset.status = status;
    }
    document.getElementById('ov-local-version-text').textContent = game.local_version || 'Unknown';
    document.getElementById('ov-latest-version-text').textContent = game.latest_version || 'Unavailable';
    document.getElementById('ov-update-source').textContent = formatSourceLabel(game.source_type);
    document.getElementById('ov-update-checked-at').textContent = game.update_checked_at ? formatDateTime(game.update_checked_at) : 'Never';
    document.getElementById('ov-update-explanation').textContent = game.update_check_error || (status === 'version_differs'
        ? 'The versions differ, but XDir could not confirm that the linked version is newer.'
        : 'Version checks use the preferred linked source.');

    const checkButton = document.getElementById('btn-check-update');
    if (checkButton) checkButton.querySelector('span').textContent = game.update_checked_at ? 'Check Again' : 'Check for Update';
    const showMarkInstalled = Boolean(game.latest_version && game.local_version !== game.latest_version);
    document.getElementById('btn-mark-latest-installed').hidden = !showMarkInstalled;
    document.getElementById('mark-installed-copy').hidden = !showMarkInstalled;
    document.getElementById('btn-open-update-page').hidden = !game.source_url;
    document.getElementById('local-version-editor').hidden = true;
}

async function checkCurrentGameForUpdate() {
    if (!currentGame) return;
    const button = document.getElementById('btn-check-update');
    if (!button || button.disabled) return;
    const idleHtml = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<i data-lucide="loader" class="spin"></i><span>Checking...</span>';
    const statusElement = document.getElementById('ov-update-status');
    if (statusElement) {
        statusElement.textContent = UPDATE_STATUS_LABELS.checking;
        statusElement.dataset.status = 'checking';
    }
    setVersionInlineMessage('Checking the linked source...');
    if (window.lucide) lucide.createIcons();
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/check-update`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Update check failed');
        replaceGameState(data.game);
        renderOverview(currentGame);
        await loadGames();
        setVersionInlineMessage(UPDATE_STATUS_LABELS[getGameUpdateStatus(currentGame)], getGameUpdateStatus(currentGame) === 'check_failed' ? 'error' : 'success');
    } catch (error) {
        renderVersionUpdates(currentGame);
        setVersionInlineMessage(error.message, 'error');
    } finally {
        button.disabled = false;
        if (button.isConnected) {
            const label = currentGame?.update_checked_at ? 'Check Again' : 'Check for Update';
            button.innerHTML = `<i data-lucide="refresh-cw"></i><span>${label}</span>`;
        } else {
            button.innerHTML = idleHtml;
        }
        if (window.lucide) lucide.createIcons();
    }
}

async function saveCurrentLocalVersion() {
    if (!currentGame) return;
    const input = document.getElementById('local-version-input');
    const button = document.getElementById('btn-save-local-version');
    const value = input?.value.trim() || '';
    if (value.length > 80) {
        setVersionInlineMessage('Local version must be 80 characters or fewer.', 'error');
        return;
    }
    button.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/local-version`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ value: value || null }),
        });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Could not save the installed version');
        replaceGameState(data.game);
        renderOverview(currentGame);
        await loadGames();
        setVersionInlineMessage('Installed version saved.', 'success');
    } catch (error) {
        setVersionInlineMessage(error.message, 'error');
    } finally {
        button.disabled = false;
    }
}

async function markLatestAsInstalled() {
    if (!currentGame) return;
    const button = document.getElementById('btn-mark-latest-installed');
    if (!button || button.disabled) return;
    button.disabled = true;
    try {
        const res = await fetch(`${API_BASE}/api/games/${currentGame.id}/mark-latest-installed`, { method: 'POST' });
        const data = await readJsonResponse(res);
        if (!res.ok) throw new Error(data.detail || 'Could not update the library record');
        replaceGameState(data.game);
        renderOverview(currentGame);
        await loadGames();
        setVersionInlineMessage('Latest linked version marked as installed.', 'success');
    } catch (error) {
        setVersionInlineMessage(error.message, 'error');
    } finally {
        button.disabled = false;
    }
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
    
    document.getElementById('ov-badge-update').style.display = game.update_available === true ? 'inline-block' : 'none';
    document.getElementById('ov-badge-version').textContent = `LOCAL: ${game.local_version || 'UNKNOWN'}`;
    document.getElementById('ov-badge-date').textContent = `RELEASED: ${game.release_date || 'N/A'}`;
    
    // Controls box
    document.getElementById('ov-launch-text').textContent = isWishlist ? 'Wishlist Item' : (isExe ? 'Launch' : 'Open Folder');
    document.getElementById('ov-path-short').textContent = isWishlist
        ? 'No local folder linked yet'
        : (game.folder_path.length > 30 ? game.folder_path.substring(0, 30) + '...' : game.folder_path);
    document.getElementById('ov-type-text').textContent = isWishlist ? 'WISHLIST ENTRY' : (isExe ? 'INSTALLED EXE' : 'ZIP/RAR ARCHIVE');
    const launchBtn = document.getElementById('ov-btn-launch');
    if (launchBtn) launchBtn.disabled = isWishlist;
    
    // Metrics
    updateStarPickerUI(game.user_score);
    document.getElementById('ov-source-name').textContent = (game.source_type || 'local').toUpperCase();
    document.getElementById('ov-platform-score').textContent = normalizeRatingText(game.rating);
    document.getElementById('ov-progress-select').value = game.playing_progress || 'unplayed';
    document.getElementById('ov-size-text').textContent = `${game.file_type.toUpperCase()} | ${game.folder_path}`;
    document.getElementById('ov-folder-full').textContent = isWishlist ? 'Link this wishlist item to a scanned local folder or executable.' : (game.folder_path || 'Unknown path');
    renderVersionUpdates(game);
    document.getElementById('ov-added-at-text').textContent = formatDateTime(game.added_at);
    document.getElementById('ov-last-seen-text').textContent = formatDateTime(game.last_seen_at);
    document.getElementById('ov-missing-status-text').textContent = `${game.missing_scan_count || 0} missed scan(s)`;

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

async function launchGame(gameId, openFolderOnly = false) {
    try {
        const res = await fetch(`${API_BASE}/api/games/${gameId}/launch`, { method: 'POST' });
        const data = await res.json();
        console.log(data.message);
    } catch (err) {
        alert("Failed to launch executable or open Explorer folder");
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
            list.innerHTML = `<div style="grid-column: span 3; padding: 24px; text-align: center; color: var(--badge-green); font-weight: 700;">All identified games have cover images and metadata synced.</div>`;
            return;
        }
        
        games.forEach(g => {
            const cleanQuery = encodeURIComponent(g.title);
            const f95Url = `https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search=${cleanQuery}`;
            const dlsiteUrl = `https://www.dlsite.com/home/fsr/=/keyword/${cleanQuery}`;
            
            list.innerHTML += `
                <div class="queue-item">
                    <div class="queue-info">
                        <h4>${g.title}</h4>
                        <span>${g.folder_path}</span>
                    </div>
                    <div style="display:flex; gap:8px;">
                        <button class="btn-secondary" style="padding:6px 10px;" onclick="window.open('${f95Url}', '_blank')">F95</button>
                        <button class="btn-secondary" style="padding:6px 10px;" onclick="window.open('${dlsiteUrl}', '_blank')">DLsite</button>
                    </div>
                </div>
            `;
        });
    } catch (err) {
        console.error("Failed to load queue", err);
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

    const initialDir = (appSettings && appSettings.games_dir) ? appSettings.games_dir : '';
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
