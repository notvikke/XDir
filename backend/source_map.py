import json
import os
import re
from datetime import datetime

from backend.database import CustomTag, Game, JournalEntry, Screenshot, Tag, GameSource
from backend.runtime import get_data_root

SOURCE_MAP_PATH = os.path.join(get_data_root(), "source-map.json")


def _normalize_text(value: str) -> str:
    value = re.sub(r"[\'\"`]", "", value or "")
    value = re.sub(r"[^a-zA-Z0-9]", " ", value)
    return " ".join(value.split()).lower()


def _load_source_map() -> dict:
    if not os.path.exists(SOURCE_MAP_PATH):
        return {"version": 1, "entries": []}
    try:
        with open(SOURCE_MAP_PATH, "r", encoding="utf-8") as handle:
            data = json.load(handle)
        if isinstance(data, dict) and isinstance(data.get("entries"), list):
            return data
    except Exception:
        pass
    return {"version": 1, "entries": []}


def _save_source_map(data: dict) -> None:
    os.makedirs(os.path.dirname(SOURCE_MAP_PATH), exist_ok=True)
    with open(SOURCE_MAP_PATH, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2, ensure_ascii=False)


def load_source_map_data() -> dict:
    return _load_source_map()


def save_source_map_data(data: dict) -> None:
    _save_source_map(data)


def _snapshot_from_game(game: Game) -> dict:
    return {
        "folder_path": game.folder_path,
        "raw_name": game.raw_name,
        "title": game.title,
        "category": game.category,
        "file_type": game.file_type,
        "archive_name": game.archive_name,
        "source_type": game.source_type,
        "source_url": game.source_url,
        "source_id": game.source_id,
        "is_identified": bool(game.is_identified),
        "developer": game.developer,
        "cover_url": game.cover_url,
        "rating": game.rating,
        "local_version": game.local_version,
        "latest_version": game.latest_version,
        "update_available": bool(game.update_available),
        "last_update_check_at": game.last_update_check_at.isoformat() if game.last_update_check_at else None,
        "last_update_check_status": "never" if game.last_update_check_status == "checking" else (game.last_update_check_status or "never"),
        "last_update_check_error": game.last_update_check_error,
        "update_detected_at": game.update_detected_at.isoformat() if game.update_detected_at else None,
        "local_version_is_manual": bool(game.local_version_is_manual),
        "title_is_manual": bool(game.title_is_manual),
        "release_date": game.release_date,
        "description": game.description,
        "playing_progress": game.playing_progress,
        "user_score": game.user_score,
        "is_ignored": bool(game.is_ignored),
        "total_playtime_seconds": game.total_playtime_seconds or 0,
        "play_session_count": game.play_session_count or 0,
        "last_played": game.last_played.isoformat() if game.last_played else None,
        "screenshots": [s.url for s in game.screenshots],
        "tags": [t.tag_name for t in game.tags],
        "custom_tags": [t.tag_name for t in game.custom_tags],
        "journal_entries": [j.entry_text for j in game.journal_entries],
        "sources": [s.to_dict() for s in game.sources],
        "updated_at": datetime.utcnow().isoformat(),
    }


def _snapshot_matches(entry: dict, game: Game) -> bool:
    entry_folder = (entry.get("folder_path") or "").strip().lower()
    game_folder = (game.folder_path or "").strip().lower()
    if entry_folder and game_folder and entry_folder == game_folder:
        return True

    entry_source_type = (entry.get("source_type") or "unknown").lower()
    entry_source_url = (entry.get("source_url") or "").strip().lower()
    game_source_type = (game.source_type or "unknown").lower()
    game_source_url = (game.source_url or "").strip().lower()
    if entry_source_type != "unknown" and entry_source_url and entry_source_type == game_source_type and entry_source_url == game_source_url:
        return True

    entry_source_id = (entry.get("source_id") or "").strip().lower()
    game_source_id = (game.source_id or "").strip().lower()
    if entry_source_type != "unknown" and entry_source_id and entry_source_type == game_source_type and entry_source_id == game_source_id:
        return True

    return False


def persist_game_snapshot(game: Game) -> None:
    source_map = _load_source_map()
    entries = source_map["entries"]
    snapshot = _snapshot_from_game(game)

    for index, entry in enumerate(entries):
        if _snapshot_matches(entry, game):
            entries[index] = snapshot
            _save_source_map(source_map)
            return

    entries.append(snapshot)
    _save_source_map(source_map)


def remove_game_snapshot(game: Game) -> None:
    source_map = _load_source_map()
    filtered_entries = [entry for entry in source_map["entries"] if not _snapshot_matches(entry, game)]
    if len(filtered_entries) == len(source_map["entries"]):
        return
    source_map["entries"] = filtered_entries
    _save_source_map(source_map)


def clear_metadata_from_all_snapshots() -> int:
    source_map = _load_source_map()
    cleared = 0

    for entry in source_map["entries"]:
        had_metadata = any(
            entry.get(field)
            for field in ("developer", "cover_url", "rating", "latest_version", "release_date", "description")
        ) or bool(entry.get("screenshots")) or bool(entry.get("tags"))

        entry["developer"] = None
        entry["cover_url"] = None
        entry["rating"] = None
        entry["latest_version"] = None
        entry["update_available"] = False
        entry["last_update_check_status"] = "never"
        entry["last_update_check_error"] = None
        entry["update_detected_at"] = None
        entry["release_date"] = None
        entry["description"] = None
        entry["screenshots"] = []
        entry["tags"] = []

        if had_metadata:
            entry["updated_at"] = datetime.utcnow().isoformat()
            cleared += 1

    if cleared > 0:
        _save_source_map(source_map)

    return cleared


def _entries_match(existing: dict, incoming: dict) -> bool:
    existing_folder = (existing.get("folder_path") or "").strip().lower()
    incoming_folder = (incoming.get("folder_path") or "").strip().lower()
    if existing_folder and incoming_folder and existing_folder == incoming_folder:
        return True

    existing_source_type = (existing.get("source_type") or "unknown").lower()
    incoming_source_type = (incoming.get("source_type") or "unknown").lower()
    existing_source_url = (existing.get("source_url") or "").strip().lower()
    incoming_source_url = (incoming.get("source_url") or "").strip().lower()
    if existing_source_type != "unknown" and existing_source_type == incoming_source_type and existing_source_url and existing_source_url == incoming_source_url:
        return True

    existing_source_id = (existing.get("source_id") or "").strip().lower()
    incoming_source_id = (incoming.get("source_id") or "").strip().lower()
    if existing_source_type != "unknown" and existing_source_type == incoming_source_type and existing_source_id and existing_source_id == incoming_source_id:
        return True

    existing_raw = _normalize_text(existing.get("raw_name") or "")
    incoming_raw = _normalize_text(incoming.get("raw_name") or "")
    if existing_raw and incoming_raw and existing_raw == incoming_raw:
        return True

    existing_title = _normalize_text(existing.get("title") or "")
    incoming_title = _normalize_text(incoming.get("title") or "")
    return bool(existing_title and incoming_title and existing_title == incoming_title)


def _merge_snapshot_entry(existing: dict, incoming: dict) -> dict:
    merged = dict(existing)
    for key, value in incoming.items():
        if key in ("screenshots", "tags", "custom_tags", "journal_entries", "sources"):
            current_values = list(merged.get(key) or [])
            for item in list(value or []):
                if item not in current_values:
                    current_values.append(item)
            merged[key] = current_values
            continue

        if value not in (None, "", []):
            merged[key] = value
        elif key not in merged:
            merged[key] = value

    return merged


def merge_source_map_data(imported_data: dict | None) -> int:
    if not imported_data or not isinstance(imported_data.get("entries"), list):
        return 0

    current = _load_source_map()
    entries = current.get("entries", [])
    merged_count = 0

    for incoming in imported_data.get("entries", []):
        if not isinstance(incoming, dict):
            continue

        matched = False
        for index, existing in enumerate(entries):
            if _entries_match(existing, incoming):
                entries[index] = _merge_snapshot_entry(existing, incoming)
                merged_count += 1
                matched = True
                break

        if not matched:
            entries.append(incoming)
            merged_count += 1

    current["version"] = max(int(current.get("version") or 1), int(imported_data.get("version") or 1))
    current["entries"] = entries
    if merged_count > 0:
        _save_source_map(current)
    return merged_count


def find_source_map_entry(folder_path: str, raw_name: str, title: str = "") -> dict | None:
    source_map = _load_source_map()
    exact_folder = (folder_path or "").strip().lower()
    exact_raw = (raw_name or "").strip().lower()
    normalized_raw = _normalize_text(raw_name or "")
    normalized_title = _normalize_text(title or "")

    for entry in source_map["entries"]:
        entry_folder = (entry.get("folder_path") or "").strip().lower()
        if exact_folder and entry_folder == exact_folder:
            return entry

    for entry in source_map["entries"]:
        entry_raw = (entry.get("raw_name") or "").strip().lower()
        if exact_raw and entry_raw == exact_raw:
            return entry

    for entry in source_map["entries"]:
        entry_raw = _normalize_text(entry.get("raw_name") or "")
        entry_title = _normalize_text(entry.get("title") or "")
        if normalized_raw and (entry_raw == normalized_raw or entry_title == normalized_raw):
            return entry
        if normalized_title and (entry_raw == normalized_title or entry_title == normalized_title):
            return entry

    return None


def hydrate_game_from_source_snapshot(game: Game, source_snapshot: dict) -> None:
    if not source_snapshot:
        return

    if source_snapshot.get("title"):
        game.title = source_snapshot["title"]
    if source_snapshot.get("archive_name") and not game.archive_name:
        game.archive_name = source_snapshot["archive_name"]
    if source_snapshot.get("source_url") and not game.source_url:
        game.source_url = source_snapshot["source_url"]
    if source_snapshot.get("source_id") and not game.source_id:
        game.source_id = source_snapshot["source_id"]
    if source_snapshot.get("source_type") and (not game.source_type or game.source_type == "unknown"):
        game.source_type = source_snapshot["source_type"]
    if source_snapshot.get("is_identified"):
        game.is_identified = True
    if source_snapshot.get("playing_progress") and (not getattr(game, "playing_progress", None) or getattr(game, "playing_progress", "unplayed") == "unplayed"):
        game.playing_progress = source_snapshot["playing_progress"]
    if source_snapshot.get("user_score") and not getattr(game, "user_score", None):
        game.user_score = source_snapshot["user_score"]
    if source_snapshot.get("is_ignored") and not getattr(game, "is_ignored", False):
        game.is_ignored = bool(source_snapshot["is_ignored"])
    game.total_playtime_seconds = max(int(getattr(game, "total_playtime_seconds", 0) or 0), int(source_snapshot.get("total_playtime_seconds") or 0))
    game.play_session_count = max(int(getattr(game, "play_session_count", 0) or 0), int(source_snapshot.get("play_session_count") or 0))
    if source_snapshot.get("last_played") and not getattr(game, "last_played", None):
        try:
            game.last_played = datetime.fromisoformat(source_snapshot["last_played"])
        except Exception:
            pass

    if source_snapshot.get("local_version_is_manual"):
        game.local_version_is_manual = True
        game.local_version = source_snapshot.get("local_version")
    elif not getattr(game, "local_version", None) and source_snapshot.get("local_version"):
        game.local_version = source_snapshot["local_version"]

    if source_snapshot.get("title_is_manual"):
        game.title_is_manual = True
        if source_snapshot.get("title"):
            game.title = source_snapshot["title"]

    game.update_available = bool(source_snapshot.get("update_available", getattr(game, "update_available", False)))
    restored_status = source_snapshot.get("last_update_check_status") or getattr(game, "last_update_check_status", None) or "never"
    game.last_update_check_status = "never" if restored_status == "checking" else restored_status
    game.last_update_check_error = source_snapshot.get("last_update_check_error")
    for field in ("last_update_check_at", "update_detected_at"):
        if source_snapshot.get(field) and not getattr(game, field, None):
            try:
                setattr(game, field, datetime.fromisoformat(source_snapshot[field]))
            except Exception:
                pass

    for field in ("developer", "cover_url", "rating", "latest_version", "release_date", "description"):
        if not getattr(game, field) and source_snapshot.get(field):
            setattr(game, field, source_snapshot[field])

    existing_screenshots = {s.url for s in game.screenshots}
    for screenshot_url in source_snapshot.get("screenshots", []):
        if screenshot_url and screenshot_url not in existing_screenshots:
            game.screenshots.append(Screenshot(url=screenshot_url))
            existing_screenshots.add(screenshot_url)

    existing_tags = {t.tag_name for t in game.tags}
    for tag_name in source_snapshot.get("tags", []):
        if tag_name and tag_name not in existing_tags:
            game.tags.append(Tag(tag_name=tag_name))
            existing_tags.add(tag_name)

    existing_custom_tags = {t.tag_name for t in game.custom_tags}
    for tag_name in source_snapshot.get("custom_tags", []):
        if tag_name and tag_name not in existing_custom_tags:
            game.custom_tags.append(CustomTag(tag_name=tag_name))
            existing_custom_tags.add(tag_name)

    existing_journal_entries = {j.entry_text for j in game.journal_entries}
    for entry_text in source_snapshot.get("journal_entries", []):
        if entry_text and entry_text not in existing_journal_entries:
            game.journal_entries.append(JournalEntry(entry_text=entry_text))
            existing_journal_entries.add(entry_text)

    existing_sources = {(s.source_type, s.source_url) for s in game.sources}
    for src_data in source_snapshot.get("sources", []):
        st = src_data.get("source_type")
        su = src_data.get("source_url")
        if st and su and (st, su) not in existing_sources:
            game.sources.append(GameSource(
                source_type=st,
                source_url=su,
                source_id=src_data.get("source_id"),
                title_reported=src_data.get("title_reported"),
                version_reported=src_data.get("version_reported"),
                is_preferred=src_data.get("is_preferred", False)
            ))
            existing_sources.add((st, su))
