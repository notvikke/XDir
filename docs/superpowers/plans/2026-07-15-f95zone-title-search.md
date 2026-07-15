# F95Zone Title Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make F95Zone title search recover the correct thread when a literal title or title fragment fails because of punctuation, hyphens, possessives, or leading/trailing stopwords.

**Architecture:** Keep the existing universal-search API contract and improve only the shared F95Zone provider. Generate a bounded sequence of literal and normalized fallback queries, stop after the first query that returns rows, normalize and deduplicate those rows, and rank them against the user's original text before returning at most 15 results.

**Tech Stack:** Python 3, `requests`, existing `backend.title_normalization` helpers, `unittest` with `unittest.mock`.

---

### Task 1: Capture the reported title-search failures

**Files:**
- Modify: `tests/test_scraper.py`
- Test: `tests/test_scraper.py`

- [ ] **Step 1: Write failing regression tests**

Add tests that mock `backend.scraper.requests.get` and model the observed SAM behavior:

```python
@patch("backend.scraper.requests.get")
def test_search_f95zone_retries_with_a_normalized_possessive_title(self, mock_get):
    # Literal ASCII possessive returns no rows; normalized fallback returns the thread.
    ...
    self.assertEqual(results[0]["title"], "My wife’s most beautiful side")

@patch("backend.scraper.requests.get")
def test_search_f95zone_removes_edge_stopwords_and_ranks_the_best_partial_title(self, mock_get):
    # "I Got Lost in" returns no rows; "Got Lost" returns two plausible threads.
    ...
    self.assertTrue(results[0]["title"].startswith("I Got Lost in an All-Female Elf Village"))
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `python -m unittest tests.test_scraper -v`

Expected: both new tests fail because `search_f95zone` currently performs only the literal request and preserves upstream ordering.

### Task 2: Add bounded F95Zone fallback queries and relevance ranking

**Files:**
- Modify: `backend/scraper.py`
- Test: `tests/test_scraper.py`

- [ ] **Step 1: Implement query generation**

Add a helper that emits, in order, the trimmed literal query, an ASCII-word normalized query with possessive suffixes removed, and a stopword-trimmed/filtered phrase. Deduplicate candidates case-insensitively and reject phrases shorter than two useful characters.

```python
def _build_f95zone_search_queries(query: str) -> List[str]:
    # literal -> punctuation/possessive normalized -> meaningful words
    ...
```

- [ ] **Step 2: Implement result normalization and ranking**

Map SAM rows into the existing source-result contract, deduplicate by thread ID (falling back to URL/title), and sort using normalized exact, prefix, substring-position, token-overlap, and fuzzy similarity signals computed against the original user query.

```python
def _rank_f95zone_result(query: str, item: Dict[str, Any]) -> tuple:
    ...
```

- [ ] **Step 3: Update `search_f95zone` minimally**

Try the bounded candidates in order, stop at the first candidate returning rows, then deduplicate, rank, and return the top 15. Preserve the current empty-list behavior for short input and upstream failures.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `python -m unittest tests.test_scraper -v`

Expected: all scraper tests pass.

### Task 3: Verify integration and regression safety

**Files:**
- Verify only: `backend/scraper.py`, `tests/test_scraper.py`

- [ ] **Step 1: Run the backend search suites**

Run: `python -m unittest tests.test_scraper tests.test_smart_scan -v`

Expected: all tests pass.

- [ ] **Step 2: Run repository regression checks**

Run: `node tests/backend-regressions.mjs`

Expected: all checks pass.

- [ ] **Step 3: Review the final diff**

Run: `git diff --check` and `git diff -- backend/scraper.py tests/test_scraper.py docs/superpowers/plans/2026-07-15-f95zone-title-search.md`

Expected: no whitespace errors; only the scoped search implementation, tests, and plan are added. Keep the changes uncommitted so they are not mixed into the user's existing dirty worktree without an explicit commit request.
