import fs from 'fs';

const appPy = fs.readFileSync('app.py', 'utf8');
const configPy = fs.readFileSync('backend/config.py', 'utf8');
const databasePy = fs.readFileSync('backend/database.py', 'utf8');
const ingestPy = fs.readFileSync('backend/ingest.py', 'utf8');
const mainPy = fs.readFileSync('backend/main.py', 'utf8');
const html = fs.readFileSync('frontend/index.html', 'utf8');
const js = fs.readFileSync('frontend/static/js/app.js', 'utf8');
const css = fs.readFileSync('frontend/static/css/styles.css', 'utf8');
const extensionManifest = JSON.parse(fs.readFileSync('extension/manifest.json', 'utf8'));

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

test('library entries survive transient scan misses instead of being deleted immediately', () => {
  assert(
    databasePy.includes('missing_scan_count = Column(Integer, default=0)'),
    'Expected Game model to track consecutive missed scans.',
  );
  assert(
    databasePy.includes('last_seen_at = Column(DateTime'),
    'Expected Game model to track when an item was last seen on disk.',
  );
  assert(
    ingestPy.includes('missing_grace_scans'),
    'Expected ingestion cleanup to be driven by a configurable grace threshold.',
  );
  assert(
    !ingestPy.includes('if g.folder_path and not os.path.exists(g.folder_path):\n                db.delete(g)'),
    'Expected immediate orphan deletion to be removed.',
  );
});

test('dedupe no longer collapses numbered series titles by fuzzy title matching', () => {
  assert(
    !ingestPy.includes('all_existing = db.query(Game).all()'),
    'Expected generalized fuzzy matching across every game to be removed from ingestion.',
  );
  assert(
    ingestPy.includes('duplicate_keys = {}'),
    'Expected deduplication to be keyed by stable identifiers rather than cleaned titles.',
  );
});

test('settings expose startup scan and directory stability controls', () => {
  assert(
    configPy.includes('"startup_scan": True'),
    'Expected startup scan to be a persisted setting.',
  );
  assert(
    configPy.includes('"missing_grace_scans": 3'),
    'Expected missing_grace_scans default to be persisted.',
  );
  assert(
    mainPy.includes('startup_scan: Optional[bool] = None'),
    'Expected settings payload to accept startup_scan.',
  );
  assert(
    mainPy.includes('missing_grace_scans: Optional[int] = None'),
    'Expected settings payload to accept missing_grace_scans.',
  );
  assert(
    appPy.includes('settings = get_settings()'),
    'Expected desktop startup to read persisted settings.',
  );
  assert(
    appPy.includes("if settings.get('startup_scan', True):"),
    'Expected startup ingestion to be gated by the startup_scan setting.',
  );
});

test('startup no longer blocks on sequential fetches or unconditional delayed reloads', () => {
  assert(
    js.includes('Promise.allSettled(['),
    'Expected app bootstrap to parallelize startup requests.',
  );
  assert(
    !js.includes('await fetchStats();\n    await fetchTags();\n    await loadGames();'),
    'Expected sequential bootstrap requests to be removed.',
  );
  assert(
    !js.includes('}, 3500);'),
    'Expected the unconditional 3.5 second reload hack to be removed.',
  );
  assert(
    !js.includes('const statsRes = await fetch(`${API_BASE}/api/stats`);'),
    'Expected extension heartbeat polling to stop re-fetching stats every cycle.',
  );
});

test('settings page and overview page expose the redesigned blue UI controls', () => {
  assert(
    html.includes('id="toggle-startup-scan"'),
    'Expected settings UI to expose a startup scan toggle.',
  );
  assert(
    html.includes('id="setting-missing-grace-scans"'),
    'Expected settings UI to expose a missing-scan grace field.',
  );
  assert(
    html.includes('id="btn-save-preferences"'),
    'Expected settings UI to expose a dedicated save preferences action.',
  );
  assert(
    html.includes('class="ov-summary-grid"'),
    'Expected overview page to include the redesigned summary grid.',
  );
  assert(
    html.includes('id="ov-cover-card"'),
    'Expected overview page to include a dedicated cover card region.',
  );
});

test('theme switches primary accents from red to blue tokens', () => {
  assert(
    css.includes('--accent-primary: #3b82f6;'),
    'Expected the shared primary accent token to be blue.',
  );
  assert(
    !css.includes('--accent-red: #ff1f4b;'),
    'Expected legacy red accent token definitions to be removed.',
  );
});

test('ui strings and rating formatters do not contain mojibake sequences', () => {
  const mojibakeFragments = [
    'â€',
    'â˜',
    'âœ',
    'âš',
    'ðŸ',
    'ï¸',
    'â€¢',
    'â€¦',
    'â–',
    'â',
  ];
  assert(
    !mojibakeFragments.some(fragment => js.includes(fragment)),
    'Expected frontend app.js to be free of mojibake display sequences.',
  );
  assert(
    !mojibakeFragments.some(fragment => html.includes(fragment)),
    'Expected frontend index.html to be free of mojibake display sequences.',
  );
  assert(
    !mojibakeFragments.some(fragment => fs.readFileSync('backend/scraper.py', 'utf8').includes(fragment)),
    'Expected backend scraper formatting strings to be free of mojibake sequences.',
  );
});

test('library layout uses denser cards and no bottom-pinned stat gap', () => {
  assert(
    css.includes('grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));'),
    'Expected the games grid to use a denser 300px minimum card width.',
  );
  assert(
    !css.includes('margin-top: auto;'),
    'Expected the sidebar stats block to stop pinning itself to the very bottom.',
  );
});

test('manual source link dismiss button uses the compact icon style', () => {
  assert(
    /\.link-form-row\s+\.btn-secondary\s*\{[\s\S]*?padding:\s*0;/.test(css),
    'Expected the link form close button to use compact icon-only sizing.',
  );
});

test('extension badge icon is exposed as a web accessible resource for injected page UI', () => {
  const resources = extensionManifest.web_accessible_resources || [];
  const iconResource = resources.find(entry =>
    Array.isArray(entry.resources) && entry.resources.includes('icon128.png'),
  );
  assert(
    iconResource,
    'Expected the extension manifest to expose icon128.png as a web accessible resource for the injected badge UI.',
  );
  assert(
    Array.isArray(iconResource.matches) && iconResource.matches.includes('<all_urls>'),
    'Expected the injected badge icon resource to be readable on supported page URLs.',
  );
});
