# XDir Stage-Two Frontend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the complete two-option library workflow, restorable tracked-job UI, version/update controls, and a focused four-section Settings experience without changing XDir's vanilla-JavaScript architecture or dark identity.

**Architecture:** Recover the stage-one update/refresh API contracts that are absent from this checkout, then drive all long-running library work through the existing generic job tracker. On the frontend, consolidate scan/refresh restoration, progress, cancellation, completion, and conflict handling into configuration-driven helpers, while keeping focused renderers for source review and game update state.

**Tech Stack:** FastAPI, SQLAlchemy/SQLite, vanilla JavaScript, semantic HTML, CSS, Node static regression tests, Python unittest/pytest.

---

### Task 1: Lock the required public contracts into regressions

**Files:**
- Modify: `tests/frontend-regressions.mjs`
- Modify: `tests/backend-regressions.mjs`
- Modify: `tests/test_smart_scan.py`

- [ ] **Step 1: Add frontend assertions for the two-option chooser, home metadata refresh, review controls, tracked-job restoration, version editor, and four Settings sections**

```js
assert.equal((html.match(/class="scan-mode-card/g) || []).length, 2);
assert.match(html, /id="btn-refresh-metadata"/);
assert.match(js, /\/api\/library\/refresh-all-metadata/);
assert.doesNotMatch(html, /Smart Metadata Scan/i);
assert.match(html, /id="version-updates-section"/);
assert.match(html, /id="local-version-editor"/);
assert.doesNotMatch(js, /prompt\(/);
for (const section of ['settings-library', 'settings-sources-updates', 'settings-companion', 'settings-advanced']) {
  assert.match(html, new RegExp(`id="${section}"`));
}
```

- [ ] **Step 2: Add backend assertions for the real refresh, update-check, local-version, and mark-installed routes**

```js
for (const route of [
  '@app.post("/api/library/refresh-all-metadata")',
  '@app.post("/api/library/check-updates")',
  '@app.post("/api/games/{game_id}/check-update")',
  '@app.put("/api/games/{game_id}/local-version")',
  '@app.post("/api/games/{game_id}/mark-latest-installed")',
]) assert.ok(mainPy.includes(route), `Missing ${route}`);
```

- [ ] **Step 3: Add a Python test proving missing-source targets exclude every linked game**

```python
def test_missing_source_targets_exclude_linked_games(session):
    linked = Game(title="Linked", raw_name="Linked", folder_path="C:/Linked", source_type="itch", source_url="https://itch.io/x")
    unlinked = Game(title="Unlinked", raw_name="Unlinked", folder_path="C:/Unlinked", source_type="unknown")
    session.add_all([linked, unlinked]); session.commit()
    assert [game.id for game in list_missing_source_scan_targets(session)] == [unlinked.id]
```

- [ ] **Step 4: Run the new regressions and confirm they fail because the requested UI and missing stage-one contracts are absent**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL on the three-card chooser or missing Refresh Metadata control.

Run: `node tests/backend-regressions.mjs`
Expected: FAIL on `/api/library/refresh-all-metadata`.

Run: `python -m pytest tests/test_smart_scan.py -q`
Expected: PASS for the existing missing-source invariant, or FAIL only if linked games leak into targets.

### Task 2: Recover the update/version persistence and service contracts

**Files:**
- Modify: `backend/database.py`
- Modify: `backend/config.py`
- Create: `backend/update_checks.py`
- Modify: `backend/main.py`
- Test: `tests/test_update_checks.py`

- [ ] **Step 1: Write failing service tests for normalized status values**

```python
def test_compare_versions_reports_confirmed_update_only_for_ordered_versions():
    assert derive_update_status("1.0", "1.1") == ("update_available", True)
    assert derive_update_status("2.0", "1.9") == ("version_differs", False)
    assert derive_update_status(None, "1.0") == ("local_version_unknown", False)
```

- [ ] **Step 2: Run the service test and verify the module import fails**

Run: `python -m pytest tests/test_update_checks.py -q`
Expected: FAIL with `ModuleNotFoundError: backend.update_checks`.

- [ ] **Step 3: Add persisted check state and lightweight SQLite migrations**

```python
update_status = Column(String, default="never_checked")
update_checked_at = Column(DateTime, nullable=True)
update_check_error = Column(Text, nullable=True)
```

Add the same fields to `Game.to_dict()` and guarded `ALTER TABLE games ADD COLUMN ...` statements in `init_db()`.

- [ ] **Step 4: Implement source-aware checking and status derivation**

```python
def derive_update_status(local_version, latest_version):
    if not latest_version:
        return "remote_version_unavailable", False
    if not local_version:
        return "local_version_unknown", False
    comparison = compare_versions(local_version, latest_version)
    if comparison == 0:
        return "up_to_date", False
    if comparison < 0:
        return "update_available", True
    return "version_differs", False
```

Use the linked preferred source and existing scraper metadata fetcher; unsupported/unlinked sources return `unsupported_source`, and exceptions return `check_failed` with a user-readable error.

- [ ] **Step 5: Add automatic-update settings defaults and timestamps without triggering a scan on Settings open/save**

```python
"automatic_update_checks": True,
"update_check_interval_days": 7,
"last_update_check_at": None,
```

- [ ] **Step 6: Run update service tests**

Run: `python -m pytest tests/test_update_checks.py -q`
Expected: PASS.

### Task 3: Add refresh-all and update-check tracked jobs plus game routes

**Files:**
- Modify: `backend/main.py`
- Modify: `backend/job_progress.py`
- Modify: `tests/backend-regressions.mjs`

- [ ] **Step 1: Add route-level regression assertions for job keys and response fields**

```js
assert.match(mainPy, /start_job\("refresh-all-metadata"/);
assert.match(mainPy, /start_job\("check-updates"/);
assert.match(mainPy, /update_status/);
assert.match(mainPy, /update_checked_at/);
```

- [ ] **Step 2: Run backend regressions and verify they fail on the new assertions**

Run: `node tests/backend-regressions.mjs`
Expected: FAIL on `refresh-all-metadata`.

- [ ] **Step 3: Implement linked-only metadata refresh with result counters**

```python
targets = db.query(Game).filter(Game.source_url.isnot(None), Game.source_type != "unknown").all()
result = {"refreshed": 0, "skipped": 0, "unsupported": 0, "failed": 0, "processed": 0, "total": len(targets)}
```

Update job context before and after each game with `current_source`, `current_title`, counters, and cancellation state; never alter source links, local paths, progress, scores, journals, or custom tags.

- [ ] **Step 4: Implement library and per-game update routes**

```python
@app.post("/api/games/{game_id}/check-update")
def check_game_update(game_id: int, db: Session = Depends(get_db)):
    game = check_for_game_update(db, game_id)
    return {"message": "Update check complete", "game": game.to_dict()}
```

Add `PUT /local-version` with `{value: string | null}`, `POST /mark-latest-installed`, and tracked `POST /api/library/check-updates`.

- [ ] **Step 5: Run backend regressions and Python tests**

Run: `node tests/backend-regressions.mjs`
Expected: PASS.

Run: `python -m pytest tests/test_update_checks.py tests/test_smart_scan.py tests/test_scraper.py -q`
Expected: PASS.

### Task 4: Replace the scan chooser and consolidate tracked job UI

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/js/app.js`
- Modify: `frontend/static/css/styles.css`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Run the chooser regressions and verify RED**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL because three `.scan-mode-card` controls and Smart Metadata Scan copy remain.

- [ ] **Step 2: Replace the chooser with exactly two semantic button cards**

```html
<button type="button" class="scan-mode-card scan-mode-primary" id="btn-scan-normal">...</button>
<button type="button" class="scan-mode-card scan-mode-source" id="btn-scan-missing-source">...</button>
```

Use the specified Normal Scan and Find Missing Sources content; remove `btn-scan-smart` and every user-facing Smart Metadata Scan string.

- [ ] **Step 3: Add Refresh Metadata to the Library toolbar and a confirmation view**

```html
<button type="button" class="btn-secondary" id="btn-refresh-metadata" aria-haspopup="dialog">
  <i data-lucide="refresh-cw"></i><span>Refresh Metadata</span>
</button>
```

The confirmation explicitly states linked-only scope, preserved local/user data, duration, and cancellation.

- [ ] **Step 4: Replace separate scan/settings polling with configuration-driven job definitions**

```js
const LIBRARY_JOB_DEFINITIONS = {
  'missing-source-scan': { startUrl: '/api/library/missing-source-scan', kind: 'source-discovery' },
  'refresh-all-metadata': { startUrl: '/api/library/refresh-all-metadata', kind: 'metadata-refresh' },
  'check-updates': { startUrl: '/api/library/check-updates', kind: 'update-check' },
};
```

Implement `startTrackedJob`, `pollTrackedJob`, `restoreTrackedJobs`, `renderTrackedJobProgress`, `renderTrackedJobSummary`, and `cancelTrackedJob`; retain terminal state so a closed dialog reopens without restarting.

- [ ] **Step 5: Refresh games, cards, stats, filters, and an open overview after successful jobs**

```js
await Promise.all([loadGames(), fetchStats(), fetchTags()]);
if (currentGame) {
  const refreshed = allGames.find(game => game.id === currentGame.id);
  if (refreshed) renderOverview(refreshed);
}
```

- [ ] **Step 6: Run frontend regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS for scan, refresh, restoration, cancellation, and obsolete-listener assertions.

### Task 5: Improve plausible-match review without resetting the list

**Files:**
- Modify: `frontend/static/js/app.js`
- Modify: `frontend/static/css/styles.css`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Add failing assertions for candidate context and three distinct resolution actions**

```js
for (const label of ['Apply Match', 'Open Source', 'Skip', 'Resolve Later']) assert.match(js, new RegExp(label));
for (const field of ['raw_name', 'creator', 'cover', 'version', 'confidence', 'match_reason']) assert.match(js, new RegExp(field));
```

- [ ] **Step 2: Run frontend regressions and verify RED**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL because review cards do not expose all required context/actions.

- [ ] **Step 3: Render contextual review cards and mutate only the resolved row**

```js
row.dataset.reviewState = 'resolved';
row.querySelector('.review-item-actions').innerHTML = '<span class="status-note success">Match applied</span>';
currentTrackedJob.result.review_items = currentTrackedJob.result.review_items.filter(item => item.game_id !== gameId);
```

Render local title/path name, candidate provider/title/developer/cover/version/confidence/reason and use `openExternalUrl()` for source actions. Show backend warnings inside the affected card.

- [ ] **Step 4: Run frontend regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS.

### Task 6: Add Version & Updates overview controls

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/js/app.js`
- Modify: `frontend/static/css/styles.css`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Add failing assertions for status mapping, routes, inline editor, and no `prompt()`**

```js
for (const status of ['never_checked','checking','up_to_date','update_available','local_version_unknown','remote_version_unavailable','version_differs','unsupported_source','check_failed']) assert.match(js, new RegExp(status));
assert.match(js, /\/check-update/);
assert.match(js, /\/local-version/);
assert.match(js, /\/mark-latest-installed/);
assert.doesNotMatch(js, /prompt\(/);
```

- [ ] **Step 2: Run frontend regressions and verify RED**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL on the missing status renderer.

- [ ] **Step 3: Add a dedicated semantic overview section and compact editor**

```html
<section class="version-panel" id="version-updates-section" aria-labelledby="version-updates-title">
  <h3 id="version-updates-title">Version &amp; Updates</h3>
  <div id="local-version-editor" hidden>...</div>
</section>
```

- [ ] **Step 4: Implement status rendering and robust action handlers**

```js
const UPDATE_STATUS_LABELS = { never_checked: 'Never checked', checking: 'Checking', up_to_date: 'Up to date', update_available: 'Update available', local_version_unknown: 'Local version unknown', remote_version_unavailable: 'Remote version unavailable', version_differs: 'Version differs', unsupported_source: 'Unsupported source', check_failed: 'Check failed' };
```

Every handler disables its button, uses a stable spinner label, updates `currentGame` and `allGames`, re-renders in `try`, reports inline, and restores controls in `finally`.

- [ ] **Step 5: Ensure card badges use only `game.update_available === true` and open the overview consistently**

- [ ] **Step 6: Run frontend regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS.

### Task 7: Replace Settings with four focused preference sections

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/js/app.js`
- Modify: `frontend/static/css/styles.css`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Add failing assertions that scan actions and obsolete Smart Scan references are absent from Settings**

```js
const settingsMarkup = html.slice(html.indexOf('id="settings-view"'), html.indexOf('id="scan-workflow-backdrop"'));
assert.doesNotMatch(settingsMarkup, /btn-settings-(scan-directory|smart-scan|missing-source-scan)/);
assert.doesNotMatch(settingsMarkup, /Smart Metadata Scan/i);
```

- [ ] **Step 2: Run frontend regressions and verify RED**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL on duplicated Settings actions.

- [ ] **Step 3: Build Library, Sources & Updates, Companion, and Advanced sections**

Keep only persistent library fields, preferred source/automatic checks/weekly interval/last check/update count/manual full-library check, concise companion state, and functional advanced repair/destructive actions.

- [ ] **Step 4: Add explicit dirty/save state and include automatic update settings in load/save**

```js
function syncSettingsDirtyState() {
  const dirty = JSON.stringify(collectSettingsPayload()) !== JSON.stringify(settingsBaseline);
  saveButton.disabled = !dirty;
  status.textContent = dirty ? 'Unsaved changes' : 'Saved';
}
```

Normal save success and failure render inline; changing/opening Settings never launches a scan.

- [ ] **Step 5: Run frontend regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS.

### Task 8: Professional CSS, accessibility, and responsive audit

**Files:**
- Modify: `frontend/static/css/styles.css`
- Modify: `frontend/index.html`
- Modify: `frontend/static/js/app.js`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Add static accessibility and minimum-width regression assertions**

```js
assert.match(css, /:focus-visible/);
assert.match(css, /@media\s*\(max-width:\s*760px\)/);
assert.match(css, /prefers-reduced-motion:\s*reduce/);
assert.match(html, /aria-label="Close/);
```

- [ ] **Step 2: Run frontend regressions and confirm any missing rule fails**

Run: `node tests/frontend-regressions.mjs`
Expected: FAIL only for rules not already present.

- [ ] **Step 3: Normalize reusable controls and surfaces**

Use shared 40px button/input heights, consistent 10–14px radii, quiet border tokens, restrained badges, `.btn-primary`, `.btn-secondary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`, and stable loading widths. Move new/repeated presentation out of inline styles.

- [ ] **Step 4: Add predictable modal focus/scroll behavior and reduced motion**

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
```

Trap focus within opened workflow dialogs, close on Escape, keep backdrop behavior explicit, and lock underlying scroll while dialogs are open.

- [ ] **Step 5: Add minimum-width layouts for toolbar, two-card chooser, progress counters, Settings nav/rows, long paths, and overview actions**

- [ ] **Step 6: Run frontend regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS.

### Task 9: Full verification and visual inspection

**Files:**
- Modify only if a failing regression or visual inspection first receives a reproducing test.

- [ ] **Step 1: Run all required Node regressions**

Run: `node tests/frontend-regressions.mjs`
Expected: PASS.

Run: `node tests/backend-regressions.mjs`
Expected: PASS.

Run: `node tests/app-upgrade-regressions.mjs`
Expected: PASS.

- [ ] **Step 2: Run all relevant Python tests**

Run: `python -m pytest tests/test_smart_scan.py tests/test_scraper.py tests/test_update_checks.py -q`
Expected: PASS.

- [ ] **Step 3: Compile backend modules**

Run: `python -m py_compile backend/main.py backend/database.py backend/job_progress.py backend/smart_scan.py backend/update_checks.py`
Expected: no output and exit 0.

- [ ] **Step 4: Start the local app and inspect normal desktop and minimum supported widths**

Verify chooser focus/pressed/loading states, closed/reopened progress, long title/path wrapping, empty states, failed/cancelled jobs, companion offline state, update available/local unknown states, review cards, and no console errors.

- [ ] **Step 5: Review the final diff for obsolete IDs/listeners, inline-style sprawl, accidental source-link mutation, and unrelated changes**

Run: `git diff --check`
Expected: no whitespace errors.
