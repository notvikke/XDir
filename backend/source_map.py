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
        "latest_version": game.latest_version,
        "release_date": game.release_date,
        "description": game.description,
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
