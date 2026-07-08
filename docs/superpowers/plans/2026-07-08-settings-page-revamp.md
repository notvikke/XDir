# Settings Page Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the outdated settings page with a settings surface that matches XDir's current library, scan, source-search, maintenance, and extension-companion capabilities.

**Architecture:** Keep the revamp centered on the existing settings tab instead of introducing new routes. Use three layers: backend wiring for one real preference (`preferred_source`), frontend markup/CSS for the new information architecture, and frontend bindings so settings actions, library health, and extension health render from current app state rather than static copy.

**Tech Stack:** FastAPI, SQLAlchemy, vanilla JavaScript, HTML, CSS, Node-based regression checks, Python `unittest`

---

### Task 1: Capture The Revamp Contract In Tests

**Files:**
- Modify: `tests/frontend-regressions.mjs`
- Modify: `tests/test_smart_scan.py`

- [ ] **Step 1: Write the failing frontend regression**

```js
test('settings page exposes modern library defaults, maintenance actions, and companion health sections', () => {
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
    'Expected the new settings page to expose real source preference and current scan actions.',
  );
  assert(
    html.includes('id="settings-extension-status"') &&
      html.includes('id="settings-extension-path"') &&
      html.includes('id="settings-metadata-queue-count"'),
    'Expected the settings page to surface companion health and metadata queue state from the live app.',
  );
});
```

- [ ] **Step 2: Write the failing backend behavior test**

```python
def test_build_source_search_order_prefers_selected_source_first(self):
    self.assertEqual(
        build_source_search_order("dlsite"),
        ["dlsite", "f95zone", "itch"],
    )
    self.assertEqual(
        build_source_search_order("itch"),
        ["itch", "f95zone", "dlsite"],
    )
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```bash
node tests/frontend-regressions.mjs
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
```

Expected:
- Frontend regression fails because the current settings page still uses `media`, `updates`, and `system`.
- Python test fails because `build_source_search_order` does not exist yet.

### Task 2: Make Preferred Source A Real Runtime Preference

**Files:**
- Modify: `backend/smart_scan.py`
- Modify: `frontend/static/js/app.js`
- Test: `tests/test_smart_scan.py`

- [ ] **Step 1: Add the minimal backend helper**

```python
def build_source_search_order(preferred_source: Optional[str] = None) -> List[str]:
    default_order = ["f95zone", "dlsite", "itch"]
    preferred = str(preferred_source or "").strip().lower()
    if preferred not in default_order:
        return default_order
    return [preferred] + [source for source in default_order if source != preferred]
```

- [ ] **Step 2: Route smart-scan source iteration through the helper**

```python
for source_type in build_source_search_order(preferred_source):
    handler = SEARCH_HANDLERS[source_type]
    ...
```

- [ ] **Step 3: Use the saved preference in overview and wishlist source search defaults**

```js
function getPreferredSourcePlatform() {
  const preferred = String(appSettings?.preferred_source || 'f95zone').toLowerCase();
  return ['f95zone', 'dlsite', 'itch', 'steam', 'all'].includes(preferred) ? preferred : 'f95zone';
}
```

- [ ] **Step 4: Run the targeted tests and verify GREEN**

Run:

```bash
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node --check frontend/static/js/app.js
```

Expected: PASS for the new helper test and clean JavaScript syntax.

### Task 3: Rebuild The Settings Information Architecture

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Test: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Replace the old settings nav and panels with current capability groups**

```html
<button class="settings-nav-item active" data-section="defaults">...</button>
<button class="settings-nav-item" data-section="sources">...</button>
<button class="settings-nav-item" data-section="maintenance">...</button>
<button class="settings-nav-item" data-section="companion">...</button>
```

- [ ] **Step 2: Add a settings overview shell with live summary cards**

```html
<div class="settings-hero">
  <div class="settings-hero-copy">...</div>
  <div class="settings-hero-grid">
    <div class="settings-kpi-card" id="settings-kpi-library">...</div>
    <div class="settings-kpi-card" id="settings-kpi-source">...</div>
    <div class="settings-kpi-card" id="settings-kpi-companion">...</div>
  </div>
</div>
```

- [ ] **Step 3: Add dedicated panels for real settings and real actions**

```html
<select class="input-dark" id="set-preferred-source">...</select>
<button class="btn-secondary" id="btn-settings-scan-directory">...</button>
<button class="btn-secondary" id="btn-settings-smart-scan">...</button>
<button class="btn-secondary" id="btn-settings-missing-source-scan">...</button>
<div id="settings-extension-status">Extension Offline</div>
<div id="settings-extension-path" class="path-box">...</div>
```

- [ ] **Step 4: Add the new styling hooks**

```css
.settings-hero { ... }
.settings-kpi-grid { ... }
.settings-surface-grid { ... }
.settings-action-cluster { ... }
.settings-source-priority { ... }
.settings-companion-status.connected { ... }
```

- [ ] **Step 5: Run the frontend regression and verify GREEN**

Run:

```bash
node tests/frontend-regressions.mjs
```

Expected: PASS for the new settings IA assertions.

### Task 4: Bind The New Settings Page To Live App State

**Files:**
- Modify: `frontend/static/js/app.js`
- Modify: `frontend/index.html`

- [ ] **Step 1: Update settings navigation and payload bindings to the new ids**

```js
preferred_source: document.getElementById('set-preferred-source')?.value || 'f95zone',
```

- [ ] **Step 2: Add settings-specific render helpers for stats and companion health**

```js
function renderSettingsSummary(stats) { ... }
function renderSettingsExtensionStatus(status) { ... }
function renderSettingsMetadataQueue(queueCount) { ... }
```

- [ ] **Step 3: Wire the maintenance and scan shortcut buttons into existing actions**

```js
document.getElementById('btn-settings-scan-directory')?.addEventListener('click', async () => {
  await triggerRescan(document.getElementById('btn-settings-scan-directory'));
});
document.getElementById('btn-settings-smart-scan')?.addEventListener('click', startSmartScan);
document.getElementById('btn-settings-missing-source-scan')?.addEventListener('click', startMissingSourceScan);
```

- [ ] **Step 4: Keep the existing tracked metadata job progress shell working inside the new layout**

```js
showSettingsJobProgress(...)
renderSettingsJobProgress(...)
hideSettingsJobProgress()
```

- [ ] **Step 5: Verify the binding layer**

Run:

```bash
node --check frontend/static/js/app.js
```

Expected: PASS with no syntax errors.

### Task 5: End-To-End Verification

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `frontend/static/js/app.js`
- Modify: `backend/smart_scan.py`
- Test: `tests/frontend-regressions.mjs`
- Test: `tests/test_smart_scan.py`

- [ ] **Step 1: Run the focused verification suite**

Run:

```bash
node --check frontend/static/js/app.js
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m py_compile backend/smart_scan.py backend/main.py
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node tests/frontend-regressions.mjs
```

- [ ] **Step 2: Fix only the failing layer if regressions appear**

```text
Wrong source ordering -> backend helper / smart scan only
Missing settings cards or ids -> index.html / CSS only
Broken button actions -> app.js bindings only
```

- [ ] **Step 3: Re-run the same focused suite**

Run:

```bash
node --check frontend/static/js/app.js
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node tests/frontend-regressions.mjs
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/2026-07-08-settings-page-revamp.md tests/frontend-regressions.mjs tests/test_smart_scan.py backend/smart_scan.py frontend/index.html frontend/static/css/styles.css frontend/static/js/app.js
git commit -m "feat: revamp settings experience"
```
