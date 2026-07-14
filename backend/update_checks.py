import re
from datetime import datetime
from itertools import zip_longest
from typing import Optional, Tuple


SUPPORTED_UPDATE_SOURCES = {"f95zone", "dlsite", "itch", "steam"}


def _version_parts(value: Optional[str]) -> tuple[int, ...]:
    numbers = [int(part) for part in re.findall(r"\d+", str(value or ""))]
    while numbers and numbers[-1] == 0:
        numbers.pop()
    return tuple(numbers)


def compare_versions(local_version: Optional[str], latest_version: Optional[str]) -> int:
    """Return -1, 0, or 1 for local older than, equal to, or newer than remote."""
    local_parts = _version_parts(local_version)
    latest_parts = _version_parts(latest_version)
    if not local_parts or not latest_parts:
        local_text = str(local_version or "").strip().lower()
        latest_text = str(latest_version or "").strip().lower()
        return (local_text > latest_text) - (local_text < latest_text)
    for local, latest in zip_longest(local_parts, latest_parts, fillvalue=0):
        if local != latest:
            return -1 if local < latest else 1
    return 0


def derive_update_status(local_version: Optional[str], latest_version: Optional[str]) -> Tuple[str, bool]:
    if not latest_version:
        return "remote_version_unavailable", False
    if not local_version:
        return "local_version_unknown", False
    local_text = str(local_version).strip().lower()
    latest_text = str(latest_version).strip().lower()
    if local_text == latest_text:
        return "up_to_date", False
    if not _version_parts(local_version) or not _version_parts(latest_version):
        return "version_differs", False
    comparison = compare_versions(local_version, latest_version)
    if comparison == 0:
        return "up_to_date", False
    if comparison < 0:
        return "update_available", True
    return "version_differs", False


def check_game_update(game, db):
    """Refresh a linked game's remote version and persist an explicit update state."""
    source_type = str(game.source_type or "unknown").strip().lower()
    game.update_checked_at = datetime.utcnow()
    game.update_check_error = None

    if source_type not in SUPPORTED_UPDATE_SOURCES or not game.source_url:
        game.update_status = "unsupported_source"
        game.update_available = False
        game.update_check_error = "Link a supported source before checking for updates."
        db.add(game)
        db.commit()
        db.refresh(game)
        return game

    try:
        from backend.scraper import fetch_source_metadata

        data = fetch_source_metadata(game.source_type, game.source_url, game.source_id) or {}
        latest = str(data.get("latest_version") or "").strip() or game.latest_version
        game.latest_version = latest or None
        game.update_status, game.update_available = derive_update_status(game.local_version, game.latest_version)
        if game.update_status == "remote_version_unavailable":
            game.update_check_error = "The linked source did not report a version."
    except Exception as exc:
        game.update_status = "check_failed"
        game.update_available = False
        game.update_check_error = str(exc) or "The linked source could not be checked."

    db.add(game)
    db.commit()
    db.refresh(game)
    return game
