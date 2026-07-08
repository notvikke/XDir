import fs from 'fs';

const appPy = fs.readFileSync('app.py', 'utf8');
const configPy = fs.readFileSync('backend/config.py', 'utf8');
const databasePy = fs.readFileSync('backend/database.py', 'utf8');
const frontendCss = fs.readFileSync('frontend/static/css/styles.css', 'utf8');
const frontendHtml = fs.readFileSync('frontend/index.html', 'utf8');
const frontendJs = fs.readFileSync('frontend/static/js/app.js', 'utf8');
const mainPy = fs.readFileSync('backend/main.py', 'utf8');
const sourceMapPy = fs.readFileSync('backend/source_map.py', 'utf8');
const specFile = fs.readFileSync('XDir.spec', 'utf8');
const runtimePy = fs.readFileSync('backend/runtime.py', 'utf8');

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

test('settings-triggered ingestion does not capture the request database session', () => {
  assert(
    mainPy.includes('background_tasks.add_task(run_ingestion)'),
    'Expected settings save flow to schedule run_ingestion without reusing the request-scoped db session.',
  );
  assert(
    !mainPy.includes('background_tasks.add_task(run_ingestion, db)'),
    'Expected request-scoped db session handoff to background task to be removed.',
  );
});

const ingestPy = fs.readFileSync('backend/ingest.py', 'utf8');

test('dedupe merges identified games that share a normalized source URL even without a source id', () => {
  assert(
    ingestPy.includes('elif g.source_url and g.source_type != "unknown":'),
    'Expected dedupe to consider identified source URLs when source_id is unavailable.',
  );
  assert(
    ingestPy.includes('key = ("source_url", (g.source_type or "unknown").lower(), g.source_url.lower())'),
    'Expected source-url-based dedupe keys for installed duplicates such as Itch entries.',
  );
});

test('wishlist items can auto-graduate into scanned local games by matching source metadata', () => {
  assert(
    ingestPy.includes('game = db.query(Game).filter(Game.file_type == "wishlist", Game.source_url == source_url).first()'),
    'Expected ingestion to look for wishlist entries with the same normalized source URL when scanning new local games.',
  );
  assert(
    ingestPy.includes('game = db.query(Game).filter(Game.source_id == source_id).first()'),
    'Expected ingestion to keep the source-id-based wishlist graduation path for RJ/thread-linked games.',
  );
});

test('portable mode stores live user data under a dedicated data directory instead of code folders', () => {
  assert(
    runtimePy.includes('def get_data_root() -> str:'),
    'Expected a runtime helper for resolving the portable data directory.',
  );
  assert(
    runtimePy.includes('data_root = os.path.join(get_app_root(), "data")'),
    'Expected portable mode to keep live user data in an app-local data folder.',
  );
  assert(
    databasePy.includes('DB_PATH = os.path.join(get_data_root(), "library.db")'),
    'Expected the live SQLite library to be stored under the portable data directory.',
  );
  assert(
    configPy.includes('SETTINGS_FILE = os.path.join(get_data_root(), "settings.json")'),
    'Expected persisted settings to be stored under the portable data directory.',
  );
  assert(
    appPy.includes('local_cache_dir = os.path.join(DATA_ROOT, "cache")'),
    'Expected the embedded WebView cache to live under the portable data directory instead of the repo root.',
  );
});

test('metadata links are snapshotted to a durable source map so rescans can recover without exact folder names', () => {
  assert(
    fs.existsSync('backend/source_map.py'),
    'Expected a backend/source_map.py module for durable portable metadata snapshots.',
  );
  const sourceMapPy = fs.readFileSync('backend/source_map.py', 'utf8');
  assert(
    sourceMapPy.includes('SOURCE_MAP_PATH = os.path.join(get_data_root(), "source-map.json")'),
    'Expected a durable source map file under portable data storage.',
  );
  assert(
    sourceMapPy.includes('def persist_game_snapshot(game: Game) -> None:'),
    'Expected a helper that snapshots resolved metadata and source links for each game.',
  );
  assert(
    sourceMapPy.includes('"screenshots": [s.url for s in game.screenshots]'),
    'Expected durable snapshots to preserve screenshot URLs for portable recovery.',
  );
  assert(
    sourceMapPy.includes('"journal_entries": [j.entry_text for j in game.journal_entries]'),
    'Expected durable snapshots to preserve journal entries for portable recovery.',
  );
  assert(
    ingestPy.includes('source_snapshot = find_source_map_entry(folder_path, raw, item["title"])'),
    'Expected ingestion to consult the durable source map before falling back to noisy local names.',
  );
  assert(
    mainPy.includes('from backend.source_map import persist_game_snapshot'),
    'Expected metadata update flows to persist source-map snapshots whenever the user enriches a game.',
  );
});

test('startup runs a maintenance dedupe pass even when startup scanning is disabled', () => {
  assert(
    appPy.includes('schedule_library_maintenance()'),
    'Expected desktop startup to schedule library maintenance separately from the server boot path.',
  );
  assert(
    appPy.includes('deduplicate_games(maintenance_db)'),
    'Expected scheduled maintenance to still run a dedupe pass against the existing library database.',
  );
  assert(
    !appPy.includes('def start_server():\n    init_db()\n    maintenance_db = SessionLocal()'),
    'Expected the API server boot path to stop doing synchronous dedupe work before listening.',
  );
});

test('desktop startup shows a visible splash immediately instead of hiding the window until the API responds', () => {
  assert(
    appPy.includes('STARTUP_SPLASH_HTML = """'),
    'Expected the desktop entry point to define a lightweight startup splash HTML payload.',
  );
  assert(
    appPy.includes('html=STARTUP_SPLASH_HTML'),
    'Expected the first window paint to use the local splash HTML instead of waiting for the full app URL.',
  );
  assert(
    appPy.includes('window.load_url(APP_URL)'),
    'Expected the visible splash window to navigate into the real app after the local API becomes ready.',
  );
  assert(
    !appPy.includes('hidden=True'),
    'Expected the desktop window to stop booting in a hidden state.',
  );
  assert(
    !appPy.includes('for _ in range(50):'),
    'Expected startup to stop using the old blocking poll loop before creating the window.',
  );
});

test('desktop boot path avoids unnecessary heavyweight imports on the critical path', () => {
  assert(
    !appPy.includes('import requests'),
    'Expected the desktop entry point to avoid importing requests just for localhost readiness checks.',
  );
  assert(
    !appPy.includes('\nimport uvicorn\n'),
    'Expected the desktop entry point to avoid importing uvicorn at module import time before the splash can appear.',
  );
  assert(
    !appPy.includes('\nimport webview\n'),
    'Expected the desktop entry point to avoid importing pywebview at module import time before the splash can appear.',
  );
  assert(
    !appPy.includes('from backend.main import app as fastapi_app'),
    'Expected the FastAPI app to be imported lazily instead of on the desktop module critical path.',
  );
  assert(
    !appPy.includes('from backend.database import SessionLocal'),
    'Expected database session helpers to load lazily for background maintenance only after the splash appears.',
  );
  assert(
    appPy.includes('def load_webview_module():'),
    'Expected a dedicated lazy loader for the pywebview dependency.',
  );
  assert(
    appPy.includes('def get_fastapi_app():'),
    'Expected a dedicated lazy loader for the FastAPI app dependency.',
  );
  assert(
    !mainPy.includes('from backend.scraper import fetch_game_metadata, fetch_all_missing_metadata'),
    'Expected backend startup to avoid importing scraper helpers globally before the app is even opened.',
  );
});

test('desktop startup splash exposes real progress updates instead of an indeterminate background wait', () => {
  assert(
    appPy.includes('id="boot-progress-bar"'),
    'Expected the startup splash to include a concrete progress bar element.',
  );
  assert(
    appPy.includes('id="boot-progress-label"'),
    'Expected the startup splash to include a visible progress label for launch stages.',
  );
  assert(
    appPy.includes('style.width = `${safeProgress}%`;'),
    'Expected splash status updates to push numeric progress into the visible progress bar.',
  );
  assert(
    appPy.includes('set_startup_status(window, "Opening XDir...", "Preparing the desktop shell for launch.", 8)'),
    'Expected the splash to begin with an immediate visible launch stage rather than silent waiting.',
  );
});

test('dedupe has a guarded title-based fallback for weak archive/install clones', () => {
  assert(
    ingestPy.includes('duplicate_keys.setdefault(("base_title", base_title), []).append(g)'),
    'Expected dedupe to bucket non-wishlist records by normalized base title as a fallback path.',
  );
  assert(
    ingestPy.includes('def should_merge_title_group(grouped_games: list[Game]) -> bool:'),
    'Expected a dedicated guard for deciding whether title-based duplicate groups are safe to merge.',
  );
  assert(
    ingestPy.includes('has_archive and has_launchable'),
    'Expected title-based fallback merges to require an archive/install pair instead of all title matches.',
  );
});

test('localhost API is not left open to arbitrary web origins in release builds', () => {
  assert(
    !mainPy.includes('allow_origins=["*"]'),
    'Expected wildcard CORS access to be removed from the local API.',
  );
  assert(
    mainPy.includes('allow_origin_regex=TRUSTED_EXTENSION_ORIGIN_REGEX'),
    'Expected the API to explicitly allow trusted browser extension origins via regex.',
  );
  assert(
    mainPy.includes('async def enforce_trusted_local_api_origin(request: Request, call_next):'),
    'Expected a request-origin enforcement middleware for the local API.',
  );
  assert(
    mainPy.includes('return JSONResponse(status_code=403, content={"detail": "Forbidden origin"})'),
    'Expected untrusted cross-origin requests to be rejected with HTTP 403.',
  );
});

test('desktop entry point assigns an explicit Windows app identity and custom taskbar icon', () => {
  assert(
    appPy.includes('SetCurrentProcessExplicitAppUserModelID'),
    'Expected app startup to assign a stable Windows AppUserModelID instead of inheriting pythonw.exe identity.',
  );
  assert(
    appPy.includes('window.gui.Icon = icon_obj'),
    'Expected the native webview window to receive a custom icon for taskbar/titlebar display.',
  );
  assert(
    appPy.includes('APP_ICON_RELATIVE_PATH = os.path.join("extension", "icon128.png")'),
    'Expected the desktop app to reuse a bundled icon asset instead of the Python default icon.',
  );
});

test('window dragging is limited to the native window controls titlebar strip', () => {
  assert(
    appPy.includes('easy_drag=False'),
    'Expected pywebview easy_drag to be disabled so the app does not drag from arbitrary content regions.',
  );
  assert(
    appPy.includes("webview.settings['DRAG_REGION_DIRECT_TARGET_ONLY'] = True"),
    'Expected pywebview drag regions to ignore child controls so the window buttons stay clickable.',
  );
  assert(
    frontendHtml.includes('<header class="top-nav pywebview-drag-region">'),
    'Expected the native drag region to cover the titlebar row rather than only the window buttons cluster.',
  );
  assert(
    frontendCss.includes('.pywebview-drag-region {'),
    'Expected a dedicated pywebview drag-region style for the titlebar controls strip only.',
  );
  assert(
    !frontendJs.includes('pywebview.api.start_drag'),
    'Expected the manual HTCAPTION drag shim to be removed once native pywebview drag regions are in use.',
  );
  assert(
    !frontendHtml.includes('<div class="window-controls pywebview-drag-region">'),
    'Expected the window-controls cluster itself to stay clickable instead of being the only draggable target.',
  );
  assert(
    frontendHtml.includes('class="titlebar-drag-spacer pywebview-drag-region"'),
    'Expected the titlebar to include a dedicated drag spacer so the custom header always exposes a draggable strip.',
  );
});

test('frameless desktop shell exposes explicit native resize handles on every edge and corner', () => {
  assert(
    appPy.includes('def start_resize(self, edge):'),
    'Expected the desktop window bridge to expose a native resize entrypoint for frameless edge dragging.',
  );
  assert(
    appPy.includes('0x0112') && appPy.includes('0xF000'),
    'Expected frameless resize to delegate to the native Windows sizing command instead of resizing ad hoc in JS.',
  );
  assert(
    frontendHtml.includes('data-resize-edge="top-left"') &&
    frontendHtml.includes('data-resize-edge="top"') &&
    frontendHtml.includes('data-resize-edge="top-right"') &&
    frontendHtml.includes('data-resize-edge="right"') &&
    frontendHtml.includes('data-resize-edge="bottom-right"') &&
    frontendHtml.includes('data-resize-edge="bottom"') &&
    frontendHtml.includes('data-resize-edge="bottom-left"') &&
    frontendHtml.includes('data-resize-edge="left"'),
    'Expected the frameless shell to render invisible resize hit areas for each edge and corner.',
  );
  assert(
    frontendCss.includes('.window-resize-hitbox') &&
    frontendCss.includes('cursor: nwse-resize;') &&
    frontendCss.includes('cursor: nesw-resize;') &&
    frontendCss.includes('cursor: ns-resize;') &&
    frontendCss.includes('cursor: ew-resize;'),
    'Expected the frameless resize hit areas to expose the correct native resize cursors.',
  );
  assert(
    frontendJs.includes('function setupWindowResizeHandles()'),
    'Expected frontend JS to define a dedicated resize-handle binder for the frameless desktop shell.',
  );
  assert(
    frontendJs.includes('window.pywebview.api.start_resize'),
    'Expected resize handles to call the desktop bridge instead of relying on browser-only resizing.',
  );
});

test('windows packaging config exists for generating a branded exe release', () => {
  assert(
    specFile.includes("name='XDir'"),
    'Expected a PyInstaller spec file that builds an executable named XDir.',
  );
  assert(
    specFile.includes("icon='XDir.ico'"),
    'Expected the Windows release build to stamp the executable with the XDir icon.',
  );
  assert(
    specFile.includes("('frontend', 'frontend')") && specFile.includes("('extension', 'extension')"),
    'Expected the release build to bundle the frontend and extension assets.',
  );
  assert(
    specFile.includes('upx=False'),
    'Expected the Windows release build to avoid UPX compression because it can hurt first-launch startup time and trigger extra scanning.',
  );
});

test('frozen builds resolve config and database paths from the app runtime root', () => {
  assert(
    configPy.includes('from backend.runtime import get_data_root'),
    'Expected config persistence to resolve from the shared portable-data runtime helper.',
  );
  assert(
    configPy.includes('SETTINGS_FILE = os.path.join(get_data_root(), "settings.json")'),
    'Expected settings.json to live under the portable data root in frozen builds.',
  );
  assert(
    databasePy.includes('DB_PATH = os.path.join(get_data_root(), "library.db")'),
    'Expected the SQLite library path to resolve from the portable data root in frozen builds.',
  );
});

test('frozen builds resolve bundled frontend and extension assets from the PyInstaller bundle root', () => {
  const runtimePy = fs.readFileSync('backend/runtime.py', 'utf8');
  assert(
    runtimePy.includes('def get_bundle_root() -> str:'),
    'Expected a dedicated runtime helper for locating bundled read-only assets in frozen builds.',
  );
  assert(
    runtimePy.includes('meipass = getattr(sys, "_MEIPASS", None)'),
    'Expected frozen bundle asset lookup to prefer the PyInstaller _MEIPASS directory.',
  );
  assert(
    mainPy.includes('from backend.runtime import get_app_root, get_bundle_root'),
    'Expected backend startup to import both runtime-root helpers.',
  );
  assert(
    mainPy.includes('BUNDLE_ROOT = get_bundle_root()'),
    'Expected backend startup to resolve a dedicated bundle root for packaged frontend assets.',
  );
  assert(
    mainPy.includes('FRONTEND_DIR = os.path.join(BUNDLE_ROOT, "frontend")') &&
      mainPy.includes('EXTENSION_DIR = os.path.join(BUNDLE_ROOT, "extension")'),
    'Expected frontend and extension assets to resolve from the bundle root in frozen builds.',
  );
  assert(
    appPy.includes('APP_ICON_PATH = os.path.join(BUNDLE_ROOT, APP_ICON_RELATIVE_PATH)'),
    'Expected the desktop app icon to be loaded from the bundled asset root instead of the writable app root.',
  );
});

test('backend exposes a manual wishlist-to-local linking flow as a fallback when auto-graduation misses', () => {
  assert(
    mainPy.includes('@app.get("/api/games/{game_id}/linkable-local")'),
    'Expected the API to expose searchable local-link candidates for wishlist entries.',
  );
  assert(
    mainPy.includes('@app.post("/api/games/{game_id}/link-local")'),
    'Expected the API to expose a manual wishlist-to-local linking endpoint.',
  );
  assert(
    mainPy.includes('from backend.ingest import run_ingestion, determine_source_info, merge_game_records'),
    'Expected the manual link flow to reuse the existing merge logic instead of duplicating merge behavior.',
  );
});

test('wishlist entries are auto-removed when the real game already exists in the available library', () => {
  assert(
    ingestPy.includes('def cleanup_redundant_wishlist_entries(db: Session, game: Game) -> int:'),
    'Expected ingestion helpers to expose a reusable wishlist-cleanup path for real library entries.',
  );
  assert(
    mainPy.includes('from backend.ingest import run_ingestion, determine_source_info, merge_game_records, cleanup_redundant_wishlist_entries'),
    'Expected backend flows to import the shared wishlist-cleanup helper alongside merge logic.',
  );
  assert(
    mainPy.includes('existing_game = db.query(Game).filter(Game.source_id == source_id, Game.file_type != "wishlist").first()'),
    'Expected add-to-wishlist to short-circuit when the same identified game already exists outside the wishlist.',
  );
  assert(
    mainPy.includes('cleanup_redundant_wishlist_entries(db, game)'),
    'Expected metadata/linking flows to purge redundant wishlist clones after a real game becomes identified.',
  );
});

test('wishlist entries can be linked directly to a picked local folder or archive path', () => {
  const scannerPy = fs.readFileSync('backend/scanner.py', 'utf8');
  assert(
    scannerPy.includes('def scan_single_game_path(selected_path: str) -> Optional[Dict[str, Any]]:'),
    'Expected scanner helpers to expose a single-path parser for manual wishlist local linking.',
  );
  assert(
    mainPy.includes('@app.post("/api/games/{game_id}/link-picked-local")'),
    'Expected the API to expose a direct picked-path wishlist linking endpoint.',
  );
  assert(
    mainPy.includes('from backend.scanner import inspect_archive, scan_single_game_path'),
    'Expected backend startup to import the single-path scanner helper for wishlist local linking.',
  );
  assert(
    mainPy.includes('scan_single_game_path(payload.selected_path)'),
    'Expected the picked-path wishlist link endpoint to normalize the chosen folder/archive before merging.',
  );
  assert(
    appPy.includes('def browse_local_game_file(self, initial_dir=None):'),
    'Expected the desktop bridge to expose a native file picker for archive/exe wishlist linking.',
  );
  assert(
    appPy.includes('create_file_dialog(webview.OPEN_DIALOG'),
    'Expected the desktop bridge to use a native open-file dialog for archive/exe wishlist linking.',
  );
});

test('source-linking routes scrape the user-selected source instead of reusing stale preferred-source state', () => {
  const scraperPy = fs.readFileSync('backend/scraper.py', 'utf8');
  assert(
    scraperPy.includes('def fetch_source_metadata(source_type: Optional[str], source_url: Optional[str], source_id: Optional[str]) -> Dict[str, Any]:'),
    'Expected scraper helpers to expose a direct source-metadata fetcher independent of the Game model state.',
  );
  assert(
    scraperPy.includes('def apply_metadata_to_game(game: Game, db: Session, data: Dict[str, Any], force_overwrite: bool = True) -> Game:'),
    'Expected metadata application to be split from source selection so linking flows can scrape arbitrary selected sources.',
  );
  assert(
    mainPy.includes('data = fetch_source_metadata(source_type, source_url, source_id)'),
    'Expected manual link and add-source flows to scrape the just-selected source rather than relying on the game\'s prior preferred source state.',
  );
  assert(
    mainPy.includes('src.source_type,') &&
      mainPy.includes('src.source_url,') &&
      mainPy.includes('src.source_id,') &&
      mainPy.includes('context_label="preferred"'),
    'Expected the prefer-source action to route the newly preferred source entry through the shared metadata refresh helper.',
  );
  assert(
    mainPy.includes('No metadata could be loaded from the {context_label}') ||
      mainPy.includes('metadata refresh failed'),
    'Expected source-linking routes to surface scrape failures instead of silently reporting success with no metadata refresh.',
  );
});

test('source-linking routes keep the selected source linked even when live scraping returns no metadata', () => {
  assert(
    mainPy.includes('def try_apply_source_metadata('),
    'Expected backend source-linking routes to share a best-effort metadata helper instead of hard-failing after a successful link selection.',
  );
  assert(
    mainPy.includes('response["warning"] = warning'),
    'Expected source-linking responses to return a warning payload when scraping fails after the source link itself succeeds.',
  );
  assert(
    mainPy.includes('linked successfully, but metadata refresh failed') ||
      mainPy.includes('linked to') && mainPy.includes('metadata fetch failed'),
    'Expected source-linking responses to distinguish a successful link from a metadata refresh warning.',
  );
});

test('itch search supplements store results with a site-search fallback for adult pages', () => {
  const scraperPy = fs.readFileSync('backend/scraper.py', 'utf8');
  assert(
    scraperPy.includes('https://html.duckduckgo.com/html/?q='),
    'Expected itch search to use a site-search fallback because the first-party itch.io search endpoint no longer reliably surfaces adult/deindexed project pages.',
  );
  assert(
    scraperPy.includes('site:itch.io ') || scraperPy.includes("site:itch.io "),
    'Expected the fallback query to stay scoped to itch.io project URLs rather than broad web results.',
  );
  assert(
    scraperPy.includes('def _search_itch_site_fallback('),
    'Expected scraper helpers to expose a dedicated itch site-search fallback path for adult-store lookups.',
  );
  assert(
    scraperPy.includes('fallback_results = _search_itch_site_fallback(query)'),
    'Expected primary itch search results to be supplemented with fallback matches instead of relying only on itch.io/store search.',
  );
});

test('desktop bridge exposes a native external URL opener for overview source buttons', () => {
  assert(
    appPy.includes('def open_external_url(self, url):'),
    'Expected the desktop bridge to expose a native external URL opener for source search buttons.',
  );
  assert(
    appPy.includes('os.startfile(url)'),
    'Expected the native external URL opener to use the Windows shell for browser handoff.',
  );
});

test('settings metadata jobs expose real per-game progress instead of an indeterminate placeholder', () => {
  assert(
    fs.existsSync('backend/job_progress.py'),
    'Expected a dedicated backend/job_progress.py tracker for long-running library jobs.',
  );
  const jobProgressPy = fs.readFileSync('backend/job_progress.py', 'utf8');
  assert(
    jobProgressPy.includes('def start_job(job_key: str, total: int, label: str) -> dict:'),
    'Expected the job tracker to initialize total-count state for library metadata jobs.',
  );
  assert(
    jobProgressPy.includes('def update_job(job_key: str, completed: int, current_title: str, detail: str | None = None) -> dict:'),
    'Expected the job tracker to update completed-count and current-title progress state.',
  );
  assert(
    mainPy.includes('@app.get("/api/library/jobs/{job_key}")'),
    'Expected the API to expose a job-status polling endpoint for metadata progress.',
  );
  assert(
    mainPy.includes('background_tasks.add_task(run_fix_metadata_job)'),
    'Expected the fix-metadata endpoint to run in the background so progress can be polled while it works.',
  );
  assert(
    mainPy.includes('background_tasks.add_task(run_rematch_f95zone_job)'),
    'Expected the rematch endpoint to run in the background so progress can be polled while it works.',
  );
  assert(
    mainPy.includes('background_tasks.add_task(run_flush_metadata_job)'),
    'Expected the bulk metadata flush endpoint to run in the background so progress can be polled while it works.',
  );
  assert(
    mainPy.includes('@app.post("/api/library/flush-metadata")'),
    'Expected the API to expose a tracked bulk metadata flush endpoint.',
  );
  assert(
    mainPy.includes('start_job("flush-metadata", total, "Flushing scraped metadata")'),
    'Expected the flush-metadata endpoint to initialize a dedicated tracked job state.',
  );
  assert(
    mainPy.includes('if not payload.confirmation_phrase or payload.confirmation_phrase.strip().upper() != "FLUSH":'),
    'Expected the destructive bulk metadata flush endpoint to require an explicit confirmation phrase.',
  );
  assert(
    mainPy.includes('clear_game_scraped_metadata('),
    'Expected backend metadata clearing to use a shared helper instead of duplicating destructive field resets.',
  );
  assert(
    sourceMapPy.includes('def clear_metadata_from_all_snapshots() -> int:'),
    'Expected the source-map module to expose a helper that clears durable metadata snapshots during a bulk flush.',
  );
  assert(
    mainPy.includes('clear_metadata_from_all_snapshots()'),
    'Expected the bulk metadata flush job to clear metadata from source-map snapshots as well as the live database rows.',
  );
  const scraperPy = fs.readFileSync('backend/scraper.py', 'utf8');
  assert(
    scraperPy.includes('def rematch_and_scrape_f95zone(db: Session, target_game_id: Optional[int] = None, progress_callback = None) -> Dict[str, Any]:'),
    'Expected the F95Zone rematch loop to accept a progress callback for per-game reporting.',
  );
  assert(
    scraperPy.includes('def fix_all_titles_and_metadata(db: Session, progress_callback = None) -> Dict[str, Any]:'),
    'Expected the metadata-fix loop to accept a progress callback for per-game reporting.',
  );
  assert(
    scraperPy.includes('progress_callback(index, total_games, g,'),
    'Expected the metadata loops to report current index and game title while they run.',
  );
});

test('deleting a wishlist entry should hide it without letting extension sync recreate it', () => {
  assert(
    mainPy.includes('query = db.query(Game).filter(Game.is_ignored == False)'),
    'Expected the main game listing API to exclude ignored entries so deleted wishlist rows stay hidden.',
  );
  assert(
    mainPy.includes('games = db.query(Game).filter(Game.is_identified == True, Game.cover_url == None, Game.is_ignored == False).limit(20).all()'),
    'Expected the metadata queue listing API to exclude ignored entries as well.',
  );
  assert(
    mainPy.includes('if game.file_type == "wishlist":'),
    'Expected wishlist deletes to have a dedicated code path instead of always hard-deleting the row.',
  );
  assert(
    mainPy.includes('game.is_ignored = True'),
    'Expected deleting a wishlist item to soft-hide it so metadata sync can no longer recreate it as new wishlist entry.',
  );
  assert(
    mainPy.includes('game.is_ignored = True') && mainPy.includes('return {"message": "Game deleted successfully"}'),
    'Expected wishlist deletion to return early after soft-hiding the row instead of falling through to hard delete.',
  );
});

test('scan-missed local entries are hidden from the available library immediately while wishlist rows stay visible', () => {
  assert(
    mainPy.includes('Game.missing_scan_count == 0') || mainPy.includes('Game.missing_scan_count.is_(None)'),
    'Expected library listing queries to explicitly filter out scan-missed local entries instead of continuing to show deleted folders and archives.',
  );
  assert(
    mainPy.includes('Game.file_type == "wishlist"') || mainPy.includes("Game.file_type == 'wishlist'"),
    'Expected the visibility filter to preserve wishlist rows while hiding stale local-on-disk entries.',
  );
  assert(
    mainPy.includes('archives = db.query(Game)') && mainPy.includes('installed = db.query(Game)'),
    'Expected stats to continue counting visible installed/archive rows through the backend stats endpoint.',
  );
});

test('database is optimized with selectin eager loading, WAL mode pragmas, and targeted indexes', () => {
  assert(
    databasePy.includes('lazy="selectin"'),
    'Expected relationships to use selectin loading to prevent N+1 query problems.',
  );
  assert(
    databasePy.includes('PRAGMA journal_mode=WAL') && databasePy.includes('PRAGMA synchronous=NORMAL'),
    'Expected database engine to configure WAL mode and pragma optimizations.',
  );
  assert(
    databasePy.includes('ix_games_playing_progress ON games') && databasePy.includes('ix_games_added_at ON games'),
    'Expected index migrations for frequently filtered and sorted UI columns.',
  );
});

test('smart metadata scan exposes tracked background endpoints, cancellation, and review application hooks', () => {
  const jobProgressPy = fs.readFileSync('backend/job_progress.py', 'utf8');
  const smartScanPy = fs.readFileSync('backend/smart_scan.py', 'utf8');
  assert(
    fs.existsSync('backend/smart_scan.py'),
    'Expected a dedicated backend/smart_scan.py module for the new unresolved-metadata scan flow.',
  );
  assert(
    fs.existsSync('backend/title_normalization.py'),
    'Expected a reusable backend/title_normalization.py helper for messy local folder names.',
  );
  assert(
    mainPy.includes('@app.post("/api/library/smart-scan")'),
    'Expected the API to expose a dedicated smart metadata scan start endpoint.',
  );
  assert(
    mainPy.includes('@app.post("/api/library/missing-source-scan")'),
    'Expected the API to expose a separate missing-source-only scan endpoint instead of overloading the existing smart scan route.',
  );
  assert(
    mainPy.includes('background_tasks.add_task(run_smart_metadata_scan_job)'),
    'Expected the smart metadata scan to run in the background so the modal can poll progress live.',
  );
  assert(
    mainPy.includes('start_job("smart-scan", total, "Smart metadata scan")'),
    'Expected the smart scan endpoint to initialize a tracked job with a dedicated label.',
  );
  assert(
    mainPy.includes('@app.post("/api/library/jobs/{job_key}/cancel")'),
    'Expected the API to expose a generic job cancellation endpoint for long-running library work.',
  );
  assert(
    jobProgressPy.includes('def request_job_cancel(job_key: str) -> dict:'),
    'Expected the job tracker to expose an explicit cancellation request helper.',
  );
  assert(
    jobProgressPy.includes('cancel_requested'),
    'Expected tracked job state to preserve whether cancellation has been requested.',
  );
  assert(
    mainPy.includes('@app.post("/api/library/smart-scan/review/{game_id}/apply")'),
    'Expected the API to expose a manual-review apply endpoint for smart scan candidates.',
  );
  assert(
    mainPy.includes('apply_smart_scan_candidate'),
    'Expected backend review application to route selected candidates through a shared smart scan helper.',
  );
  assert(
    smartScanPy.includes('"thumbnail_url"'),
    'Expected smart scan review payloads to expose a thumbnail URL for unresolved-game review rows when cover art is available.',
  );
  assert(
    smartScanPy.includes('def should_include_in_missing_source_scan'),
    'Expected backend/smart_scan.py to expose a dedicated target filter for missing-source-only scans.',
  );
});
