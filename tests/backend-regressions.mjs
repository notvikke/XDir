import fs from 'fs';

const appPy = fs.readFileSync('app.py', 'utf8');
const mainPy = fs.readFileSync('backend/main.py', 'utf8');

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
