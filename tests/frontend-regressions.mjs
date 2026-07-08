import fs from 'fs';

const html = fs.readFileSync('frontend/index.html', 'utf8');
const js = fs.readFileSync('frontend/static/js/app.js', 'utf8');
const css = fs.readFileSync('frontend/static/css/styles.css', 'utf8');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function test(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.message);
    process.exitCode = 1;
  }
}

test('splash status id matches the JavaScript lookup', () => {
  assert(
    html.includes('id="splash-status"'),
    'Expected frontend/index.html to expose id="splash-status" for the startup label.',
  );
});

test('rescan logic does not depend on the removed quick-scan button id', () => {
  assert(
    /async function triggerRescan\(triggerButton = null\)/.test(js),
    'Expected triggerRescan to accept the clicked button instead of hardcoding a missing one.',
  );
  assert(
    !js.includes("document.getElementById('btn-quick-scan')"),
    'Expected triggerRescan to stop reading the missing btn-quick-scan element.',
  );
});

test('ignore flow closes the real overview modal instead of a missing overlay backdrop', () => {
  assert(
    js.includes("document.getElementById('overview-modal').style.display = 'none';"),
    'Expected ignore action to close #overview-modal after hiding a game.',
  );
  assert(
    !js.includes("document.getElementById('overlay-backdrop')"),
    'Expected overlay-backdrop references to be removed because that node does not exist.',
  );
});

test('main logo acts as a home control for returning to the library tab', () => {
  assert(
    html.includes('id="btn-home-logo"'),
    'Expected frontend/index.html to expose a dedicated clickable home-logo control.',
  );
  assert(
    js.includes("document.getElementById('btn-home-logo')"),
    'Expected setupEventListeners to bind the main logo control.',
  );
  assert(
    js.includes("activateTab('library')"),
    'Expected clicking the main logo to route back to the library tab.',
  );
});

test('unused local-engine header status pill is removed', () => {
  assert(
    !html.includes('id="api-status-dot"'),
    'Expected frontend/index.html to remove the unused API status dot from the header.',
  );
  assert(
    !html.includes('id="api-status-label"'),
    'Expected frontend/index.html to remove the unused API status label from the header.',
  );
  assert(
    !js.includes("document.getElementById('api-status-dot')"),
    'Expected frontend JS to stop updating the removed API status dot.',
  );
  assert(
    !js.includes("document.getElementById('api-status-label')"),
    'Expected frontend JS to stop updating the removed API status label.',
  );
});

test('wishlist overview exposes a local-entry link fallback when auto-migration misses', () => {
  assert(
    html.includes('id="ov-btn-link-local"'),
    'Expected the overview source actions to include a dedicated wishlist local-link button.',
  );
  assert(
    html.includes('id="ov-local-link-form"'),
    'Expected frontend/index.html to expose a local-link form for wishlist migration.',
  );
  assert(
    html.includes('id="ov-local-link-select"'),
    'Expected the wishlist local-link form to provide a selectable local-entry list.',
  );
  assert(
    js.includes("document.getElementById('ov-btn-link-local')"),
    'Expected frontend JS to bind the wishlist local-link control.',
  );
  assert(
    js.includes("fetch(`${API_BASE}/api/games/${currentGame.id}/linkable-local"),
    'Expected the local-link flow to request candidate local entries from the backend.',
  );
  assert(
    js.includes("fetch(`${API_BASE}/api/games/${currentGame.id}/link-local`"),
    'Expected the local-link flow to submit a manual wishlist-to-local merge request.',
  );
});

test('settings metadata actions expose a shared loading bar while long jobs run', () => {
  assert(
    html.includes('id="settings-job-progress"'),
    'Expected frontend/index.html to expose a shared settings job progress shell.',
  );
  assert(
    html.includes('id="settings-job-progress-label"'),
    'Expected frontend/index.html to expose a progress status label for long-running settings jobs.',
  );
  assert(
    html.includes('id="settings-job-progress-fill"'),
    'Expected frontend/index.html to expose a progress fill for metadata jobs.',
  );
  assert(
    html.includes('id="settings-job-progress-count"'),
    'Expected frontend/index.html to expose a numeric completed/total counter for metadata jobs.',
  );
  assert(
    html.includes('id="settings-job-progress-current"'),
    'Expected frontend/index.html to expose the current game title/status for metadata jobs.',
  );
  assert(
    js.includes('function showSettingsJobProgress('),
    'Expected frontend JS to define a helper that reveals the shared settings progress bar.',
  );
  assert(
    js.includes('function hideSettingsJobProgress('),
    'Expected frontend JS to define a helper that clears the shared settings progress bar.',
  );
  assert(
    js.includes('async function pollSettingsJobProgress('),
    'Expected frontend JS to poll backend job state for long-running metadata actions.',
  );
  assert(
    js.includes('settings-job-progress-count'),
    'Expected frontend JS to update the numeric progress counter during metadata jobs.',
  );
  assert(
    js.includes("fetch(`${API_BASE}/api/library/jobs/${jobKey}`)"),
    'Expected frontend JS to poll a backend job-status endpoint for metadata progress.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/fix-metadata`"),
    'Expected the Fix Titles action to target the backend tracked job endpoint.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/rematch-f95zone`"),
    'Expected the F95Zone rematch action to target the backend tracked job endpoint.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/flush-metadata`"),
    'Expected the bulk metadata flush action to target the backend tracked job endpoint.',
  );
  assert(
    js.includes('async function resumeActiveSettingsJob('),
    'Expected frontend JS to restore the shared progress UI when a settings metadata job is already running.',
  );
  assert(
    js.includes('pollFailures'),
    'Expected frontend JS to tolerate transient polling failures instead of immediately abandoning long-running settings jobs.',
  );
  assert(
    html.includes('id="btn-flush-metadata"'),
    'Expected frontend/index.html to expose a dedicated bulk metadata flush button in settings.',
  );
  assert(
    js.includes('function confirmFlushAllMetadata('),
    'Expected frontend JS to centralize the destructive flush confirmation flow.',
  );
  assert(
    js.includes("Type FLUSH to permanently remove scraped metadata"),
    'Expected the bulk metadata flush confirmation to require a typed phrase before starting the destructive job.',
  );
});

test('settings page exposes current defaults, source preferences, and companion health controls', () => {
  assert(
    html.includes('data-section="defaults"') &&
      html.includes('data-section="sources"') &&
      html.includes('data-section="maintenance"') &&
      html.includes('data-section="companion"'),
    'Expected the settings nav to be rebuilt around defaults, sources, maintenance, and companion sections.',
  );
  assert(
    html.includes('id="set-preferred-source"') &&
      html.includes('id="btn-settings-scan-directory"') &&
      html.includes('id="btn-settings-smart-scan"') &&
      html.includes('id="btn-settings-missing-source-scan"'),
    'Expected the settings page to expose preferred source and the current scan shortcuts.',
  );
  assert(
    html.includes('id="settings-extension-status"') &&
      html.includes('id="settings-extension-path"') &&
      html.includes('id="settings-metadata-queue-count"'),
    'Expected the settings page to surface extension health and metadata queue state.',
  );
  assert(
    js.includes('function getPreferredSourcePlatform(') &&
      js.includes("document.getElementById('set-preferred-source')") &&
      /currentWishlistPlatform\s*=\s*getPreferredSourcePlatform\(\)/.test(js) &&
      /openInteractiveSearch\(currentGame\.title \|\| currentGame\.raw_name,\s*getPreferredSourcePlatform\(\)\)/.test(js),
    'Expected the preferred source setting to drive search defaults for wishlist and unresolved-game matching.',
  );
  assert(
    !html.includes('id="toggle-auto-update"'),
    'Expected the settings revamp to remove the dead auto-update toggle instead of exposing a nonfunctional control.',
  );
});

test('wishlist cards expose direct local-source pick actions for folder and archive linking', () => {
  assert(
    js.includes('btn-card-link-folder-archive'),
    'Expected wishlist cards to render a unified Link Folder / Archive action.',
  );
  assert(
    js.includes('window.pickWishlistLocalPath = async function(id, title, pickMode)'),
    'Expected frontend JS to expose a shared wishlist local-path picker helper.',
  );
  assert(
    js.includes("window.pywebview.api.browse_local_game_file"),
    'Expected wishlist archive linking to call the desktop file picker bridge.',
  );
  assert(
    js.includes("fetch(`${API_BASE}/api/games/${id}/link-picked-local`"),
    'Expected the wishlist local-path picker to submit the selected local path to the backend merge endpoint.',
  );
  assert(
    html.includes('id="ov-btn-link-folder-archive"'),
    'Expected the overview source panel to expose a visible Link Folder / Archive action for wishlist items.',
  );
  assert(
    html.includes('id="local-path-choice-modal"'),
    'Expected index.html to include a choice modal for selecting between folder or archive linking.',
  );
  assert(
    js.includes("document.getElementById('ov-btn-link-folder-archive')"),
    'Expected frontend JS to bind the overview Link Folder / Archive control.',
  );
});

test('header wishlist button opens a dedicated wishlist modal with direct URL entry and universal source search', () => {
  assert(
    html.includes('id="btn-add-wishlist"'),
    'Expected the header to expose the add-to-wishlist button.',
  );
  assert(
    html.includes('id="ov-wishlist-modal"'),
    'Expected frontend/index.html to include the wishlist modal that the header button opens.',
  );
  assert(
    html.includes('id="wishlist-url-input"') &&
    html.includes('id="wishlist-btn-add-url"'),
    'Expected the wishlist modal to keep a direct URL add flow for RJ/thread/store links.',
  );
  assert(
    html.includes('id="wishlist-search-input"') &&
    html.includes('id="wishlist-btn-do-search"') &&
    html.includes('id="wishlist-search-results"'),
    'Expected the wishlist modal to expose the universal search controls and results list.',
  );
  assert(
    html.includes('data-platform="all"') &&
    html.includes('data-platform="f95zone"') &&
    html.includes('data-platform="dlsite"') &&
    html.includes('data-platform="itch"') &&
    html.includes('data-platform="steam"'),
    'Expected wishlist search to support all source tabs from the modal.',
  );
  assert(
    js.includes("if (typeof openWishlistModal === 'function') openWishlistModal();"),
    'Expected the header wishlist button to invoke the shared wishlist modal opener.',
  );
  assert(
    js.includes("fetch(`${API_BASE}/api/search/universal?query=${encodeURIComponent(query)}&platform=${currentWishlistPlatform}`)"),
    'Expected wishlist modal search to use the shared universal search API instead of a dead local-only flow.',
  );
});

test('header wishlist popup is mounted outside the hidden overview shell so it can open from the library view', () => {
  const overviewStart = html.indexOf('<div class="overview-modal" id="overview-modal"');
  const onboardingStart = html.indexOf('<div class="overview-modal" id="onboarding-modal"');

  assert(
    overviewStart !== -1 && onboardingStart !== -1 && onboardingStart > overviewStart,
    'Expected index.html to expose both the main overview modal and the onboarding modal shell for placement checks.',
  );

  const overviewMarkup = html.slice(overviewStart, onboardingStart);

  assert(
    !overviewMarkup.includes('id="ov-wishlist-modal"'),
    'Expected the header wishlist popup to live outside the hidden overview modal so the top-right + button can open it from the library screen.',
  );
  assert(
    !overviewMarkup.includes('id="ov-source-modal-backdrop"'),
    'Expected the shared source-modal backdrop to live outside the hidden overview modal so wishlist overlays can dim the library view.',
  );
});

test('overview source popups are mounted outside the overview stacking context so the shared backdrop cannot cover them', () => {
  const overviewStart = html.indexOf('<div class="overview-modal" id="overview-modal"');
  const onboardingStart = html.indexOf('<div class="overview-modal" id="onboarding-modal"');

  assert(
    overviewStart !== -1 && onboardingStart !== -1 && onboardingStart > overviewStart,
    'Expected index.html to expose both the overview and onboarding shells for source-popup placement checks.',
  );

  const overviewMarkup = html.slice(overviewStart, onboardingStart);

  assert(
    !overviewMarkup.includes('id="ov-interactive-search-form"'),
    'Expected the interactive source search popup to live outside #overview-modal so the shared backdrop does not render above it.',
  );
  assert(
    !overviewMarkup.includes('id="ov-link-form"'),
    'Expected the manual source-link popup to live outside #overview-modal so it shares the top-level overlay layer.',
  );
  assert(
    !overviewMarkup.includes('id="ov-local-link-form"'),
    'Expected the local-link popup to live outside #overview-modal so it is not trapped behind the shared backdrop.',
  );
});

test('wishlist popup exposes a direct browser search action that follows the selected source tab', () => {
  assert(
    html.includes('id="wishlist-btn-browser-search"'),
    'Expected the wishlist popup to expose a direct Search in Browser action next to the in-app source search controls.',
  );
  assert(
    js.includes("document.getElementById('wishlist-btn-browser-search')"),
    'Expected frontend JS to bind the wishlist browser-search action.',
  );
  assert(
    js.includes('openWishlistBrowserSearch('),
    'Expected frontend JS to route wishlist browser searches through a shared helper that respects the active source tab.',
  );
});

test('shared modal close buttons use a true icon-button layout so the close glyph stays visible', () => {
  assert(
    css.includes('.btn-icon-sm {'),
    'Expected a dedicated compact icon-button style for modal close controls.',
  );
  assert(
    css.includes('justify-content: center;') &&
    css.includes('padding: 0;') &&
    css.includes('flex-shrink: 0;'),
    'Expected compact modal icon buttons to center their glyphs without inheriting full secondary-button padding.',
  );
  assert(
    html.includes('id="btn-close-scan-workflow"') &&
    html.includes('id="ov-btn-close-interactive-search"'),
    'Expected both scan and search modals to keep explicit close controls in the shared header.',
  );
});

test('source search modal groups the query row and platform filters into a dedicated controls panel', () => {
  assert(
    html.includes('class="source-search-controls"'),
    'Expected the interactive search modal to wrap its input, chips, and status into a dedicated controls panel.',
  );
  assert(
    css.includes('.source-search-controls') &&
    css.includes('.source-search-row') &&
    css.includes('.source-search-meta'),
    'Expected shared styles for the source search controls panel so the filter/status area does not float awkwardly under the search row.',
  );
});

test('overview source actions use consistent error handling and desktop-safe external opening', () => {
  assert(
    js.includes('async function runOverviewMetadataFetch('),
    'Expected frontend JS to centralize overview metadata fetch behavior instead of duplicating divergent button logic.',
  );
  assert(
    js.includes('if (!res.ok) {'),
    'Expected overview metadata fetch actions to reject non-2xx API responses before rendering.',
  );
  assert(
    js.includes('async function openExternalUrl(url)'),
    'Expected frontend JS to centralize external URL opening for desktop/web compatibility.',
  );
  assert(
    js.includes('window.pywebview.api.open_external_url'),
    'Expected external source buttons to use the desktop bridge when available instead of relying only on window.open.',
  );
});

test('overview description section no longer exposes a duplicate metadata fetch button', () => {
  assert(
    !html.includes('id="ov-btn-fetch-desc"'),
    'Expected frontend/index.html to remove the duplicate description-level metadata fetch button.',
  );
  assert(
    !js.includes("document.getElementById('ov-btn-fetch-desc')"),
    'Expected frontend JS to stop binding the removed description-level metadata fetch button.',
  );
  assert(
    !js.includes("const descBtn = document.getElementById('ov-btn-fetch-desc')"),
    'Expected overview rendering to stop toggling visibility for the removed duplicate metadata button.',
  );
});

test('overview source panel exposes one shared Search action instead of four duplicated platform buttons', () => {
  assert(
    html.includes('id="ov-btn-search-source"'),
    'Expected the overview source panel to expose a single shared Search button.',
  );
  assert(
    html.includes('>Search</span>'),
    'Expected the shared overview source button label to read Search.',
  );
  assert(
    !html.includes('id="ov-btn-fetch-f95"') &&
    !html.includes('id="ov-btn-search-dlsite"') &&
    !html.includes('id="ov-btn-search-itch"') &&
    !html.includes('id="ov-btn-search-steam"'),
    'Expected the old per-platform overview search buttons to be removed from index.html.',
  );
  assert(
    js.includes("document.getElementById('ov-btn-search-source')"),
    'Expected frontend JS to bind the single shared overview Search button.',
  );
  assert(
    js.includes("openInteractiveSearch(currentGame.title || currentGame.raw_name, 'all')"),
    'Expected the shared Search button to open the existing interactive search modal with all sources.',
  );
  assert(
    css.includes('.src-btn-search') &&
    css.includes('linear-gradient(135deg, rgba(37, 99, 235, 0.94), rgba(14, 165, 233, 0.88))'),
    'Expected the shared Search button to use the brighter blue styling instead of the darker per-platform variants.',
  );
});

test('overview source search controls stay button-typed and renderOverview refreshes the active game state', () => {
  assert(
    html.includes('type="button" class="src-action-btn src-action-search src-btn-search" id="ov-btn-search-source"'),
    'Expected the shared overview Search button to declare type="button" so it cannot degrade into a no-op implicit submit control.',
  );
  assert(
    html.includes('type="button" class="btn-primary" id="ov-btn-do-interactive-search"'),
    'Expected the modal Search trigger to declare type="button" so it consistently routes through the JS search handler.',
  );
  assert(
    js.includes('function renderOverview(game)') && js.includes('currentGame = game;'),
    'Expected renderOverview to keep currentGame synchronized with the visible overview so source-action buttons do not bail out on stale state.',
  );
});

test('overview cover swaps only after the new image has loaded to avoid one-time broken cover flashes', () => {
  assert(
    js.includes('function updateOverviewCover(coverUrl, title = \'\')'),
    'Expected frontend JS to centralize overview cover rendering in a dedicated loader helper.',
  );
  assert(
    js.includes('const preloader = new Image();'),
    'Expected the overview cover helper to preload the next cover image before showing it.',
  );
  assert(
    js.includes('coverImg.dataset.pendingSrc = nextUrl;'),
    'Expected overview cover updates to track the pending image source so stale async loads cannot win.',
  );
  assert(
    js.includes('updateOverviewCover(game.cover_url, game.title);'),
    'Expected renderOverview to route cover updates through the guarded overview cover helper.',
  );
});

test('overview cover stage uses a wide adaptive media panel instead of a forced portrait thumbnail slot', () => {
  assert(
    html.includes('id="ov-about-card"') &&
    html.includes('id="ov-snapshot-card"'),
    'Expected frontend/index.html to expose stable overview card hooks so the image, about panel, and snapshot panel can be laid out independently.',
  );
  assert(
    css.includes('grid-template-columns: minmax(0, 1fr) 320px;') &&
    css.includes('grid-template-areas:') &&
    css.includes('"cover snapshot"') &&
    css.includes('"about snapshot"'),
    'Expected styles.css to promote the overview artwork into the main content column instead of squeezing it into a narrow fixed sidebar slot.',
  );
  assert(
    !css.includes('aspect-ratio: 3 / 4.1;'),
    'Expected the overview cover frame to stop enforcing the old portrait aspect ratio that made wide artwork look tiny and mismatched.',
  );
  assert(
    css.includes('width: 100%;') &&
    css.includes('height: auto;') &&
    css.includes('max-height: min(460px, 58vh);'),
    'Expected the overview cover image to render at full column width while preserving its natural aspect ratio within a sensible height cap.',
  );
  assert(
    css.includes('align-items: flex-start;') &&
    css.includes('justify-content: center;') &&
    css.includes('padding: 16px;'),
    'Expected the overview cover frame to act as a flexible stage around the real image instead of a decorative crop mask.',
  );
  assert(
    js.includes("document.getElementById('ov-cover-frame')"),
    'Expected updateOverviewCover to keep targeting the dedicated overview cover frame for presentation state.',
  );
  assert(
    !js.includes("--ov-cover-art"),
    'Expected the overview cover loader to stop relying on the rejected blurred-backdrop treatment.',
  );
});

test('overview control box keeps one primary open action and removes the duplicate folder icon button', () => {
  assert(
    !html.includes('id="ov-btn-folder"'),
    'Expected frontend/index.html to remove the duplicate overview folder icon button when the primary action already covers opening.',
  );
  assert(
    !js.includes("document.getElementById('ov-btn-folder')"),
    'Expected frontend JS to stop binding the removed duplicate overview folder icon button.',
  );
  assert(
    !js.includes('launchGame(currentGame.id, true)'),
    'Expected the removed overview folder icon button to stop calling launchGame with an ignored folder-only flag.',
  );
  assert(
    css.includes('.ov-primary-actions {') &&
    css.includes('.ov-primary-actions .btn-launch-big,') &&
    css.includes('.ov-primary-actions .btn-fetch-info {') &&
    css.includes('width: 100%;'),
    'Expected the overview primary action buttons to share a full-width stacked layout so Open Folder matches Fetch Info.',
  );
});

test('available and wishlist pool counts stay accurate and auto-reload on background changes', () => {
  assert(
    js.includes('setInterval(fetchStats, 3000)'),
    'Expected frontend JS to poll stats periodically to catch background and extension pool changes.',
  );
  assert(
    js.includes('const totalChanged = lastKnownStatsTotal !== null && lastKnownStatsTotal !== stats.total;'),
    'Expected fetchStats to detect changes in the available games pool count.',
  );
  assert(
    js.includes('const wishlistChanged = lastKnownStatsWishlist !== null && lastKnownStatsWishlist !== stats.wishlist;'),
    'Expected fetchStats to detect changes in the wishlist games pool count.',
  );
  assert(
    js.includes('if ((totalChanged || wishlistChanged) && !isFetchingGames && typeof loadGames === \'function\') {'),
    'Expected fetchStats to trigger loadGames when available or wishlist pool counts change.',
  );
});

test('source search and link forms use dedicated non-overlapping modal overlays with metadata injection', () => {
  assert(
    html.includes('id="ov-source-modal-backdrop"'),
    'Expected index.html to expose a dedicated backdrop for search and linking modal overlays.',
  );
  assert(
    html.includes('id="ov-interactive-search-form"') &&
    html.includes('source-modal-centered') &&
    css.includes('.source-modal-centered'),
    'Expected interactive search form to use the shared centered modal overlay class.',
  );
  assert(
    js.includes('function showSourceModalBackdrop('),
    'Expected app.js to define a helper to toggle the source modal backdrop.',
  );
  assert(
    js.includes('title: decodeURIComponent(btn.dataset.title || \'\')') &&
    js.includes('developer: decodeURIComponent(btn.dataset.creator || \'\')'),
    'Expected interactive search source linking to pass title and developer metadata in the payload.',
  );
});

test('interactive source search uses one Link action and does not wipe click handlers after rendering results', () => {
  assert(
    js.includes('btn-src-select-link'),
    'Expected interactive source search results to expose a single Link action instead of split Prefer/Add buttons.',
  );
  assert(
    !js.includes('btn-src-select-pref'),
    'Expected the interactive source search modal to stop rendering a separate Prefer button.',
  );
  assert(
    js.includes('<span>Link</span>'),
    'Expected the interactive source search modal primary action label to read Link.',
  );
  assert(
    js.includes('make_preferred: false'),
    'Expected interactive source search linking to add the selected source without forcing preferred state from the modal.',
  );
  assert(
    !js.includes("resultsDiv.innerHTML +="),
    'Expected interactive source search to stop rewriting its results container after binding click handlers.',
  );
  assert(
    js.includes("resultsDiv.insertAdjacentHTML('beforeend'") ||
      js.includes("resultsDiv.innerHTML = data.results.map(item =>") && js.includes('+ fallbackSearchHtml'),
    'Expected interactive source search to append the browser fallback without replacing already-bound result rows.',
  );
  assert(
    js.includes('btn-src-prefer'),
    'Expected the overview source list to keep a separate prefer control on the main page outside the search modal.',
  );
});

test('ui polish moves repeated modal, chip, and star-picker presentation into shared CSS hooks', () => {
  assert(
    /--border-subtle:\s*rgba\(255,\s*255,\s*255,\s*0\.05\)/.test(css),
    'Expected styles.css to add a subtle divider token for the quieter chrome pass.',
  );
  assert(
    /--radius-sm:\s*8px/.test(css) &&
    /--radius-md:\s*12px/.test(css) &&
    /--radius-lg:\s*16px/.test(css),
    'Expected styles.css to define shared radius tokens for consistent spacing and corners.',
  );
  assert(
    /--shadow-card:\s*0 2px 8px rgba\(0,\s*0,\s*0,\s*0\.3\)/.test(css) &&
    /--shadow-elevated:\s*0 8px 24px rgba\(0,\s*0,\s*0,\s*0\.45\)/.test(css),
    'Expected styles.css to define subtler shared elevation tokens.',
  );
  assert(
    css.includes('.platform-chip') &&
    css.includes('.user-star-btn') &&
    css.includes('.source-modal-centered'),
    'Expected styles.css to expose shared classes for chips, star controls, and centered source modals.',
  );
  assert(
    css.includes('::-webkit-scrollbar'),
    'Expected styles.css to add custom scrollbar styling for the UI polish pass.',
  );
  assert(
    !/class="btn-secondary platform-chip[^"]*"[^>]*style=/.test(html),
    'Expected platform-chip buttons to stop carrying repeated inline presentation styles in index.html.',
  );
  assert(
    !/class="user-star-btn"[^>]*style=/.test(html),
    'Expected user star buttons to stop carrying repeated inline presentation styles in index.html.',
  );
  assert(
    /class="source-link-form source-modal-centered(?:\s|")/.test(html),
    'Expected centered source/search modal overlays to use a shared source-modal-centered class.',
  );
});

test('scan directory button launches an enhanced scan chooser while smart scan progress moves into a background indicator and results dialog', () => {
  assert(
    html.includes('id="scan-workflow-modal"'),
    'Expected frontend/index.html to include a dedicated scan chooser modal.',
  );
  assert(
    html.includes('id="btn-scan-normal"') &&
      html.includes('id="btn-scan-smart"') &&
      html.includes('id="btn-scan-missing-source"'),
    'Expected the chooser modal to expose Normal Scan, Smart Metadata Scan, and a missing-source-only scan action.',
  );
  assert(
    html.includes('id="scan-toolbar-progress"') &&
      html.includes('id="scan-toolbar-progress-fill"') &&
      html.includes('id="scan-toolbar-progress-label"'),
    'Expected the library toolbar to expose a compact smart-scan progress indicator while the background job runs.',
  );
  assert(
    html.includes('id="scan-results-modal"') &&
      html.includes('id="smart-scan-summary-title"') &&
      html.includes('id="smart-scan-review-list"'),
    'Expected smart-scan completion and review content to move into a separate results dialog.',
  );
  assert(
    css.includes('.scan-workflow-view[hidden]') || css.includes('.scan-results-view[hidden]'),
    'Expected hidden scan dialog views to stay hidden instead of stacking into one long layout.',
  );
  assert(
    js.includes('function openScanWorkflowModal('),
    'Expected frontend JS to route the Scan Directory button through an enhanced modal opener.',
  );
  assert(
    js.includes("openScanWorkflowModal()"),
    'Expected the Scan Directory button listener to open the workflow modal instead of firing the scan immediately.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/smart-scan`"),
    'Expected frontend JS to start the new smart metadata scan through its dedicated backend endpoint.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/missing-source-scan`"),
    'Expected frontend JS to expose a separate missing-source-only scan endpoint without changing the existing smart scan route.',
  );
  assert(
    js.includes('renderScanToolbarProgress'),
    'Expected frontend JS to keep a compact toolbar progress indicator updated while smart scan runs in the background.',
  );
  assert(
    js.includes('showScanResultsModal') &&
      js.includes('renderSmartScanSummary'),
    'Expected frontend JS to open a dedicated results dialog after the background smart scan completes.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/smart-scan/review/${gameId}/apply`"),
    'Expected frontend JS to apply manual-review candidates through a dedicated smart-scan endpoint.',
  );
  assert(
    js.includes("`${API_BASE}/api/library/jobs/${activeScanJobKey}/cancel`") ||
      js.includes("`${API_BASE}/api/library/jobs/smart-scan/cancel`"),
    'Expected frontend JS to call the backend cancellation endpoint when the running smart scan details are opened.',
  );
});

test('smart scan review rows can render a thumbnail beside unresolved games', () => {
  assert(
    js.includes('thumbnail_url') || html.includes('smart-review-thumb'),
    'Expected unresolved review rows to support a thumbnail beside each game when a candidate cover is available.',
  );
});
