# Scan Workflow Revamp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair the new scan workflow so normal scan remains simple, smart scan runs in the background with accurate progress and a cleaner review flow, and the frameless desktop window regains drag/resize behavior.

**Architecture:** Keep the existing `/api/library/scan` normal scan path unchanged and refactor smart scan around a background job plus a compact toolbar indicator. Split the smart-scan UI into three isolated states: chooser dialog, background progress indicator, and completion/review dialog, so progress, summary, and review never render at the same time. Fix shell-window regressions separately in the frameless header and desktop bootstrap code so scan changes do not couple to window behavior.

**Tech Stack:** FastAPI, SQLAlchemy, pywebview, vanilla JS, HTML, CSS, Node-based regression checks, bundled Python `unittest`

---

### Task 1: Reproduce And Guard The Regressions

**Files:**
- Create: `docs/superpowers/plans/2026-07-08-scan-workflow-revamp.md`
- Modify: `tests/frontend-regressions.mjs`
- Modify: `tests/backend-regressions.mjs`
- Modify: `tests/test_smart_scan.py`

- [ ] **Step 1: Write the failing tests**

```js
test('scan workflow keeps chooser, running, and results views isolated', () => {
  assert(
    css.includes('.scan-workflow-view[hidden]') || css.includes('[hidden] { display: none'),
    'Expected hidden scan-workflow views to stay hidden instead of stacking into one long scroll layout.',
  );
  assert(
    html.includes('id="scan-results-modal"') || html.includes('id="scan-workflow-results-modal"'),
    'Expected smart scan completion/review to move into a dedicated results dialog instead of sharing the running modal.',
  );
});

test('toolbar exposes a compact smart-scan progress indicator near scan controls', () => {
  assert(
    html.includes('id="scan-job-pill"') || html.includes('id="scan-toolbar-progress"'),
    'Expected the titlebar/library toolbar to expose a compact progress indicator for background smart scans.',
  );
});
```

```python
def test_smart_scan_result_keeps_processed_and_match_counts_separate(self):
    result = {
        "processed": 10,
        "matched": 3,
        "manual_review": 4,
        "not_found": 2,
        "failed": 1,
    }
    self.assertEqual(result["processed"], 10)
    self.assertEqual(result["matched"], 3)
```

- [ ] **Step 2: Run tests to verify they fail**

Run:

```bash
node tests/frontend-regressions.mjs
node tests/backend-regressions.mjs
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
```

Expected: the new scan-layout/background-progress assertions fail before implementation.

- [ ] **Step 3: Implement the minimal test fixtures/assertions**

```js
test('titlebar header keeps the dedicated pywebview drag region', () => {
  assert(
    frontendHtml.includes('<header class="top-nav pywebview-drag-region">'),
    'Expected the frameless header to carry the dedicated drag region class.',
  );
});
```

- [ ] **Step 4: Re-run targeted tests**

Run:

```bash
node tests/frontend-regressions.mjs
node tests/backend-regressions.mjs
```

Expected: failures point at the exact missing scan-flow and shell fixes.

- [ ] **Step 5: Commit**

```bash
git add tests/frontend-regressions.mjs tests/backend-regressions.mjs tests/test_smart_scan.py docs/superpowers/plans/2026-07-08-scan-workflow-revamp.md
git commit -m "test: capture scan workflow regressions"
```

### Task 2: Fix Smart Scan Job Accounting And Payload Shape

**Files:**
- Modify: `backend/smart_scan.py`
- Modify: `backend/job_progress.py`
- Modify: `backend/main.py`
- Test: `tests/test_smart_scan.py`
- Test: `tests/backend-regressions.mjs`

- [ ] **Step 1: Write the failing test**

```python
def test_smart_scan_marks_matches_without_overwriting_processed_count(self):
    result = {
        "processed": 12,
        "matched": 5,
        "manual_review": 4,
        "not_found": 2,
        "failed": 1,
    }
    self.assertEqual(result["processed"], 12)
    self.assertEqual(result["matched"], 5)
```

- [ ] **Step 2: Run the test to verify it fails for the current flow**

Run:

```bash
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
```

Expected: current smart-scan result handling lacks the isolated payload/thumbnail data you need for the cleaned-up review dialog.

- [ ] **Step 3: Write minimal implementation**

```python
def build_review_thumbnail(candidate: dict, game: Game) -> str | None:
    return candidate.get("cover") or game.cover_url or None

def run_smart_metadata_scan(...):
    ...
    review_items.append({
        "thumbnail_url": build_review_thumbnail(best_candidate or {}, game),
        ...
    })
```

```python
def set_job_context(job_key: str, **changes) -> dict:
    ...

def finish_job(job_key: str, summary: str) -> dict:
    job["status"] = "completed"
    job["summary"] = summary
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node tests/backend-regressions.mjs
```

Expected: PASS for smart-scan accounting/candidate payload checks.

- [ ] **Step 5: Commit**

```bash
git add backend/smart_scan.py backend/job_progress.py backend/main.py tests/test_smart_scan.py tests/backend-regressions.mjs
git commit -m "fix: stabilize smart scan job accounting"
```

### Task 3: Revamp The Scan UI Flow

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `frontend/static/js/app.js`
- Test: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('smart scan runs in background with a compact toolbar progress indicator', () => {
  assert(
    html.includes('id="scan-toolbar-progress"'),
    'Expected a compact smart-scan progress pill next to the scan controls.',
  );
  assert(
    js.includes('renderScanToolbarProgress'),
    'Expected frontend JS to keep a compact background progress indicator updated while smart scan runs.',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node tests/frontend-regressions.mjs
```

Expected: FAIL for missing toolbar progress and dedicated results modal behavior.

- [ ] **Step 3: Write minimal implementation**

```html
<div class="toolbar-progress" id="scan-toolbar-progress" hidden>
  <span id="scan-toolbar-progress-label">Smart scan 0 / 0</span>
  <div class="toolbar-progress-bar"><div id="scan-toolbar-progress-fill"></div></div>
</div>
```

```css
.scan-workflow-view[hidden] { display: none !important; }
.scan-results-modal[hidden] { display: none !important; }
```

```js
function renderScanToolbarProgress(state) {
  ...
}

async function startSmartScan() {
  closeScanWorkflowModal(true)
  renderScanToolbarProgress(...)
  ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --check frontend/static/js/app.js
node tests/frontend-regressions.mjs
```

Expected: PASS for the new isolated modal flow and compact progress indicator assertions.

- [ ] **Step 5: Commit**

```bash
git add frontend/index.html frontend/static/css/styles.css frontend/static/js/app.js tests/frontend-regressions.mjs
git commit -m "feat: revamp background smart scan flow"
```

### Task 4: Restore Frameless Window Drag And Resize Behavior

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `app.py`
- Test: `tests/backend-regressions.mjs`

- [ ] **Step 1: Write the failing test**

```js
test('frameless window keeps draggable header semantics after scan workflow changes', () => {
  assert(
    frontendHtml.includes('<header class="top-nav pywebview-drag-region">'),
    'Expected the main header to remain the native drag region.',
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node tests/backend-regressions.mjs
```

Expected: FAIL for the missing drag-region header markup.

- [ ] **Step 3: Write minimal implementation**

```html
<header class="top-nav pywebview-drag-region">
```

```python
window = webview.create_window(
    ...,
    frameless=True,
    easy_drag=False,
    min_size=(1000, 600),
)
```

```css
.pywebview-drag-region {
  cursor: move;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node tests/backend-regressions.mjs
```

Expected: PASS for the frameless drag-region assertions.

- [ ] **Step 5: Commit**

```bash
git add app.py frontend/index.html frontend/static/css/styles.css tests/backend-regressions.mjs
git commit -m "fix: restore frameless shell drag behavior"
```

### Task 5: End-To-End Verification And Cleanup

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `frontend/static/js/app.js`
- Modify: `backend/main.py`
- Modify: `backend/smart_scan.py`
- Test: `tests/frontend-regressions.mjs`
- Test: `tests/backend-regressions.mjs`
- Test: `tests/test_smart_scan.py`

- [ ] **Step 1: Run the targeted verification suite**

Run:

```bash
node --check frontend/static/js/app.js
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m py_compile backend/main.py backend/smart_scan.py backend/job_progress.py
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node tests/frontend-regressions.mjs
node tests/backend-regressions.mjs
```

- [ ] **Step 2: If any scan-flow assertions still fail, tighten only the affected layer**

```text
Frontend layout failure -> fix hidden-state CSS / modal DOM only
Wrong counts or wrong summary -> fix backend result payload / toolbar renderer only
Drag failure -> fix header drag-region markup or frameless shell config only
```

- [ ] **Step 3: Re-run the same verification suite**

Run:

```bash
node --check frontend/static/js/app.js
& 'C:\Users\vikas\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' -m unittest tests.test_smart_scan -v
node tests/frontend-regressions.mjs
node tests/backend-regressions.mjs
```

- [ ] **Step 4: Commit**

```bash
git add app.py backend/main.py backend/job_progress.py backend/smart_scan.py frontend/index.html frontend/static/css/styles.css frontend/static/js/app.js tests/frontend-regressions.mjs tests/backend-regressions.mjs tests/test_smart_scan.py
git commit -m "fix: stabilize scan workflow revamp"
```

