import fs from 'fs';

const html = fs.readFileSync('frontend/index.html', 'utf8');
const js = fs.readFileSync('frontend/static/js/app.js', 'utf8');

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
