# XDir Backend Scan, Metadata Refresh, and Version Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the stage-one backend contracts for two library scan workflows, source-preserving bulk metadata refresh, formal game-version checks, upgrade/import compatibility, and automated regression coverage.

**Architecture:** Keep normal filesystem ingestion unchanged. Consolidate online source discovery in `backend/smart_scan.py` under missing-source-only APIs, put source-preserving refresh iteration in a focused `backend/metadata_refresh.py`, and retain version parsing/provider checks in `backend/versioning.py`. All long-running library operations use `backend/job_progress.py`, bounded result payloads, per-game transactions, cancellation between games, and the existing snapshot recovery system.

**Tech Stack:** Python 3.12, FastAPI, SQLAlchemy 2/SQLite, requests, BeautifulSoup, unittest, and the repository's Node static-regression scripts.

**Execution status (2026-07-14):** Complete. All tasks below were implemented and verified by the commands in Task 6.

---

### Task 1: Central version model and upgrade-safe persistence

**Files:**
- Create: `backend/versioning.py`
- Modify: `backend/database.py`
- Modify: `backend/source_map.py`
- Modify: `backend/library_portability.py`
- Test: `tests/test_versioning.py`
- Test: `tests/test_library_portability.py`

- [x] **Step 1: Write failing tests** for normalized numeric/date/counter/prerelease/letter versions, unknown and ambiguous values, model serialization, repeated SQLite migration, stale `checking` recovery, and portable snapshot fields.
- [x] **Step 2: Run the focused tests and verify RED** because `backend.versioning` and the new `Game` fields do not exist.
- [x] **Step 3: Implement typed comparison and durable state** with `normalize_version`, `compare_versions`, `evaluate_game_update_state`, `apply_comparison_to_game`, the six requested `Game` columns, idempotent `ALTER TABLE`, `to_dict()`, and snapshot/import round trips.
- [x] **Step 4: Run `python -m unittest tests.test_versioning tests.test_library_portability -v` and verify GREEN.**

### Task 2: Linked-source update checks and tracked library checks

**Files:**
- Modify: `backend/versioning.py`
- Modify: `backend/scraper.py`
- Modify: `backend/main.py`
- Modify: `backend/config.py`
- Modify: `backend/job_progress.py`
- Modify: `backend/ingest.py`
- Modify: `app.py`
- Test: `tests/test_update_api.py`

- [x] **Step 1: Write failing tests** for preferred-source resolution, F95/DLsite/Itch explicit version extraction, Steam unsupported behavior, failure preservation, single-game APIs, manual version ownership, extension sync numeric comparison, cancellation, and weekly scheduling.
- [x] **Step 2: Verify RED** against the pre-feature backend.
- [x] **Step 3: Implement the version APIs and `update-check` job** using only the linked source, structured comparison results, per-game rollback/continuation, bounded errors, and one-shot startup scheduling.
- [x] **Step 4: Guard ingestion from overwriting `local_version_is_manual` and verify GREEN** with `python -m unittest tests.test_versioning tests.test_update_api -v`.

### Task 3: Consolidate online discovery into Find Missing Sources

**Files:**
- Modify: `backend/smart_scan.py`
- Modify: `backend/main.py`
- Modify: `backend/job_progress.py`
- Modify: `tests/test_smart_scan.py`
- Modify: `tests/backend-regressions.mjs`

- [ ] **Step 1: Write failing eligibility tests** proving a preferred valid `GameSource`, a valid main source tuple, ignored entries, wishlist-only entries, and grace-hidden entries are excluded while genuinely unlinked visible games are included.

```python
linked = Game(title="Linked", file_type="folder", source_type="unknown")
linked.sources = [GameSource(source_type="itch", source_url="https://studio.itch.io/game", is_preferred=True)]
self.assertFalse(should_include_in_missing_source_scan(linked))
```

- [ ] **Step 2: Run `python -m unittest tests.test_smart_scan -v` and verify RED** because eligibility currently checks only the main source fields.
- [ ] **Step 3: Implement one canonical scan service** named `run_missing_source_scan`, retain the preferred-provider search order, require an unambiguous high-confidence winner before auto-apply, and emit canonical review items with `local_title`, `raw_name`, `folder_path`, one top-level `candidate`, numeric `confidence`, and machine-readable `match_reason`.
- [ ] **Step 4: Add failing apply tests** proving applying the same candidate twice leaves exactly one preferred source, fetches metadata, preserves local/user fields, persists a snapshot, and removes the matching unresolved review item from the tracked job when present.
- [ ] **Step 5: Replace `/api/library/smart-scan` and its job key** with only `POST /api/library/missing-source-scan`; move review application to `POST /api/library/missing-source-scan/review/{game_id}/apply` and add a skip endpoint that removes only the review item.
- [ ] **Step 6: Run the Python and Node focused regressions and verify GREEN.**

### Task 4: Source-preserving Refresh All Metadata

**Files:**
- Create: `backend/metadata_refresh.py`
- Modify: `backend/scraper.py`
- Modify: `backend/database.py`
- Modify: `backend/main.py`
- Modify: `backend/job_progress.py`
- Modify: `backend/config.py`
- Create: `tests/test_metadata_refresh.py`

- [ ] **Step 1: Write failing target/source tests** for preferred source selection, main-source fallback, supported URL validation, and exclusion of ignored, wishlist, grace-hidden, unlinked, unsupported, and invalid-URL records.
- [ ] **Step 2: Write failing preservation tests** using sentinel values for folder/archive fields, local/manual version, progress, score, journals, custom tags, ignore state, timestamps, and source selection; assert source metadata updates without a rematch or duplicate source.
- [ ] **Step 3: Add `title_is_manual` with an idempotent SQLite migration** and make source metadata title overwrite conditional on that flag.
- [ ] **Step 4: Implement `refresh_game_metadata` and `refresh_all_metadata`** so a request failure changes no existing metadata, empty parser data is classified separately, successful source fields overwrite atomically, standard tags/screenshots are replaced, custom tags remain untouched, each game commits independently, and result arrays are capped.

```python
result = refresh_all_metadata(
    db,
    games=targets,
    metadata_fetcher=fake_fetch,
    progress_callback=snapshots.append,
    should_cancel=lambda: cancelled,
)
self.assertEqual(result["refreshed_count"], 1)
self.assertEqual(game.folder_path, original_folder_path)
```

- [ ] **Step 5: Add `POST /api/library/refresh-all-metadata`** with job key `refresh-all-metadata`, the requested progress fields, bounded results, cancellation, reliable background-session cleanup, and `last_full_metadata_refresh_at` only after a meaningful pass.
- [ ] **Step 6: Run `python -m unittest tests.test_metadata_refresh -v` and verify GREEN.**

### Task 5: Settings, summary contracts, and import compatibility

**Files:**
- Modify: `backend/config.py`
- Modify: `backend/main.py`
- Modify: `backend/database.py`
- Modify: `tests/test_update_api.py`
- Modify: `tests/test_library_portability.py`
- Modify: `tests/app-upgrade-regressions.mjs`

- [ ] **Step 1: Add failing summary/settings tests** for linked/unlinked counts, update count, maintenance timestamps, automatic-check state, defaults, and bounded interval validation without network access.
- [ ] **Step 2: Extend `/api/stats`** with `linked_games`, `unlinked_games`, `games_with_updates`, `last_full_metadata_refresh`, `last_library_update_check`, and `automatic_game_update_checks` while preserving legacy count keys.
- [ ] **Step 3: Mark obsolete backend setting inputs as deprecated/ignored only after consumer search**; retain compatibility for current appearance clients until stage two removes them from the frontend.
- [ ] **Step 4: Add an old-schema integration test** that creates a pre-feature SQLite database, runs `init_db()`, verifies every new column/default, preserved games/sources/user data, no duplicate sources, stale-state normalization, and immediate refresh/update eligibility.
- [ ] **Step 5: Run the focused migration/import suites and verify GREEN.**

### Task 6: Full regression and diff verification

**Files:**
- Modify only where a failing regression demonstrates a feature-caused defect.

- [ ] **Step 1: Run `python -m unittest discover -s tests -v`.**
- [ ] **Step 2: Run `node tests/backend-regressions.mjs`, `node tests/app-upgrade-regressions.mjs`, and `node tests/frontend-regressions.mjs`.** The frontend suite may only receive contract-name updates; no stage-two redesign is included.
- [ ] **Step 3: Run Python compilation/import checks** for `app.py` and all backend modules.
- [ ] **Step 4: Run `git diff --check` and review the scoped diff** for source rematching, source duplication, user-owned field mutation, unbounded job payloads, raw trace leakage, destructive migration, obsolete smart-scan routes/job keys, and unrelated worktree changes.
