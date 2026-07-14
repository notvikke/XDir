import re
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.database import Game, GameSource
from backend.ingest import cleanup_redundant_wishlist_entries, is_metadata_rich
from backend.scraper import (
    apply_metadata_to_game,
    fetch_source_metadata,
    search_dlsite,
    search_f95zone,
    search_itch,
)
from backend.source_map import persist_game_snapshot
from backend.versioning import has_usable_linked_source
from backend.title_normalization import (
    compact_title,
    generate_query_candidates,
    normalize_title,
    remove_bracketed_tags,
    remove_noise_words,
    remove_platform_tags,
    remove_random_numeric_suffix,
    remove_versions,
    replace_separators,
    strip_file_extension,
    tokenize_title,
)


DEFAULT_SOURCE_ORDER = ["f95zone", "dlsite", "itch"]
CONFIDENCE_PRIORITY = {
    "high": 0,
    "medium": 1,
    "low": 2,
}
SEARCH_HANDLERS = {
    "f95zone": search_f95zone,
    "dlsite": search_dlsite,
    "itch": search_itch,
}


def build_game_search_queries(game: Game) -> List[Dict[str, str]]:
    seeds = [
        getattr(game, "title", None),
        getattr(game, "raw_name", None),
        getattr(game, "archive_name", None),
    ]
    folder_path = str(getattr(game, "folder_path", "") or "").strip()
    if folder_path:
        seeds.append(Path(folder_path).name)
    source_id = str(getattr(game, "source_id", "") or "").strip()
    if re.fullmatch(r"(?i)(?:RJ|VJ|BJ)\d{6,8}", source_id):
        seeds.append(source_id.upper())

    queries: List[Dict[str, str]] = []
    seen: set[str] = set()
    for seed in seeds:
        if not str(seed or "").strip():
            continue
        for candidate in generate_query_candidates(str(seed)):
            key = candidate["query"].casefold()
            if key in seen:
                continue
            seen.add(key)
            queries.append(candidate)
    return queries


def build_source_search_order(preferred_source: Optional[str] = None) -> List[str]:
    preferred = str(preferred_source or "").strip().lower()
    if preferred not in DEFAULT_SOURCE_ORDER:
        return DEFAULT_SOURCE_ORDER.copy()
    return [preferred] + [source for source in DEFAULT_SOURCE_ORDER if source != preferred]


def _source_priority_map(source_order: Optional[List[str]] = None) -> Dict[str, int]:
    order = source_order or DEFAULT_SOURCE_ORDER
    return {source: index for index, source in enumerate(order)}


def _clean_title(value: str) -> str:
    return normalize_title(value or "")


def _folder_seed_title(value: str) -> str:
    cleaned = strip_file_extension(value or "")
    cleaned = remove_bracketed_tags(cleaned)
    cleaned = remove_random_numeric_suffix(cleaned)
    cleaned = remove_versions(cleaned)
    cleaned = remove_platform_tags(cleaned)
    cleaned = remove_noise_words(cleaned)
    cleaned = replace_separators(cleaned)
    return re.sub(r"\s+", " ", cleaned).strip()


def _title_looks_folder_based(game: Game) -> bool:
    title = str(game.title or "").strip()
    raw_name = str(game.raw_name or "").strip()
    if not title:
        return True
    if re.match(r"^[RVB]J\d{6,8}$", title, re.IGNORECASE):
        return True
    if title == raw_name:
        return True
    if title.lower() == _folder_seed_title(raw_name).lower():
        return True
    if re.search(r"(?i)\b(?:v|ver|build|windows|win|linux|mac|android|final|completed|compressed|mod|repack|crack|update)\b", title):
        return True
    return False


def should_include_in_missing_source_scan(game: Game) -> bool:
    if getattr(game, "file_type", "") == "wishlist":
        return False
    if getattr(game, "is_ignored", False):
        return False
    if int(getattr(game, "missing_scan_count", 0) or 0) > 0:
        return False
    return not has_usable_linked_source(game)


def list_missing_source_scan_targets(db: Session) -> List[Game]:
    games = (
        db.query(Game)
        .filter(Game.file_type != "wishlist", Game.is_ignored == False)
        .order_by(Game.title.asc())
        .all()
    )
    return [game for game in games if should_include_in_missing_source_scan(game)]


def _normalized_title_candidates(value: str) -> List[str]:
    normalized = _clean_title(value)
    compact = compact_title(value or "").lower()
    candidates = []
    for item in (normalized, compact):
        if item and item not in candidates:
            candidates.append(item)
    return candidates


def score_candidate_match(
    local_name: str,
    candidate: Dict[str, Any],
    *,
    developer_hint: Optional[str] = None,
    title_hint: Optional[str] = None,
) -> Dict[str, Any]:
    candidate_title = str(candidate.get("title") or "").strip()
    candidate_creator = str(candidate.get("creator") or "").strip()
    local_values = [value for value in (title_hint, local_name) if value]
    local_normalized = []
    for value in local_values:
        for normalized in _normalized_title_candidates(value):
            if normalized not in local_normalized:
                local_normalized.append(normalized)

    candidate_normalized = _normalized_title_candidates(candidate_title)
    reasons: List[str] = []
    score = 0
    exact_match = False
    compact_match = False
    developer_match = False
    best_similarity = 0.0
    best_overlap = 0

    for local_value in local_values:
        local_tokens = set(tokenize_title(local_value))
        for candidate_value in (candidate_title,):
            candidate_tokens = set(tokenize_title(candidate_value))
            overlap = len(local_tokens & candidate_tokens)
            best_overlap = max(best_overlap, overlap)
            if overlap >= 2:
                score += min(18, overlap * 6)
                if "Strong word overlap" not in reasons:
                    reasons.append("Strong word overlap")

    for local_item in local_normalized:
        for candidate_item in candidate_normalized:
            if not local_item or not candidate_item:
                continue
            if local_item == candidate_item:
                exact_match = True
                score = max(score, 94)
                if "Exact normalized title match" not in reasons:
                    reasons.append("Exact normalized title match")
            local_compact = re.sub(r"\s+", "", local_item)
            candidate_compact = re.sub(r"\s+", "", candidate_item)
            if local_compact and local_compact == candidate_compact:
                compact_match = True
                score = max(score, 90)
                if "PascalCase / compact title match" not in reasons:
                    reasons.append("PascalCase / compact title match")
            if local_item.startswith(candidate_item) or candidate_item.startswith(local_item):
                score = max(score, 74)
                if "Partial normalized title match" not in reasons:
                    reasons.append("Partial normalized title match")
            similarity = SequenceMatcher(None, local_item, candidate_item).ratio()
            best_similarity = max(best_similarity, similarity)

    if best_similarity >= 0.98:
        score = max(score, 95)
        if "Near-identical fuzzy title match" not in reasons:
            reasons.append("Near-identical fuzzy title match")
    elif best_similarity >= 0.9:
        score = max(score, 82)
        if "Strong fuzzy title match" not in reasons:
            reasons.append("Strong fuzzy title match")
    elif best_similarity >= 0.8:
        score = max(score, 64)
        if "Moderate fuzzy title match" not in reasons:
            reasons.append("Moderate fuzzy title match")
    elif best_similarity >= 0.65:
        score = max(score, 48)

    normalized_developer = _clean_title(developer_hint or "")
    normalized_creator = _clean_title(candidate_creator)
    if normalized_developer and normalized_creator:
        if normalized_developer == normalized_creator:
            developer_match = True
            score += 18
            reasons.append("Developer/circle match")
        elif normalized_developer in normalized_creator or normalized_creator in normalized_developer:
            score += 10
            reasons.append("Developer/circle partial match")

    if exact_match or compact_match or (best_similarity >= 0.92 and developer_match):
        confidence = "high"
    elif score >= 62 or best_similarity >= 0.78 or best_overlap >= 2:
        confidence = "medium"
    else:
        confidence = "low"

    return {
        "score": score,
        "confidence": confidence,
        "reasons": reasons or ["Low-signal match"],
        "similarity": round(best_similarity, 4),
    }


def choose_best_candidate(
    candidates: List[Dict[str, Any]],
    *,
    source_order: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    if not candidates:
        return None
    source_priority = _source_priority_map(source_order)
    ranked = sorted(
        candidates,
        key=lambda item: (
            CONFIDENCE_PRIORITY.get(item.get("confidence") or "low", 9),
            -int(item.get("score") or 0),
            source_priority.get((item.get("source_type") or "").lower(), 9),
            len(str(item.get("title") or "")),
        ),
    )
    return ranked[0]


def _rank_candidates(
    candidates: List[Dict[str, Any]],
    *,
    source_order: Optional[List[str]] = None,
) -> List[Dict[str, Any]]:
    source_priority = _source_priority_map(source_order)
    return sorted(
        candidates,
        key=lambda item: (
            CONFIDENCE_PRIORITY.get(item.get("confidence") or "low", 9),
            -int(item.get("score") or 0),
            source_priority.get((item.get("source_type") or "").lower(), 9),
            str(item.get("title") or "").lower(),
        ),
    )


def choose_unambiguous_auto_match(
    candidates: List[Dict[str, Any]],
    *,
    source_order: Optional[List[str]] = None,
) -> Optional[Dict[str, Any]]:
    ranked = _rank_candidates(candidates, source_order=source_order)
    if not ranked:
        return None
    best = ranked[0]
    if best.get("confidence") != "high" or int(best.get("score") or 0) < 94:
        return None
    if len(ranked) > 1 and int(best.get("score") or 0) - int(ranked[1].get("score") or 0) < 8:
        return None
    return best


def _candidate_key(candidate: Dict[str, Any]) -> str:
    source_type = str(candidate.get("source_type") or "").lower()
    url = str(candidate.get("url") or candidate.get("source_url") or "").strip().lower().rstrip("/")
    source_id = str(candidate.get("source_id") or "").strip().lower()
    title = str(candidate.get("title") or "").strip().lower()
    return "|".join((source_type, url or source_id, title))


def _has_conflicting_metadata(game: Game, candidate: Dict[str, Any]) -> bool:
    if not is_metadata_rich(game):
        return False
    current_source = (game.source_type or "unknown").lower()
    candidate_source = (candidate.get("source_type") or "").lower()
    if current_source not in ("", "unknown") and candidate_source and current_source != candidate_source:
        if game.source_url or game.source_id:
            return True
    existing_developer = _clean_title(game.developer or "")
    candidate_creator = _clean_title(candidate.get("creator") or "")
    if existing_developer and candidate_creator and existing_developer != candidate_creator:
        return True
    return False


def describe_metadata_status(game: Game) -> str:
    issues: List[str] = []
    if not game.cover_url:
        issues.append("missing cover")
    if not game.description:
        issues.append("missing description")
    if not game.source_url:
        issues.append("missing source URL")
    if not game.source_id:
        issues.append("missing source ID")
    if _title_looks_folder_based(game):
        issues.append("title still matches folder")
    if not issues:
        return "Metadata needs verification"
    return ", ".join(issues[:4])


def choose_review_thumbnail(candidate: Optional[Dict[str, Any]], game: Game) -> Optional[str]:
    candidate_cover = str((candidate or {}).get("cover") or "").strip()
    if candidate_cover:
        return candidate_cover
    existing_cover = str(getattr(game, "cover_url", "") or "").strip()
    return existing_cover or None


_MATCH_REASON_CODES = {
    "Exact normalized title match": "normalized_title_match",
    "PascalCase / compact title match": "compact_title_match",
    "Near-identical fuzzy title match": "near_identical_title_match",
    "Strong fuzzy title match": "strong_title_match",
    "Moderate fuzzy title match": "moderate_title_match",
    "Partial normalized title match": "partial_title_match",
    "Strong word overlap": "title_word_overlap",
    "Developer/circle match": "developer_match",
    "Developer/circle partial match": "developer_partial_match",
    "Low-signal match": "low_signal_match",
}


def _review_candidate(candidate: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "source_type": candidate.get("source_type"),
        "source_url": candidate.get("source_url") or candidate.get("url"),
        "source_id": candidate.get("source_id"),
        "title": candidate.get("title"),
        "creator": candidate.get("creator"),
        "cover": candidate.get("cover"),
        "version": candidate.get("version"),
    }


def build_missing_source_review_item(
    game: Game,
    *,
    status: str,
    candidates: List[Dict[str, Any]],
    error_summary: Optional[str] = None,
    thumbnail_candidate: Optional[Dict[str, Any]] = None,
    source_order: Optional[List[str]] = None,
) -> Dict[str, Any]:
    ranked_candidates = _rank_candidates(candidates, source_order=source_order) if candidates else []
    thumbnail_source = thumbnail_candidate or choose_best_candidate(ranked_candidates, source_order=source_order)
    top_candidate = ranked_candidates[0] if ranked_candidates else None
    confidence = round(min(1.0, max(0, int((top_candidate or {}).get("score") or 0)) / 100), 2)
    match_reason = [
        _MATCH_REASON_CODES.get(reason, re.sub(r"[^a-z0-9]+", "_", reason.casefold()).strip("_"))
        for reason in list((top_candidate or {}).get("reasons") or [])
    ]
    return {
        "game_id": game.id,
        "local_title": game.title,
        "raw_name": game.raw_name,
        "folder_path": game.folder_path,
        "candidate": _review_candidate(top_candidate) if top_candidate else None,
        "confidence": confidence,
        "match_reason": match_reason,
        # Compatibility fields retained until the stage-two frontend consumes the canonical contract.
        "local_name": game.raw_name,
        "raw_name": game.raw_name,
        "folder_path": game.folder_path,
        "archive_name": getattr(game, "archive_name", None),
        "current_title": game.title,
        "metadata_status": describe_metadata_status(game),
        "status": status,
        "thumbnail_url": choose_review_thumbnail(thumbnail_source, game),
        "candidates": ranked_candidates[:8],
        "error_summary": error_summary,
    }


def apply_missing_source_candidate(
    game: Game,
    db: Session,
    candidate: Dict[str, Any],
    *,
    force_overwrite: bool,
) -> Dict[str, Any]:
    source_type = str(candidate.get("source_type") or "").strip().lower()
    source_url = str(candidate.get("url") or candidate.get("source_url") or "").strip()
    source_id = str(candidate.get("source_id") or "").strip() or None
    if not source_type or not source_url:
        raise ValueError("Candidate source details are incomplete.")

    normalized_url = source_url.casefold().rstrip("/")
    normalized_source_id = str(source_id or "").casefold()
    existing_source = next(
        (
            item
            for item in game.sources
            if str(item.source_type or "").casefold() == source_type
            and (
                str(item.source_url or "").casefold().rstrip("/") == normalized_url
                or (normalized_source_id and str(item.source_id or "").casefold() == normalized_source_id)
            )
        ),
        None,
    )
    for item in game.sources:
        item.is_preferred = False
    if existing_source:
        existing_source.is_preferred = True
        source_url = existing_source.source_url
        if source_id and not existing_source.source_id:
            existing_source.source_id = source_id
    else:
        game.sources.append(
            GameSource(
                game_id=game.id,
                source_type=source_type,
                source_url=source_url,
                source_id=source_id,
                title_reported=candidate.get("title") or None,
                version_reported=candidate.get("version") or None,
                is_preferred=True,
            )
        )

    game.source_type = source_type
    game.source_url = source_url
    game.source_id = source_id
    game.is_identified = True

    if not getattr(game, "title_is_manual", False) and _title_looks_folder_based(game) and candidate.get("title"):
        game.title = str(candidate.get("title")).strip()
    if not game.developer and candidate.get("creator"):
        game.developer = str(candidate.get("creator")).strip()
    if not game.cover_url and candidate.get("cover"):
        game.cover_url = str(candidate.get("cover")).strip()
    if not game.latest_version and candidate.get("version"):
        game.latest_version = str(candidate.get("version")).strip()

    db.add(game)
    db.commit()
    db.refresh(game)

    warning = None
    try:
        data = fetch_source_metadata(source_type, source_url, source_id)
        if data:
            apply_metadata_to_game(game, db, data, force_overwrite=force_overwrite)
        else:
            warning = f"No metadata could be loaded from the selected {source_type.upper()} source."
    except Exception as exc:
        warning = f"Failed to fetch metadata from {source_type.upper()}: {exc}"

    cleanup_redundant_wishlist_entries(db, game)
    db.commit()
    db.refresh(game)
    persist_game_snapshot(game)
    return {"game": game, "warning": warning}


def _search_candidates_for_game(
    game: Game,
    *,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    processed: int,
    total: int,
    current_index: int,
    preferred_source: Optional[str] = None,
) -> Dict[str, Any]:
    local_name = game.raw_name or game.title or ""
    query_candidates = build_game_search_queries(game)
    developer_hint = game.developer or None
    source_order = build_source_search_order(preferred_source)
    seen = set()
    candidates: List[Dict[str, Any]] = []
    errors: List[str] = []

    for source_type in source_order:
        handler = SEARCH_HANDLERS[source_type]
        for query in query_candidates:
            if should_cancel and should_cancel():
                return {"cancelled": True}
            if progress_callback:
                progress_callback(
                    {
                        "processed": processed,
                        "total": total,
                        "current_index": current_index,
                        "current_title": game.title or game.raw_name,
                        "current_source": source_type,
                        "current_query": query["query"],
                        "detail": "Searching source candidates...",
                    }
                )
            try:
                raw_results = handler(query["query"])
            except Exception as exc:
                errors.append(f"{source_type.upper()}: {exc}")
                continue

            for item in raw_results:
                candidate = {
                    "source_type": source_type,
                    "source_id": item.get("source_id"),
                    "title": item.get("title"),
                    "creator": item.get("creator"),
                    "cover": item.get("cover"),
                    "version": item.get("version"),
                    "url": item.get("url"),
                    "matched_query": query["query"],
                }
                key = _candidate_key(candidate)
                if not key or key in seen:
                    continue
                seen.add(key)
                candidate.update(
                    score_candidate_match(
                        local_name,
                        candidate,
                        developer_hint=developer_hint,
                        title_hint=game.title,
                    )
                )
                candidates.append(candidate)

    best_candidate = choose_unambiguous_auto_match(candidates, source_order=source_order)
    if best_candidate:
        return {"status": "auto", "candidate": best_candidate, "candidates": _rank_candidates(candidates, source_order=source_order), "errors": errors}
    if candidates:
        return {"status": "review", "candidates": _rank_candidates(candidates, source_order=source_order)[:8], "errors": errors}
    if errors and len(errors) >= 3:
        return {"status": "failed", "candidates": [], "errors": errors}
    return {"status": "not_found", "candidates": [], "errors": errors}


def run_missing_source_scan(
    db: Session,
    *,
    progress_callback: Optional[Callable[[Dict[str, Any]], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
) -> Dict[str, Any]:
    games = list_missing_source_scan_targets(db)
    preferred_source = get_settings().get("preferred_source")
    source_order = build_source_search_order(preferred_source)
    total = len(games)
    processed = 0
    matched = 0
    manual_review = 0
    not_found = 0
    failed = 0
    review_items: List[Dict[str, Any]] = []

    for index, game in enumerate(games, start=1):
        if should_cancel and should_cancel():
            break
        if progress_callback:
            progress_callback(
                {
                    "processed": processed,
                    "total": total,
                    "current_index": index,
                    "current_title": game.title or game.raw_name,
                    "current_source": "",
                    "current_query": "",
                    "detail": "Preparing search queries...",
                    "matched_count": matched,
                    "manual_review_count": manual_review,
                    "not_found_count": not_found,
                    "failed_count": failed,
                }
            )

        search_result = _search_candidates_for_game(
            game,
            progress_callback=progress_callback,
            should_cancel=should_cancel,
            processed=processed,
            total=total,
            current_index=index,
            preferred_source=preferred_source,
        )
        if search_result.get("cancelled"):
            break

        outcome = search_result.get("status") or "not_found"
        if outcome == "auto":
            candidate = search_result["candidate"]
            if _has_conflicting_metadata(game, candidate):
                outcome = "review"
            else:
                if progress_callback:
                    progress_callback(
                        {
                            "processed": processed,
                            "total": total,
                            "current_index": index,
                            "current_title": game.title or game.raw_name,
                            "current_source": candidate.get("source_type", ""),
                            "current_query": candidate.get("matched_query", ""),
                            "detail": "Applying metadata automatically...",
                            "matched_count": matched,
                            "manual_review_count": manual_review,
                            "not_found_count": not_found,
                            "failed_count": failed,
                        }
                    )
                applied = apply_missing_source_candidate(game, db, candidate, force_overwrite=False)
                if applied.get("warning"):
                    outcome = "failed"
                    review_items.append(
                        build_missing_source_review_item(
                            game,
                            status="failed",
                            candidates=[candidate],
                            error_summary=applied["warning"],
                            thumbnail_candidate=candidate,
                            source_order=source_order,
                        )
                    )
                    failed += 1
                else:
                    matched += 1

        if outcome == "review":
            review_items.append(
                build_missing_source_review_item(
                    game,
                    status="review",
                    candidates=search_result.get("candidates", []),
                    error_summary="; ".join(search_result.get("errors", [])[:2]) or None,
                    source_order=source_order,
                )
            )
            manual_review += 1
        elif outcome == "not_found":
            review_items.append(
                build_missing_source_review_item(
                    game,
                    status="not_found",
                    candidates=[],
                    error_summary="; ".join(search_result.get("errors", [])[:2]) or None,
                    source_order=source_order,
                )
            )
            not_found += 1
        elif outcome == "failed" and not any(item.get("game_id") == game.id for item in review_items):
            review_items.append(
                build_missing_source_review_item(
                    game,
                    status="failed",
                    candidates=search_result.get("candidates", []),
                    error_summary="; ".join(search_result.get("errors", [])[:2]) or "Source search failed",
                    source_order=source_order,
                )
            )
            failed += 1

        processed = index
        if progress_callback:
            progress_callback(
                {
                    "processed": processed,
                    "total": total,
                    "current_index": index,
                    "current_title": game.title or game.raw_name,
                    "current_source": "",
                    "current_query": "",
                    "detail": "Finished current game.",
                    "matched_count": matched,
                    "manual_review_count": manual_review,
                    "not_found_count": not_found,
                    "failed_count": failed,
                }
            )

    cancelled = bool(should_cancel and should_cancel() and processed < total)
    summary_prefix = "Missing source scan cancelled" if cancelled else "Missing source scan complete"
    summary = (
        f"{summary_prefix}. {processed} games processed, "
        f"{matched} metadata entries applied automatically, "
        f"{manual_review} need review, {not_found} not found, {failed} failed."
    )
    return {
        "cancelled": cancelled,
        "processed": processed,
        "total": total,
        "remaining": max(0, total - processed),
        "matched": matched,
        "manual_review": manual_review,
        "not_found": not_found,
        "failed": failed,
        "review_items": review_items,
        "summary": summary,
    }
