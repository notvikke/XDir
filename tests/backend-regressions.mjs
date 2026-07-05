import fs from 'fs';

const appPy = fs.readFileSync('app.py', 'utf8');
const configPy = fs.readFileSync('backend/config.py', 'utf8');
const databasePy = fs.readFileSync('backend/database.py', 'utf8');
const mainPy = fs.readFileSync('backend/main.py', 'utf8');
const specFile = fs.readFileSync('XDir.spec', 'utf8');

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

test('startup runs a maintenance dedupe pass even when startup scanning is disabled', () => {
  assert(
    appPy.includes('deduplicate_games(maintenance_db)'),
    'Expected app startup to run a maintenance dedupe pass against the existing library database.',
  );
  assert(
    appPy.includes('maintenance_db = SessionLocal()'),
    'Expected startup maintenance dedupe to use its own short-lived database session.',
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
});

test('frozen builds resolve config and database paths from the app runtime root', () => {
  assert(
    configPy.includes('from backend.runtime import get_app_root'),
    'Expected config persistence to resolve from a shared runtime-root helper.',
  );
  assert(
    configPy.includes('SETTINGS_FILE = os.path.join(get_app_root(), "backend", "settings.json")'),
    'Expected settings.json to live under the resolved app root in frozen builds.',
  );
  assert(
    databasePy.includes('DB_PATH = os.path.join(get_app_root(), "backend", "library.db")'),
    'Expected the SQLite library path to resolve from the app runtime root in frozen builds.',
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
