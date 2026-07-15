import json
import os
import re
import shutil
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterable


EXPORT_SCHEMA_VERSION = 1
MANIFEST_FILENAME = "manifest.json"
LIBRARY_ARCHIVE_ROOT = "library"


def _get_value(obj: Any, key: str, default: Any = None) -> Any:
    if isinstance(obj, dict):
        return obj.get(key, default)
    return getattr(obj, key, default)


def _to_iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, str):
        return value
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value)


def _normalize_export_path(export_path: str | os.PathLike[str]) -> Path:
    path = Path(export_path).expanduser()
    if path.suffix.lower() != ".zip":
        path = path.with_suffix(path.suffix + ".zip") if path.suffix else path.with_suffix(".zip")
    return path


def _serialize_sources(sources: Iterable[Any]) -> list[dict[str, Any]]:
    serialized = []
    for source in list(sources or []):
        if hasattr(source, "to_dict"):
            serialized.append(source.to_dict())
            continue
        serialized.append(
            {
                "source_type": _get_value(source, "source_type"),
                "source_url": _get_value(source, "source_url"),
                "source_id": _get_value(source, "source_id"),
                "title_reported": _get_value(source, "title_reported"),
                "version_reported": _get_value(source, "version_reported"),
                "is_preferred": bool(_get_value(source, "is_preferred", False)),
                "added_at": _to_iso(_get_value(source, "added_at")),
            }
        )
    return serialized


def _serialize_simple_list(items: Iterable[Any], key: str) -> list[Any]:
    values = []
    for item in list(items or []):
        value = _get_value(item, key)
        if value:
            values.append(value)
    return values


def make_relative_library_path(games_root: str | os.PathLike[str], folder_path: str | None) -> str | None:
    if not folder_path:
        return None

    folder_str = str(folder_path).strip()
    if not folder_str or folder_str.lower().startswith("wishlist_"):
        return None

    root = Path(games_root).expanduser().resolve()
    candidate = Path(folder_str).expanduser()
    try:
        candidate = candidate.resolve()
    except Exception:
        candidate = candidate.absolute()

    try:
        relative = candidate.relative_to(root)
    except Exception:
        return None

    return relative.as_posix()


def serialize_game_record(game: Any, games_root: str | os.PathLike[str]) -> dict[str, Any]:
    file_type = str(_get_value(game, "file_type", "folder") or "folder")
    relative_path = None if file_type == "wishlist" else make_relative_library_path(games_root, _get_value(game, "folder_path"))

    journal_entries = []
    for entry in list(_get_value(game, "journal_entries", []) or []):
        journal_entries.append(
            {
                "text": _get_value(entry, "entry_text", ""),
                "created_at": _to_iso(_get_value(entry, "created_at")),
            }
        )

    screenshots = []
    for screenshot in list(_get_value(game, "screenshots", []) or []):
        url = _get_value(screenshot, "url")
        if url:
            screenshots.append(url)

    return {
        "title": _get_value(game, "title"),
        "raw_name": _get_value(game, "raw_name"),
        "category": _get_value(game, "category"),
        "folder_path": _get_value(game, "folder_path"),
        "relative_path": relative_path,
        "included_in_export": relative_path is not None and file_type != "wishlist",
        "file_type": file_type,
        "archive_name": _get_value(game, "archive_name"),
        "size_bytes": int(_get_value(game, "size_bytes", 0) or 0),
        "source_type": _get_value(game, "source_type", "unknown"),
        "source_url": _get_value(game, "source_url"),
        "source_id": _get_value(game, "source_id"),
        "is_identified": bool(_get_value(game, "is_identified", False)),
        "local_version": _get_value(game, "local_version"),
        "latest_version": _get_value(game, "latest_version"),
        "update_available": bool(_get_value(game, "update_available", False)),
        "last_update_check_at": _to_iso(_get_value(game, "last_update_check_at")),
        "last_update_check_status": _get_value(game, "last_update_check_status", "never") or "never",
        "last_update_check_error": _get_value(game, "last_update_check_error"),
        "update_detected_at": _to_iso(_get_value(game, "update_detected_at")),
        "local_version_is_manual": bool(_get_value(game, "local_version_is_manual", False)),
        "title_is_manual": bool(_get_value(game, "title_is_manual", False)),
        "rating": _get_value(game, "rating"),
        "developer": _get_value(game, "developer"),
        "release_date": _get_value(game, "release_date"),
        "cover_url": _get_value(game, "cover_url"),
        "description": _get_value(game, "description"),
        "playing_progress": _get_value(game, "playing_progress", "unplayed"),
        "user_score": _get_value(game, "user_score"),
        "is_ignored": bool(_get_value(game, "is_ignored", False)),
        "total_playtime_seconds": int(_get_value(game, "total_playtime_seconds", 0) or 0),
        "play_session_count": int(_get_value(game, "play_session_count", 0) or 0),
        "added_at": _to_iso(_get_value(game, "added_at")),
        "last_played": _to_iso(_get_value(game, "last_played")),
        "last_seen_at": _to_iso(_get_value(game, "last_seen_at")),
        "screenshots": screenshots,
        "tags": _serialize_simple_list(_get_value(game, "tags", []), "tag_name"),
        "custom_tags": _serialize_simple_list(_get_value(game, "custom_tags", []), "tag_name"),
        "journal_entries": journal_entries,
        "sources": _serialize_sources(_get_value(game, "sources", [])),
    }


def build_export_manifest(
    games_root: str | os.PathLike[str],
    games: Iterable[Any],
    settings: dict[str, Any] | None,
    source_map: dict[str, Any] | None = None,
) -> dict[str, Any]:
    root = Path(games_root).expanduser().resolve()
    game_records = [serialize_game_record(game, root) for game in list(games or [])]
    excluded_records = sum(1 for record in game_records if record["file_type"] != "wishlist" and not record["included_in_export"])

    portable_settings = dict(settings or {})
    configured_roots = []
    seen_roots = set()

    def add_root(root_candidate: Any) -> None:
        raw = str(root_candidate or "").strip()
        if not raw:
            return
        try:
            normalized = str(Path(raw).expanduser().resolve())
        except Exception:
            normalized = str(Path(raw).expanduser())
        key = normalized.lower()
        if key in seen_roots:
            return
        seen_roots.add(key)
        configured_roots.append(normalized)

    add_root(root)
    for candidate in list(portable_settings.get("games_dirs") or []):
        add_root(candidate)
    add_root(portable_settings.get("games_dir"))

    portable_settings.pop("games_dir", None)
    portable_settings.pop("games_dirs", None)
    portable_settings.pop("extension_dir", None)

    return {
        "format": "xdir-library-export",
        "schema_version": EXPORT_SCHEMA_VERSION,
        "exported_at": datetime.now(timezone.utc).isoformat(),
        "library_root_name": root.name,
        "library_root_exists": root.exists(),
        "configured_roots": configured_roots,
        "settings": portable_settings,
        "games": game_records,
        "source_map": source_map or {"version": 1, "entries": []},
        "stats": {
            "game_count": len(game_records),
            "local_entry_count": sum(1 for record in game_records if record["file_type"] != "wishlist"),
            "wishlist_count": sum(1 for record in game_records if record["file_type"] == "wishlist"),
            "excluded_local_records": excluded_records,
        },
    }


def _iter_library_members(games_root: Path) -> list[Path]:
    if not games_root.exists():
        return []

    members: list[Path] = []
    for current_root, dir_names, file_names in os.walk(games_root):
        current_path = Path(current_root)
        for dir_name in sorted(dir_names):
            members.append(current_path / dir_name)
        for file_name in sorted(file_names):
            members.append(current_path / file_name)
    members.sort(key=lambda path: (0 if path.is_dir() else 1, path.as_posix().lower()))
    return members


def write_export_bundle(
    export_path: str | os.PathLike[str],
    games_root: str | os.PathLike[str],
    manifest: dict[str, Any],
    progress_callback: Callable[[int, int, str, str], None] | None = None,
) -> Path:
    bundle_path = _normalize_export_path(export_path)
    bundle_path.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(bundle_path, "w", compression=zipfile.ZIP_DEFLATED, allowZip64=True) as bundle:
        bundle.writestr(MANIFEST_FILENAME, json.dumps(manifest, indent=2, ensure_ascii=False))
        if progress_callback:
            progress_callback(1, 1, MANIFEST_FILENAME, "Writing portable library metadata manifest...")

    return bundle_path

def load_export_bundle_manifest(export_path: str | os.PathLike[str]) -> dict[str, Any]:
    with zipfile.ZipFile(export_path, "r") as bundle:
        try:
            with bundle.open(MANIFEST_FILENAME, "r") as manifest_file:
                return json.load(manifest_file)
        except KeyError as exc:
            raise ValueError("Portable library export is missing manifest.json") from exc


def resolve_import_destination(games_root: str | os.PathLike[str], relative_path: str) -> Path:
    if not relative_path or not str(relative_path).strip():
        raise ValueError("Portable import path is empty")

    normalized = str(relative_path).replace("\\", "/").strip("/")
    if re.match(r"^[a-zA-Z]:/", normalized):
        raise ValueError("Portable import path must stay relative to the library root")

    relative = PurePosixPath(normalized)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("Portable import path escapes the configured library root")

    root = Path(games_root).expanduser().resolve()
    destination = (root / Path(*relative.parts)).resolve()
    if destination != root and root not in destination.parents:
        raise ValueError("Portable import path escapes the configured library root")
    return destination


def extract_export_bundle(
    export_path: str | os.PathLike[str],
    games_root: str | os.PathLike[str],
    progress_callback: Callable[[int, int, str, str], None] | None = None,
) -> dict[str, int]:
    root = Path(games_root).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    extracted_files = 0
    skipped_files = 0
    created_dirs = 0

    with zipfile.ZipFile(export_path, "r") as bundle:
        members = [
            info
            for info in bundle.infolist()
            if info.filename.startswith(f"{LIBRARY_ARCHIVE_ROOT}/") and info.filename != f"{LIBRARY_ARCHIVE_ROOT}/"
        ]
        total = len(members) or 1

        for index, member in enumerate(members, start=1):
            relative_name = member.filename[len(f"{LIBRARY_ARCHIVE_ROOT}/") :].rstrip("/")
            if not relative_name:
                continue

            destination = resolve_import_destination(root, relative_name)
            if member.is_dir():
                destination.mkdir(parents=True, exist_ok=True)
                created_dirs += 1
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    skipped_files += 1
                else:
                    with bundle.open(member, "r") as source_stream, open(destination, "wb") as target_stream:
                        shutil.copyfileobj(source_stream, target_stream)
                    extracted_files += 1

            if progress_callback:
                progress_callback(index, total, relative_name, "Restoring library files into the configured directory...")

    return {
        "extracted_files": extracted_files,
        "skipped_files": skipped_files,
        "created_dirs": created_dirs,
    }


def needs_metadata_refresh(record: dict[str, Any]) -> bool:
    source_type = str(record.get("source_type") or "unknown").lower()
    has_link = bool(record.get("source_url") or record.get("source_id"))
    if source_type == "unknown" or not has_link:
        return False

    developer = str(record.get("developer") or "").strip().lower()
    return any(
        (
            not record.get("cover_url"),
            not list(record.get("screenshots") or []),
            not record.get("description"),
            developer in ("", "unknown", "unknown dev", "unknown dev / circle"),
        )
    )
