import re
import time
from typing import Any, Callable, Iterable, Optional

from sqlalchemy import or_
from sqlalchemy.orm import Session

from backend.database import Game
from backend.scraper import apply_metadata_to_game, fetch_source_metadata
from backend.source_map import persist_game_snapshot
from backend.versioning import UpdateSource, build_update_source, source_request_url


SUPPORTED_METADATA_SOURCES = {"f95zone", "dlsite", "itch", "steam"}
RESULT_LIMIT = 50


def _safe_error(exc: Exception) -> str:
    message = re.sub(r"\s+", " ", str(exc or "Metadata refresh failed")).strip()
    return (message or "Metadata refresh failed")[:300]


def _preferred_source(game: Game) -> Optional[UpdateSource]:
    preferred = next(
        (source for source in list(getattr(game, "sources", []) or []) if source.is_preferred),
        None,
    )
    if preferred is None:
        return None
    return build_update_source(preferred.source_type, preferred.source_url, preferred.source_id)


def _main_source(game: Game) -> UpdateSource:
    return build_update_source(game.source_type, game.source_url, game.source_id)


def resolve_metadata_refresh_source(game: Game) -> UpdateSource:
    """Resolve the existing preferred source, falling back only to the game's main source."""
    preferred = _preferred_source(game)
    if (
        preferred
        and preferred.source_type in SUPPORTED_METADATA_SOURCES
        and source_request_url(preferred)
    ):
        return preferred
    main = _main_source(game)
    if main.source_type != "unknown" or main.source_url or main.source_id:
        return main
    return preferred or main


def _has_stored_source(game: Game) -> bool:
    source = resolve_metadata_refresh_source(game)
    return bool(source.source_url or source.source_id) and source.source_type != "unknown"


def list_metadata_refresh_targets(db: Session) -> list[Game]:
    candidates = (
        db.query(Game)
        .filter(
            Game.file_type != "wishlist",
            Game.is_ignored == False,
            or_(Game.missing_scan_count == 0, Game.missing_scan_count.is_(None)),
        )
        .order_by(Game.title.asc())
        .all()
    )
    return [game for game in candidates if _has_stored_source(game)]


def _bounded_append(items: list[dict], item: dict) -> None:
    if len(items) < RESULT_LIMIT:
        items.append(item)


def refresh_all_metadata(
    db: Session,
    *,
    games: Optional[Iterable[Game]] = None,
    metadata_fetcher: Callable[[Optional[str], Optional[str], Optional[str]], dict[str, Any]] = fetch_source_metadata,
    progress_callback: Optional[Callable[[dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    throttle_seconds: float = 0.25,
) -> dict:
    eligible = list(games) if games is not None else list_metadata_refresh_targets(db)
    counters = {
        "refreshed_count": 0,
        "skipped_count": 0,
        "unsupported_count": 0,
        "failed_count": 0,
    }
    refreshed_games: list[dict] = []
    unsupported_games: list[dict] = []
    failed_games: list[dict] = []
    processed = 0
    cancelled = False

    for index, game in enumerate(eligible, start=1):
        if should_cancel and should_cancel():
            cancelled = True
            break

        source = resolve_metadata_refresh_source(game)
        progress = {
            "processed": processed,
            "total": len(eligible),
            "current_index": index,
            "current_game_id": game.id,
            "current_title": game.title or game.raw_name,
            "current_source": source.source_type,
            **counters,
        }
        if progress_callback:
            progress_callback(progress)

        if source.source_type not in SUPPORTED_METADATA_SOURCES or not source_request_url(source):
            counters["unsupported_count"] += 1
            reason = "unsupported_source" if source.source_type not in SUPPORTED_METADATA_SOURCES else "invalid_source_url"
            _bounded_append(
                unsupported_games,
                {"game_id": game.id, "title": game.title, "source_type": source.source_type, "reason": reason},
            )
        else:
            try:
                data = metadata_fetcher(source.source_type, source.source_url, source.source_id)
            except Exception as exc:
                db.rollback()
                counters["failed_count"] += 1
                _bounded_append(
                    failed_games,
                    {"game_id": game.id, "title": game.title, "source_type": source.source_type, "reason": "source_unreachable", "error": _safe_error(exc)},
                )
            else:
                if not data:
                    counters["failed_count"] += 1
                    _bounded_append(
                        failed_games,
                        {"game_id": game.id, "title": game.title, "source_type": source.source_type, "reason": "parser_returned_no_metadata"},
                    )
                else:
                    try:
                        apply_metadata_to_game(
                            game,
                            db,
                            data,
                            force_overwrite=True,
                            commit=False,
                            persist_snapshot_after=False,
                        )
                        db.commit()
                        db.refresh(game)
                    except Exception as exc:
                        db.rollback()
                        counters["failed_count"] += 1
                        _bounded_append(
                            failed_games,
                            {"game_id": game.id, "title": game.title, "source_type": source.source_type, "reason": "database_failure", "error": _safe_error(exc)},
                        )
                    else:
                        try:
                            persist_game_snapshot(game)
                        except Exception:
                            pass
                        counters["refreshed_count"] += 1
                        _bounded_append(
                            refreshed_games,
                            {"game_id": game.id, "title": game.title, "source_type": source.source_type},
                        )

        processed = index
        if progress_callback:
            progress_callback({
                "processed": processed,
                "total": len(eligible),
                "current_index": index,
                "current_game_id": game.id,
                "current_title": game.title or game.raw_name,
                "current_source": source.source_type,
                **counters,
            })
        if throttle_seconds > 0 and processed < len(eligible):
            time.sleep(throttle_seconds)

    summary = (
        f"Metadata refresh {'cancelled' if cancelled else 'complete'}. "
        f"{processed} of {len(eligible)} games processed, {counters['refreshed_count']} refreshed, "
        f"{counters['unsupported_count']} unsupported, {counters['failed_count']} failed."
    )
    return {
        "cancelled": cancelled,
        "processed": processed,
        "total": len(eligible),
        "remaining": max(0, len(eligible) - processed),
        **counters,
        "refreshed_games": refreshed_games,
        "unsupported_games": unsupported_games,
        "failed_games": failed_games,
        "summary": summary,
    }
