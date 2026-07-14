# Merge UI Overhaul to Main Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the local feature work, the Codex worktree UI overhaul, and the newest overview-layout edits into a single tested `main` branch without losing any user work.

**Architecture:** Treat `main` as authoritative for the expanded game-version, library-portability, metadata-refresh, launch, and multi-directory backend contracts. Treat `codex/overhaul-xdir-fronte` as authoritative for the redesigned shell, cards, settings workflows, progress surfaces, and visual system. Resolve duplicated update-check implementations through the richer `backend/versioning.py` contract, then adapt the redesigned frontend to that contract and retain the newest independent overview-column layout.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy/SQLite, vanilla JavaScript, HTML, CSS, Node static-regression scripts, Python `unittest`

---

### Task 1: Preserve every recovery point

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `tests/frontend-regressions.mjs`

- [ ] **Step 1: Verify the three newest local edits are the only uncommitted files.**

Run: `git status --short`

Expected: only the three files listed above are modified.

- [ ] **Step 2: Commit the newest overview-column and cache-revision work.**

Run: `git add frontend/index.html frontend/static/css/styles.css tests/frontend-regressions.mjs`

Run: `git commit -m "Fix overview content flow"`

Expected: a new commit on `main` containing the independent main-column layout, gallery placement, stylesheet revision, and regression assertions.

- [ ] **Step 3: Create an immutable branch pointer before integration.**

Run: `git branch codex/backup-main-before-ui-merge`

Expected: `codex/backup-main-before-ui-merge` points to the new local commit, while `codex/overhaul-xdir-fronte` remains at `0875f68`.

### Task 2: Start the real merge and inventory conflicts

**Files:**
- Merge: `codex/overhaul-xdir-fronte`

- [ ] **Step 1: Merge the UI-overhaul branch without creating the merge commit yet.**

Run: `git merge --no-ff --no-commit codex/overhaul-xdir-fronte`

Expected: Git stages non-overlapping additions and reports conflicts in backend contracts, the three frontend assets, and their regression scripts.

- [ ] **Step 2: Confirm the conflict surface before editing.**

Run: `git diff --name-only --diff-filter=U`

Expected: conflicts are limited to `backend/config.py`, `backend/database.py`, `backend/main.py`, `backend/scraper.py`, `backend/smart_scan.py`, `frontend/index.html`, `frontend/static/css/styles.css`, `frontend/static/js/app.js`, `tests/backend-regressions.mjs`, and `tests/frontend-regressions.mjs`.

### Task 3: Consolidate backend contracts

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/database.py`
- Modify: `backend/main.py`
- Modify: `backend/scraper.py`
- Modify: `backend/smart_scan.py`
- Review: `backend/update_checks.py`
- Test: `tests/test_update_checks.py`
- Test: `tests/test_versioning.py`
- Test: `tests/test_update_api.py`
- Test: `tests/test_metadata_refresh.py`

- [ ] **Step 1: Resolve settings and persistence around the richer main model.**

Keep these main settings and fields as canonical:

```python
"automatic_game_update_checks": True,
"game_update_check_interval_days": 7,
"last_game_update_check_at": None,
"last_full_metadata_refresh_at": None,
```

Keep `last_update_check_at`, `last_update_check_status`, `last_update_check_error`, `update_detected_at`, `local_version_is_manual`, and `title_is_manual` on `Game`. Do not add the competing `update_checked_at`/`update_status` persistence schema; translate UI labels from the canonical main fields instead.

- [ ] **Step 2: Resolve API conflicts around the main versioning services while retaining worktree workflows.**

Keep `backend.versioning` as the update-check engine and preserve these routes:

```text
PATCH /api/games/{game_id}/version
POST  /api/games/{game_id}/mark-latest-installed
POST  /api/games/{game_id}/check-update
POST  /api/library/check-updates
POST  /api/library/refresh-all-metadata
GET   /api/library/jobs/{job_key}
POST  /api/library/jobs/{job_key}/cancel
```

Retain the local launch, open-folder, export/import, source-management, multi-directory, and metadata-refresh endpoints. Bring across only worktree job-result fields that add UI value and map them to the canonical versioning results.

- [ ] **Step 3: Resolve scraper and smart-scan conflicts additively.**

Preserve main protections for manual title/version values, source history, and provider-aware update checks. Retain the worktree improvements for metadata refresh, status reporting, and review progress where they do not weaken those protections.

- [ ] **Step 4: Remove all conflict markers and syntax-check the backend.**

Run: `rg -n "^(<<<<<<<|=======|>>>>>>>)" backend`

Expected: no matches.

Run: `python -m py_compile backend/config.py backend/database.py backend/main.py backend/scraper.py backend/smart_scan.py backend/versioning.py`

Expected: exit code 0.

### Task 4: Preserve the redesigned UI and local feature additions

**Files:**
- Modify: `frontend/index.html`
- Modify: `frontend/static/css/styles.css`
- Modify: `frontend/static/js/app.js`

- [ ] **Step 1: Use the worktree shell and visual system as the layout baseline.**

Preserve the worktree navigation, library toolbar, update/filter surfaces, settings layout, refresh confirmation, job progress presentation, card treatment, spacing, typography, responsive rules, and overlay styling. Keep the cache-busted stylesheet revision at least `v=12`.

- [ ] **Step 2: Port the local feature controls into the redesigned markup.**

The integrated page must retain controls and containers for:

```text
multiple library directories
library export/import
launch and open-folder actions
local/latest version facts
check-update and mark-latest-installed actions
manual local-version editing
source management
metadata refresh and update-check scheduling
missing-source review
```

- [ ] **Step 3: Keep the newest overview content-flow fix.**

Use `.ov-summary-main` as the independent left column containing the cover, About & Tags, description, and gallery. Keep `#ov-snapshot-card` as the right rail so a tall snapshot panel cannot create blank grid rows.

- [ ] **Step 4: Adapt JavaScript to the canonical main API.**

Use `PATCH /api/games/{id}/version` with `{ "local_version": value }`, render `last_update_check_status` and `update_available`, preserve library jobs and cancellation, and keep all local launch, directory, portability, metadata, source, and overview interactions. Remove any call to the obsolete `/api/games/{id}/local-version` route.

- [ ] **Step 5: Remove conflict markers and syntax-check the frontend.**

Run: `rg -n "^(<<<<<<<|=======|>>>>>>>)" frontend`

Expected: no matches.

Run: `node --check frontend/static/js/app.js`

Expected: exit code 0.

### Task 5: Combine regression coverage

**Files:**
- Modify: `tests/backend-regressions.mjs`
- Modify: `tests/frontend-regressions.mjs`
- Review: `tests/app-upgrade-regressions.mjs`
- Review: `tests/test_update_checks.py`

- [ ] **Step 1: Retain assertions from both branches without duplicate or contradictory contracts.**

Keep worktree checks for the redesigned library/settings/progress UI and main checks for launch, directories, portability, version status, overview actions, and manual-value protection. Update obsolete `/local-version` assertions to the canonical `/version` route.

- [ ] **Step 2: Run every Node regression script.**

Run: `node tests/frontend-regressions.mjs`

Run: `node tests/backend-regressions.mjs`

Run: `node tests/app-upgrade-regressions.mjs`

Expected: all scripts exit 0.

- [ ] **Step 3: Run the complete Python suite.**

Run: `python -m unittest discover -s tests -v`

Expected: all tests pass, including smart scan, scraper, versioning, update APIs, metadata refresh, portability, library directories, and launching.

### Task 6: Visual QA and merge completion

**Files:**
- Verify: `frontend/index.html`
- Verify: `frontend/static/css/styles.css`
- Verify: `frontend/static/js/app.js`

- [ ] **Step 1: Launch the local application/server and inspect the redesigned library, settings, and overview at desktop and narrow widths.**

Expected: no console errors; the overhaul styling is visible; feature controls are present; the overview cover/About/gallery column flows independently from the snapshot rail; overlays and progress surfaces remain usable.

- [ ] **Step 2: Run final repository checks.**

Run: `git diff --check`

Run: `git status --short`

Expected: no whitespace errors and no unmerged paths.

- [ ] **Step 3: Create the merge commit.**

Run: `git add backend frontend tests docs/superpowers/plans/2026-07-14-stage-two-frontend.md docs/superpowers/plans/2026-07-14-merge-ui-overhaul-to-main.md`

Run: `git commit -m "Merge UI overhaul and local feature work"`

Expected: `main` contains both parent histories and the working tree is clean.
