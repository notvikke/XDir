import os
import subprocess
import zipfile
from datetime import datetime
from threading import Lock, Thread
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Depends, HTTPException, Query, Body, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from pathlib import Path

from backend.database import get_db, init_db, Game, Screenshot, Tag, CustomTag, JournalEntry, GameSource, SessionLocal
from backend.scanner import inspect_archive, scan_single_game_path
from backend.ingest import run_ingestion, determine_source_info, merge_game_records, cleanup_redundant_wishlist_entries, deduplicate_games, apply_scanned_local_version
from backend.config import get_settings, save_settings, get_games_dir, get_games_dirs, is_path_within_games_dirs
from backend.library_portability import (
    build_export_manifest,
    extract_export_bundle,
    load_export_bundle_manifest,
    needs_metadata_refresh,
    resolve_import_destination,
    write_export_bundle,
)
from backend.runtime import get_app_root, get_bundle_root
from backend.source_map import persist_game_snapshot
from backend.source_map import (
    remove_game_snapshot,
    SOURCE_MAP_PATH,
    clear_metadata_from_all_snapshots,
    load_source_map_data,
    merge_source_map_data,
)
from backend.job_progress import (
    any_running_job,
    cancel_job,
    fail_job,
    finish_job,
    get_job,
    is_job_cancel_requested,
    request_job_cancel,
    remove_job_result_item,
    set_job_context,
    start_job,
    update_job,
)
from backend.launching import accumulate_playtime, choose_launch_executable
from backend.versioning import (
    apply_comparison_to_game,
    check_game_update,
    check_library_updates,
    has_usable_linked_source,
    resolve_update_source,
    utc_now,
)

app = FastAPI(title="XDir API", version="0.2.0")
APP_ROOT = get_app_root()
BUNDLE_ROOT = get_bundle_root()
EXTENSION_DIR = os.path.join(BUNDLE_ROOT, "extension")
FRONTEND_DIR = os.path.join(BUNDLE_ROOT, "frontend")
EXPORT_LIBRARY_JOB_KEY = "export-library"
IMPORT_LIBRARY_JOB_KEY = "import-library"
UPDATE_CHECK_JOB_KEY = "update-check"
REFRESH_ALL_METADATA_JOB_KEY = "refresh-all-metadata"
ACTIVE_PLAY_SESSIONS: dict[str, dict[str, Any]] = {}
ACTIVE_PLAY_SESSIONS_LOCK = Lock()
ACTIVE_UPDATE_CHECK_GAME_IDS: set[int] = set()
ACTIVE_UPDATE_CHECK_GAMES_LOCK = Lock()
UPDATE_CHECK_JOB_START_LOCK = Lock()

TRUSTED_LOCAL_ORIGINS = [
    "http://127.0.0.1:8765",
    "http://localhost:8765",
]
TRUSTED_EXTENSION_ORIGIN_REGEX = r"^(chrome-extension|moz-extension|edge-extension)://.*$"

app.add_middleware(
    CORSMiddleware,
    allow_origins=TRUSTED_LOCAL_ORIGINS,
    allow_origin_regex=TRUSTED_EXTENSION_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def enforce_trusted_local_api_origin(request: Request, call_next):
    if request.url.path.startswith("/api/"):
        origin = request.headers.get("origin", "")
        if origin:
            if origin not in TRUSTED_LOCAL_ORIGINS and not (
                origin.startswith("chrome-extension://")
                or origin.startswith("moz-extension://")
                or origin.startswith("edge-extension://")
            ):
                return JSONResponse(status_code=403, content={"detail": "Forbidden origin"})
    return await call_next(request)

@app.on_event("startup")
def on_startup():
    init_db()
    if not os.path.exists(SOURCE_MAP_PATH):
        snapshot_db = SessionLocal()
        try:
            for game in snapshot_db.query(Game).all():
                persist_game_snapshot(game)
        finally:
            snapshot_db.close()


def persist_snapshot(game: Game, db: Session | None = None) -> None:
    try:
        if db is not None:
            db.refresh(game)
    except Exception:
        pass
    try:
        persist_game_snapshot(game)
    except Exception:
        pass


def visible_library_entry_clause():
    return or_(
        Game.file_type == "wishlist",
        Game.missing_scan_count == 0,
        Game.missing_scan_count.is_(None),
    )


def _register_active_play_session(session_key: str, payload: dict[str, Any]) -> None:
    with ACTIVE_PLAY_SESSIONS_LOCK:
        ACTIVE_PLAY_SESSIONS[session_key] = payload


def _unregister_active_play_session(session_key: str) -> None:
    with ACTIVE_PLAY_SESSIONS_LOCK:
        ACTIVE_PLAY_SESSIONS.pop(session_key, None)


def count_active_play_sessions(game_id: int) -> int:
    with ACTIVE_PLAY_SESSIONS_LOCK:
        return sum(1 for session in ACTIVE_PLAY_SESSIONS.values() if session.get("game_id") == game_id)


def launch_tracked_game_process(game: Game, exe_path: str, db: Session) -> dict[str, Any]:
    started_at = datetime.utcnow()
    process = subprocess.Popen([exe_path], cwd=os.path.dirname(exe_path))
    session_key = f"{game.id}:{process.pid}:{int(started_at.timestamp())}"

    game.last_played = started_at
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)

    _register_active_play_session(
        session_key,
        {
            "game_id": game.id,
            "pid": process.pid,
            "started_at": started_at,
            "exe_path": exe_path,
        },
    )

    def _monitor_session():
        try:
            process.wait()
            ended_at = datetime.utcnow()
            bg_db = SessionLocal()
            try:
                tracked_game = bg_db.query(Game).filter(Game.id == game.id).first()
                if not tracked_game:
                    return

                total_playtime_seconds, play_session_count, last_played = accumulate_playtime(
                    tracked_game.total_playtime_seconds,
                    tracked_game.play_session_count,
                    started_at,
                    ended_at,
                )
                tracked_game.total_playtime_seconds = total_playtime_seconds
                tracked_game.play_session_count = play_session_count
                tracked_game.last_played = last_played
                bg_db.commit()
                bg_db.refresh(tracked_game)
                persist_snapshot(tracked_game, bg_db)
            except Exception:
                bg_db.rollback()
            finally:
                bg_db.close()
        finally:
            _unregister_active_play_session(session_key)

    Thread(target=_monitor_session, daemon=True).start()

    payload = game.to_dict()
    payload["is_running"] = True
    payload["active_play_session_count"] = count_active_play_sessions(game.id)
    return {
        "message": f"Launched game: {os.path.basename(exe_path)}",
        "action": "launch",
        "tracking_enabled": True,
        "game": payload,
    }


def open_game_folder_location(game: Game) -> dict[str, Any]:
    path = os.path.normpath(game.folder_path)
    if not os.path.exists(path):
        raise HTTPException(status_code=400, detail=f"Path does not exist: {path}")

    if game.file_type == "archive" or (os.path.isfile(path) and path.lower().endswith(".exe")):
        subprocess.Popen([r'explorer', '/select,', path])
        return {"message": "Opened containing folder in Explorer", "action": "explorer"}

    if os.path.isdir(path):
        subprocess.Popen([r'explorer', path])
        return {"message": "Opened folder in Explorer", "action": "explorer"}

    subprocess.Popen([r'explorer', os.path.dirname(path)])
    return {"message": "Opened containing folder in Explorer", "action": "explorer"}


def parse_datetime_value(value: Any) -> datetime | None:
    if not value or not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is not None:
            return parsed.astimezone().replace(tzinfo=None)
        return parsed
    except Exception:
        return None


def count_library_export_work_units(games_root: Path) -> int:
    if not games_root.exists() or not games_root.is_dir():
        return 1

    total = 1
    for _, dir_names, file_names in os.walk(games_root):
        total += len(dir_names) + len(file_names)
    return max(1, total)


def count_library_import_work_units(import_path: Path) -> int:
    manifest = load_export_bundle_manifest(import_path)
    with zipfile.ZipFile(import_path, "r") as bundle:
        member_count = sum(
            1
            for info in bundle.infolist()
            if info.filename.startswith("library/") and info.filename != "library/"
        )
    return max(1, member_count + len(manifest.get("games", [])))


def find_game_for_import_record(db: Session, record: dict[str, Any], destination_path: Path | None = None) -> Game | None:
    if destination_path is not None:
        game = db.query(Game).filter(Game.folder_path == str(destination_path)).first()
        if game:
            return game

    source_id = record.get("source_id")
    if source_id:
        game = db.query(Game).filter(Game.source_id == source_id).first()
        if game:
            return game

    source_url = record.get("source_url")
    if source_url:
        game = db.query(Game).filter(Game.source_url == source_url).first()
        if game:
            return game

    raw_name = record.get("raw_name")
    if raw_name:
        game = db.query(Game).filter(Game.raw_name == raw_name).first()
        if game:
            return game

    title = record.get("title")
    if title:
        return db.query(Game).filter(Game.file_type == "wishlist", Game.title == title).first()

    return None


def sync_game_sources(game: Game, sources: list[dict[str, Any]] | None) -> None:
    imported_sources = [source for source in list(sources or []) if source.get("source_type") and source.get("source_url")]
    if not imported_sources:
        return

    existing_by_key = {(source.source_type, source.source_url): source for source in game.sources}
    preferred_keys = {
        (source.get("source_type"), source.get("source_url"))
        for source in imported_sources
        if source.get("is_preferred")
    }

    if preferred_keys:
        for existing in game.sources:
            existing.is_preferred = (existing.source_type, existing.source_url) in preferred_keys

    for source_data in imported_sources:
        key = (source_data.get("source_type"), source_data.get("source_url"))
        existing = existing_by_key.get(key)
        if existing:
            if source_data.get("source_id") and not existing.source_id:
                existing.source_id = source_data["source_id"]
            if source_data.get("title_reported") and not existing.title_reported:
                existing.title_reported = source_data["title_reported"]
            if source_data.get("version_reported") and not existing.version_reported:
                existing.version_reported = source_data["version_reported"]
            existing.is_preferred = bool(source_data.get("is_preferred", existing.is_preferred))
            continue

        game.sources.append(
            GameSource(
                source_type=source_data["source_type"],
                source_url=source_data["source_url"],
                source_id=source_data.get("source_id"),
                title_reported=source_data.get("title_reported"),
                version_reported=source_data.get("version_reported"),
                is_preferred=bool(source_data.get("is_preferred", False)),
            )
        )


def sync_game_screenshots(game: Game, db: Session, screenshot_urls: list[str] | None) -> None:
    existing_urls = {screenshot.url for screenshot in game.screenshots}
    for screenshot_url in list(screenshot_urls or []):
        if screenshot_url and screenshot_url not in existing_urls:
            game.screenshots.append(Screenshot(url=screenshot_url))
            existing_urls.add(screenshot_url)


def sync_game_tags(game: Game, tag_names: list[str] | None) -> None:
    existing_names = {tag.tag_name for tag in game.tags}
    for tag_name in list(tag_names or []):
        if tag_name and tag_name not in existing_names:
            game.tags.append(Tag(tag_name=tag_name))
            existing_names.add(tag_name)


def sync_game_custom_tags(game: Game, tag_names: list[str] | None) -> None:
    existing_names = {tag.tag_name for tag in game.custom_tags}
    for tag_name in list(tag_names or []):
        if tag_name and tag_name not in existing_names:
            game.custom_tags.append(CustomTag(tag_name=tag_name))
            existing_names.add(tag_name)


def sync_game_journal_entries(game: Game, entries: list[dict[str, Any] | str] | None) -> None:
    existing_entries = {entry.entry_text for entry in game.journal_entries}
    for raw_entry in list(entries or []):
        if isinstance(raw_entry, dict):
            entry_text = str(raw_entry.get("text") or "").strip()
            created_at = parse_datetime_value(raw_entry.get("created_at"))
        else:
            entry_text = str(raw_entry or "").strip()
            created_at = None
        if entry_text and entry_text not in existing_entries:
            game.journal_entries.append(JournalEntry(entry_text=entry_text, created_at=created_at or datetime.utcnow()))
            existing_entries.add(entry_text)


def apply_import_record_to_game(game: Game, record: dict[str, Any], destination_path: Path | None, db: Session) -> None:
    file_type = str(record.get("file_type") or game.file_type or ("wishlist" if destination_path is None else "folder"))
    if destination_path is not None:
        game.folder_path = str(destination_path)
    elif not game.folder_path:
        game.folder_path = str(record.get("folder_path") or record.get("raw_name") or f"wishlist_import_{int(datetime.utcnow().timestamp())}")

    if record.get("title"):
        game.title = record["title"]
    if record.get("title_is_manual"):
        game.title_is_manual = True
    if record.get("raw_name"):
        game.raw_name = record["raw_name"]
    if record.get("category"):
        game.category = record["category"]

    game.file_type = file_type
    game.archive_name = record.get("archive_name")
    if record.get("size_bytes") not in (None, ""):
        game.size_bytes = int(record.get("size_bytes") or 0)

    if record.get("local_version_is_manual"):
        game.local_version_is_manual = True
        game.local_version = record.get("local_version")
    elif record.get("local_version") and not game.local_version_is_manual:
        game.local_version = record["local_version"]
    if record.get("latest_version"):
        game.latest_version = record["latest_version"]
    if record.get("rating"):
        game.rating = record["rating"]
    if record.get("developer"):
        game.developer = record["developer"]
    if record.get("release_date"):
        game.release_date = record["release_date"]
    if record.get("cover_url"):
        game.cover_url = record["cover_url"]
    if record.get("description"):
        game.description = record["description"]
    if record.get("playing_progress"):
        game.playing_progress = record["playing_progress"]
    if record.get("user_score") not in (None, ""):
        game.user_score = record["user_score"]
    if record.get("total_playtime_seconds") not in (None, ""):
        game.total_playtime_seconds = max(int(game.total_playtime_seconds or 0), int(record.get("total_playtime_seconds") or 0))
    if record.get("play_session_count") not in (None, ""):
        game.play_session_count = max(int(game.play_session_count or 0), int(record.get("play_session_count") or 0))

    source_type = record.get("source_type")
    if source_type:
        game.source_type = source_type
    if record.get("source_url"):
        game.source_url = record["source_url"]
    if record.get("source_id"):
        game.source_id = record["source_id"]

    if record.get("is_identified") is not None:
        game.is_identified = bool(record.get("is_identified"))
    elif game.source_type != "unknown" and (game.source_url or game.source_id):
        game.is_identified = True

    game.update_available = bool(record.get("update_available", game.update_available))
    game.last_update_check_status = "never" if record.get("last_update_check_status") == "checking" else (record.get("last_update_check_status") or game.last_update_check_status or "never")
    game.last_update_check_error = record.get("last_update_check_error")
    last_update_check_at = parse_datetime_value(record.get("last_update_check_at"))
    if last_update_check_at:
        game.last_update_check_at = last_update_check_at
    update_detected_at = parse_datetime_value(record.get("update_detected_at"))
    if update_detected_at:
        game.update_detected_at = update_detected_at
    game.is_ignored = bool(record.get("is_ignored", game.is_ignored))
    game.missing_scan_count = 0

    added_at = parse_datetime_value(record.get("added_at"))
    if added_at:
        game.added_at = added_at
    last_played = parse_datetime_value(record.get("last_played"))
    if last_played and (not game.last_played or last_played > game.last_played):
        game.last_played = last_played
    last_seen_at = parse_datetime_value(record.get("last_seen_at"))
    if last_seen_at:
        game.last_seen_at = last_seen_at

    sync_game_sources(game, record.get("sources"))
    sync_game_screenshots(game, db, record.get("screenshots"))
    sync_game_tags(game, record.get("tags"))
    sync_game_custom_tags(game, record.get("custom_tags"))
    sync_game_journal_entries(game, record.get("journal_entries"))

    if file_type != "wishlist":
        cleanup_redundant_wishlist_entries(db, game)

# Pydantic Schemas
class MetadataSyncPayload(BaseModel):
    game_id: Optional[int] = None
    title: Optional[str] = None
    source_url: Optional[str] = None
    source_id: Optional[str] = None
    cover_url: Optional[str] = None
    rating: Optional[str] = None
    latest_version: Optional[str] = None
    developer: Optional[str] = None
    release_date: Optional[str] = None
    description: Optional[str] = None
    screenshots: Optional[List[str]] = []
    tags: Optional[List[str]] = []

class LinkGamePayload(BaseModel):
    source_url: str

class AddSourcePayload(BaseModel):
    source_url: str
    make_preferred: bool = False
    title: Optional[str] = None
    cover_url: Optional[str] = None
    developer: Optional[str] = None
    version: Optional[str] = None


class LibraryMetadataFlushPayload(BaseModel):
    confirmation_phrase: str


class MissingSourceCandidatePayload(BaseModel):
    source_type: str
    source_url: str
    source_id: Optional[str] = None
    title: Optional[str] = None
    creator: Optional[str] = None
    cover: Optional[str] = None
    version: Optional[str] = None


class LibraryExportPayload(BaseModel):
    export_path: str


class LibraryImportPayload(BaseModel):
    import_path: str


def try_apply_source_metadata(
    game: Game,
    db: Session,
    source_type: Optional[str],
    source_url: Optional[str],
    source_id: Optional[str],
    *,
    force_overwrite: bool,
    context_label: str,
) -> Optional[str]:
    try:
        from backend.scraper import fetch_source_metadata, apply_metadata_to_game

        data = fetch_source_metadata(source_type, source_url, source_id)
        if not data:
            return f"No metadata could be loaded from the {context_label} {str(source_type or 'unknown').upper()} source."
        apply_metadata_to_game(game, db, data, force_overwrite=force_overwrite)
        return None
    except Exception as exc:
        return f"Failed to fetch metadata from {str(source_type or 'unknown').upper()}: {exc}"


def clear_game_scraped_metadata(game: Game, db: Session, *, preserve_identification: bool = True) -> None:
    game.cover_url = None
    game.description = None
    game.developer = None
    game.latest_version = None
    game.rating = None
    game.release_date = None
    game.update_available = False
    game.update_detected_at = None
    game.last_update_check_status = "never"
    game.last_update_check_error = None

    if preserve_identification:
        game.is_identified = bool((game.source_url or game.source_id) and (game.source_type or "unknown") != "unknown")
    else:
        game.is_identified = False

    for screenshot in list(game.screenshots):
        db.delete(screenshot)
    for tag in list(game.tags):
        db.delete(tag)

    db.add(game)

class LocalLinkPayload(BaseModel):
    target_game_id: int

class PickedLocalPathPayload(BaseModel):
    selected_path: str

class UpdateGamePayload(BaseModel):
    playing_progress: Optional[str] = None
    user_score: Optional[str] = None
    is_identified: Optional[bool] = None
    title: Optional[str] = None

class GameVersionPayload(BaseModel):
    local_version: Optional[str] = None

class CustomTagPayload(BaseModel):
    tag_name: str

class JournalPayload(BaseModel):
    entry_text: str

class TranslatePayload(BaseModel):
    texts: List[str]

@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    visible_clause = visible_library_entry_clause()
    visible_games = db.query(Game).filter(Game.file_type != "wishlist", Game.is_ignored == False, visible_clause).all()
    total = len(visible_games)
    linked = sum(1 for game in visible_games if has_usable_linked_source(game))
    unlinked = total - linked
    identified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == True, Game.is_ignored == False, visible_clause).count()
    unidentified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == False, Game.is_ignored == False, visible_clause).count()
    installed = db.query(Game).filter(Game.file_type.in_(["exe", "folder"]), Game.is_ignored == False, visible_clause).count()
    archives = db.query(Game).filter(Game.file_type == "archive", Game.is_ignored == False, visible_clause).count()
    wishlist = db.query(Game).filter(Game.file_type == "wishlist", Game.is_ignored == False, visible_clause).count()
    updates_available = db.query(Game).filter(Game.update_available == True, Game.is_ignored == False, visible_clause).count()
    s = get_settings()
    return {
        "total": total,
        "identified": identified,
        "unidentified": unidentified,
        "installed": installed,
        "archives": archives,
        "wishlist": wishlist,
        "updates_available": updates_available,
        "confirmed_updates": updates_available,
        "total_visible_games": total,
        "linked_games": linked,
        "unlinked_games": unlinked,
        "games_with_updates": updates_available,
        "last_full_metadata_refresh": s.get("last_full_metadata_refresh_at"),
        "last_library_update_check": s.get("last_game_update_check_at"),
        "automatic_game_update_checks": s.get("automatic_game_update_checks", True),
        "games_dir": s.get("games_dir", ""),
        "games_dirs": list(s.get("games_dirs", [])),
        "primary_games_dir": s.get("games_dir", ""),
        "extension_dir": EXTENSION_DIR
    }

class SettingsPayload(BaseModel):
    games_dir: Optional[str] = None
    games_dirs: Optional[List[str]] = None
    archive_mode: Optional[str] = None
    startup_scan: Optional[bool] = None
    missing_grace_scans: Optional[int] = None
    automatic_game_update_checks: Optional[bool] = None
    game_update_check_interval_days: Optional[int] = None
    preferred_source: Optional[str] = None
    theme_mode: Optional[str] = None
    accent_color: Optional[str] = None

@app.get("/api/settings")
def get_app_settings():
    s = get_settings()
    s["extension_dir"] = EXTENSION_DIR
    s["primary_games_dir"] = s.get("games_dir", "")
    return s

@app.post("/api/settings")
def update_app_settings(payload: SettingsPayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    previous = get_settings()
    data = {}
    if payload.games_dirs is not None:
        data["games_dirs"] = payload.games_dirs
    if payload.games_dir is not None:
        data["games_dir"] = payload.games_dir
    if payload.archive_mode is not None:
        data["archive_mode"] = payload.archive_mode
    if payload.startup_scan is not None:
        data["startup_scan"] = payload.startup_scan
    if payload.missing_grace_scans is not None:
        data["missing_grace_scans"] = max(1, int(payload.missing_grace_scans))
    if payload.automatic_game_update_checks is not None:
        data["automatic_game_update_checks"] = payload.automatic_game_update_checks
    if payload.game_update_check_interval_days is not None:
        data["game_update_check_interval_days"] = max(1, int(payload.game_update_check_interval_days))
    if payload.preferred_source is not None:
        data["preferred_source"] = payload.preferred_source
    if payload.theme_mode is not None:
        data["theme_mode"] = payload.theme_mode
    if payload.accent_color is not None:
        data["accent_color"] = payload.accent_color
    updated = save_settings(data)
    updated["extension_dir"] = EXTENSION_DIR
    updated["primary_games_dir"] = updated.get("games_dir", "")
    return {"message": "Settings saved successfully", "settings": updated}


@app.post("/api/library/export")
def export_library(payload: LibraryExportPayload, background_tasks: BackgroundTasks):
    export_path = str(payload.export_path or "").strip()
    if not export_path:
        raise HTTPException(status_code=400, detail="A destination .zip path is required for library export")

    games_root = get_games_dir().resolve()
    if not games_root.exists() or not games_root.is_dir():
        raise HTTPException(status_code=400, detail=f"Configured library directory does not exist: {games_root}")

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != EXPORT_LIBRARY_JOB_KEY:
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job(EXPORT_LIBRARY_JOB_KEY)
    if current.get("status") == "running":
        return current

    total = count_library_export_work_units(games_root)
    state = start_job("export-library", total, "Exporting portable library package")
    set_job_context(EXPORT_LIBRARY_JOB_KEY, result={"output_path": export_path})
    background_tasks.add_task(run_library_export_job, export_path)
    return state


@app.post("/api/library/import")
def import_library(payload: LibraryImportPayload, background_tasks: BackgroundTasks):
    import_path_raw = str(payload.import_path or "").strip()
    if not import_path_raw:
        raise HTTPException(status_code=400, detail="An exported .zip package path is required for library import")
    import_path = Path(import_path_raw).expanduser()
    if not import_path.exists() or not import_path.is_file():
        raise HTTPException(status_code=400, detail=f"Import package not found: {import_path}")

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != IMPORT_LIBRARY_JOB_KEY:
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job(IMPORT_LIBRARY_JOB_KEY)
    if current.get("status") == "running":
        return current

    try:
        total = count_library_import_work_units(import_path.resolve())
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid XDir library export package: {exc}") from exc

    state = start_job("import-library", total, "Importing portable library package")
    set_job_context(IMPORT_LIBRARY_JOB_KEY, result={"input_path": str(import_path.resolve())})
    background_tasks.add_task(run_library_import_job, str(import_path.resolve()))
    return state

@app.get("/api/tags/all")
def get_all_tags(db: Session = Depends(get_db)):
    # Combine regular tags and custom tags
    tags = db.query(Tag.tag_name).distinct().all()
    custom = db.query(CustomTag.tag_name).distinct().all()
    all_unique = sorted(list({t[0] for t in tags} | {c[0] for c in custom}))
    return all_unique

@app.get("/api/games")
def list_games(
    status: Optional[str] = Query(None, description="exe, archive, folder"),
    progress: Optional[str] = Query(None, description="unplayed, playing, completed, on_hold"),
    identified: Optional[bool] = Query(None),
    update: Optional[bool] = Query(None),
    search: Optional[str] = Query(None),
    category: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    source: Optional[str] = Query(None),
    sort: Optional[str] = Query("title", description="title, date, rating"),
    db: Session = Depends(get_db)
):
    query = db.query(Game).filter(Game.is_ignored == False)
    query = query.filter(visible_library_entry_clause())
    
    if status and status != "all":
        if status == "installed":
            query = query.filter(Game.file_type.in_(["exe", "folder"]))
        elif status == "archives":
            query = query.filter(Game.file_type == "archive")
        elif status == "available":
            query = query.filter(Game.file_type.in_(["exe", "folder", "archive"]))
        else:
            query = query.filter(Game.file_type == status)
            
    if progress and progress != "all":
        query = query.filter(Game.playing_progress == progress)
        
    if source and source != "all":
        query = query.filter(Game.source_type == source)
            
    if identified is not None:
        query = query.filter(Game.is_identified == identified)
        
    if update is not None and update:
        query = query.filter(Game.update_available == True)
        
    if category and category != "all":
        query = query.filter(Game.category == category)
        
    if tag and tag != "all":
        query = query.filter(
            Game.tags.any(Tag.tag_name == tag) | Game.custom_tags.any(CustomTag.tag_name == tag)
        )
        
    if search and search.strip():
        term = f"%{search.strip()}%"
        query = query.filter(
            (Game.title.ilike(term)) | 
            (Game.raw_name.ilike(term)) | 
            (Game.developer.ilike(term)) |
            (Game.tags.any(Tag.tag_name.ilike(term)))
        )
        
    if sort == "date":
        query = query.order_by(Game.added_at.desc())
    elif sort == "rating":
        query = query.order_by(Game.rating.desc())
    else:
        query = query.order_by(Game.title.asc())
        
    games = query.all()
    return [g.to_dict() for g in games]

@app.get("/api/games/needs-metadata")
def get_games_needing_metadata(db: Session = Depends(get_db)):
    games = db.query(Game).filter(Game.is_identified == True, Game.cover_url == None, Game.is_ignored == False).limit(20).all()
    games = [g for g in games if g.file_type == "wishlist" or (g.missing_scan_count or 0) == 0]
    return [g.to_dict() for g in games]

@app.get("/api/games/{game_id}")
def get_game(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    data = game.to_dict()
    
    if game.file_type == "archive":
        data["archive_contents"] = inspect_archive(Path(game.folder_path))
    else:
        data["archive_contents"] = []
        
    return data


@app.patch("/api/games/{game_id}/version")
def update_game_version(game_id: int, payload: GameVersionPayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    clean_version = str(payload.local_version or "").strip()
    game.local_version = clean_version or None
    game.local_version_is_manual = True
    game.last_update_check_error = None
    if game.latest_version:
        apply_comparison_to_game(game)
    else:
        game.update_available = False
        game.update_detected_at = None
        game.last_update_check_status = "remote_version_unavailable" if game.last_update_check_at else "never"
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    return {"message": "Local version updated", "game": game.to_dict()}


@app.post("/api/games/{game_id}/mark-latest-installed")
def mark_latest_installed(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if not str(game.latest_version or "").strip():
        raise HTTPException(status_code=400, detail="No latest online version is available to mark as installed")

    game.local_version = game.latest_version
    game.local_version_is_manual = True
    game.update_available = False
    game.update_detected_at = None
    game.last_update_check_status = "up_to_date"
    game.last_update_check_error = None
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    return {"message": "Latest version marked as installed. No game files were changed.", "game": game.to_dict()}


@app.post("/api/games/{game_id}/check-update")
def trigger_game_update_check(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    with UPDATE_CHECK_JOB_START_LOCK:
        if get_job(UPDATE_CHECK_JOB_KEY).get("status") == "running":
            raise HTTPException(status_code=409, detail="A whole-library update check is already running")
        with ACTIVE_UPDATE_CHECK_GAMES_LOCK:
            if game_id in ACTIVE_UPDATE_CHECK_GAME_IDS:
                raise HTTPException(status_code=409, detail="This game is already being checked")
            ACTIVE_UPDATE_CHECK_GAME_IDS.add(game_id)
    try:
        result = check_game_update(game, db)
        db.refresh(game)
        persist_snapshot(game, db)
        return {"message": "Update check completed", "result": result.to_dict(), "game": game.to_dict()}
    finally:
        with ACTIVE_UPDATE_CHECK_GAMES_LOCK:
            ACTIVE_UPDATE_CHECK_GAME_IDS.discard(game_id)

@app.patch("/api/games/{game_id}")
def update_game(game_id: int, payload: UpdateGamePayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if payload.playing_progress is not None:
        game.playing_progress = payload.playing_progress
    if payload.user_score is not None:
        game.user_score = payload.user_score
    if payload.is_identified is not None:
        game.is_identified = payload.is_identified
    if payload.title is not None:
        game.title = payload.title.strip()
        game.title_is_manual = True
        
    db.commit()
    persist_snapshot(game, db)
    return game.to_dict()

@app.post("/api/games/{game_id}/custom_tags")
def add_custom_tag(game_id: int, payload: CustomTagPayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    tag_clean = payload.tag_name.trim() if hasattr(payload.tag_name, 'trim') else payload.tag_name.strip()
    if not tag_clean:
        raise HTTPException(status_code=400, detail="Empty tag")
        
    existing = db.query(CustomTag).filter(CustomTag.game_id == game_id, CustomTag.tag_name == tag_clean).first()
    if not existing:
        ct = CustomTag(game_id=game_id, tag_name=tag_clean)
        db.add(ct)
        db.commit()
        persist_snapshot(game, db)
        
    return game.to_dict()

@app.delete("/api/games/{game_id}/custom_tags/{tag_name}")
def delete_custom_tag(game_id: int, tag_name: str, db: Session = Depends(get_db)):
    ct = db.query(CustomTag).filter(CustomTag.game_id == game_id, CustomTag.tag_name == tag_name).first()
    if ct:
        db.delete(ct)
        db.commit()
    game = db.query(Game).filter(Game.id == game_id).first()
    if game:
        persist_snapshot(game, db)
    return game.to_dict() if game else {}

@app.post("/api/games/{game_id}/journal")
def add_journal(game_id: int, payload: JournalPayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    if not payload.entry_text.strip():
        raise HTTPException(status_code=400, detail="Empty text")
        
    je = JournalEntry(game_id=game_id, entry_text=payload.entry_text.strip())
    db.add(je)
    db.commit()
    persist_snapshot(game, db)
    return game.to_dict()

@app.post("/api/library/scan")
def trigger_scan(db: Session = Depends(get_db)):
    res = run_ingestion(db)
    return {"message": "Scan completed", "stats": res}

@app.post("/api/games/{game_id}/launch")
def launch_game(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
        
    path = os.path.normpath(game.folder_path)
    if not os.path.exists(path):
        raise HTTPException(status_code=400, detail=f"Path does not exist: {path}")
        
    try:
        if game.file_type == "archive":
            return open_game_folder_location(game)

        exe_path = choose_launch_executable(path)
        if exe_path:
            return launch_tracked_game_process(game, str(exe_path), db)

        return open_game_folder_location(game)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to launch/open: {str(e)}")


@app.post("/api/games/{game_id}/open-folder")
def open_game_folder(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    try:
        return open_game_folder_location(game)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to open folder: {str(e)}")

@app.post("/api/games/{game_id}/link")
def link_game(game_id: int, payload: LinkGamePayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
        
    source_type, source_url, source_id = determine_source_info(payload.source_url)
    if source_type == "unknown" or not source_url:
        raise HTTPException(status_code=400, detail="Invalid or unrecognized URL. Supported: F95Zone threads, DLsite product IDs (RJ/VJ/BJ), Steam app URLs, Itch.io pages.")
        
    game.source_type = source_type
    game.source_url = source_url
    game.source_id = source_id
    game.is_identified = True
    
    from backend.database import GameSource
    existing_src = next((s for s in game.sources if s.source_type == source_type and s.source_url == source_url), None)
    for s in game.sources:
        s.is_preferred = False
    if existing_src:
        existing_src.is_preferred = True
    else:
        new_src = GameSource(
            game_id=game.id,
            source_type=source_type,
            source_url=source_url,
            source_id=source_id,
            is_preferred=True
        )
        game.sources.append(new_src)
    warning = try_apply_source_metadata(
        game,
        db,
        source_type,
        source_url,
        source_id,
        force_overwrite=True,
        context_label="linked",
    )

    cleanup_redundant_wishlist_entries(db, game)
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    response = {
        "message": f"Game linked to {source_type.upper()} and metadata fetched!"
        if not warning
        else f"Game linked to {source_type.upper()} successfully, but metadata refresh failed.",
        "game": game.to_dict(),
    }
    if warning:
        response["warning"] = warning
    return response

@app.post("/api/games/{game_id}/sources")
def add_game_source(game_id: int, payload: AddSourcePayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
        
    source_type, source_url, source_id = determine_source_info(payload.source_url)
    if source_type == "unknown" or not source_url:
        raise HTTPException(status_code=400, detail="Invalid or unrecognized URL. Supported: F95Zone threads, DLsite product IDs (RJ/VJ/BJ), Steam app URLs, Itch.io pages.")
        
    from backend.database import GameSource
    existing_src = next((s for s in game.sources if s.source_type == source_type and s.source_url == source_url), None)
    
    if payload.make_preferred or not game.sources or not game.is_identified:
        game.source_type = source_type
        game.source_url = source_url
        game.source_id = source_id
        game.is_identified = True
        for s in game.sources:
            s.is_preferred = False
        if existing_src:
            existing_src.is_preferred = True
        else:
            new_src = GameSource(
                game_id=game.id,
                source_type=source_type,
                source_url=source_url,
                source_id=source_id,
                is_preferred=True
            )
            game.sources.append(new_src)
        if payload.title and len(payload.title.strip()) > 1:
            game.title = payload.title.strip()
        if payload.cover_url and len(payload.cover_url.strip()) > 5:
            game.cover_url = payload.cover_url.strip()
        if payload.developer and len(payload.developer.strip()) > 1 and payload.developer != 'Unknown':
            game.developer = payload.developer.strip()
        if payload.version:
            game.latest_version = payload.version.strip()
        warning = try_apply_source_metadata(
            game,
            db,
            source_type,
            source_url,
            source_id,
            force_overwrite=True,
            context_label="selected",
        )
    else:
        if not existing_src:
            new_src = GameSource(
                game_id=game.id,
                source_type=source_type,
                source_url=source_url,
                source_id=source_id,
                is_preferred=False
            )
            game.sources.append(new_src)
        if payload.title and len(payload.title.strip()) > 1 and not game.title:
            game.title = payload.title.strip()
        if payload.cover_url and len(payload.cover_url.strip()) > 5 and not game.cover_url:
            game.cover_url = payload.cover_url.strip()
        if payload.developer and len(payload.developer.strip()) > 1 and (not game.developer or game.developer == 'Unknown'):
            game.developer = payload.developer.strip()
        if payload.version and not game.latest_version:
            game.latest_version = payload.version.strip()
        warning = try_apply_source_metadata(
            game,
            db,
            source_type,
            source_url,
            source_id,
            force_overwrite=False,
            context_label="selected",
        )

    cleanup_redundant_wishlist_entries(db, game)
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    response = {
        "message": f"Source {source_type.upper()} linked successfully!"
        if not warning
        else f"Source {source_type.upper()} linked successfully, but metadata refresh failed.",
        "game": game.to_dict(),
    }
    if warning:
        response["warning"] = warning
    return response

@app.delete("/api/games/{game_id}/sources/{source_id}")
def delete_game_source(game_id: int, source_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
        
    from backend.database import GameSource
    src = db.query(GameSource).filter(GameSource.id == source_id, GameSource.game_id == game_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
        
    was_preferred = src.is_preferred
    db.delete(src)
    db.commit()
    db.refresh(game)
    
    if was_preferred:
        if game.sources:
            new_pref = game.sources[0]
            new_pref.is_preferred = True
            game.source_type = new_pref.source_type
            game.source_url = new_pref.source_url
            game.source_id = new_pref.source_id
        else:
            game.source_type = "unknown"
            game.source_url = None
            game.source_id = None
            game.is_identified = False
        db.commit()
        db.refresh(game)
        
    persist_snapshot(game, db)
    return {"message": "Source removed successfully", "game": game.to_dict()}

@app.post("/api/games/{game_id}/sources/{source_id}/prefer")
def make_source_preferred(game_id: int, source_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
        
    from backend.database import GameSource
    src = db.query(GameSource).filter(GameSource.id == source_id, GameSource.game_id == game_id).first()
    if not src:
        raise HTTPException(status_code=404, detail="Source not found")
        
    for s in game.sources:
        s.is_preferred = (s.id == source_id)
        
    game.source_type = src.source_type
    game.source_url = src.source_url
    game.source_id = src.source_id
    game.is_identified = True
    warning = try_apply_source_metadata(
        game,
        db,
        src.source_type,
        src.source_url,
        src.source_id,
        force_overwrite=True,
        context_label="preferred",
    )
        
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    response = {
        "message": f"Preferred source switched to {src.source_type.upper()} and metadata updated!"
        if not warning
        else f"Preferred source switched to {src.source_type.upper()}, but metadata refresh failed.",
        "game": game.to_dict(),
    }
    if warning:
        response["warning"] = warning
    return response


@app.get("/api/games/{game_id}/linkable-local")
def get_linkable_local_games(game_id: int, search: Optional[str] = Query(None), db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.file_type != "wishlist":
        raise HTTPException(status_code=400, detail="Only wishlist items can link to a local entry")

    term_source = (search or game.title or "").strip()
    query = db.query(Game).filter(Game.file_type != "wishlist", Game.is_ignored == False)

    if term_source:
        term = f"%{term_source}%"
        query = query.filter(
            (Game.title.ilike(term)) |
            (Game.raw_name.ilike(term)) |
            (Game.developer.ilike(term))
        )

    candidates = query.order_by(Game.title.asc()).limit(25).all()
    return [
        {
            "id": entry.id,
            "title": entry.title,
            "folder_path": entry.folder_path,
            "file_type": entry.file_type,
            "developer": entry.developer,
            "source_type": entry.source_type,
            "source_url": entry.source_url,
        }
        for entry in candidates
    ]

@app.post("/api/games/{game_id}/link-local")
def link_wishlist_to_local(game_id: int, payload: LocalLinkPayload, db: Session = Depends(get_db)):
    wishlist = db.query(Game).filter(Game.id == game_id).first()
    if not wishlist:
        raise HTTPException(status_code=404, detail="Game not found")
    if wishlist.file_type != "wishlist":
        raise HTTPException(status_code=400, detail="Only wishlist items can link to a local entry")

    target = db.query(Game).filter(Game.id == payload.target_game_id).first()
    if not target:
        raise HTTPException(status_code=404, detail="Target local entry not found")
    if target.file_type == "wishlist":
        raise HTTPException(status_code=400, detail="Target entry must be a scanned local game, not another wishlist item")

    if wishlist.title and (not target.is_identified or target.source_type == "unknown" or target.title == target.raw_name):
        target.title = wishlist.title

    if wishlist.source_url and not target.source_url:
        target.source_url = wishlist.source_url
    if wishlist.source_id and not target.source_id:
        target.source_id = wishlist.source_id
    if wishlist.source_type and target.source_type == "unknown":
        target.source_type = wishlist.source_type
    if wishlist.is_identified and not target.is_identified:
        target.is_identified = True

    merge_game_records(target, wishlist, db)
    db.commit()
    db.refresh(target)
    persist_snapshot(target, db)
    return {"message": "Wishlist item linked to local entry successfully", "game": target.to_dict()}

@app.post("/api/games/{game_id}/link-picked-local")
def link_wishlist_to_picked_local(game_id: int, payload: PickedLocalPathPayload, db: Session = Depends(get_db)):
    wishlist = db.query(Game).filter(Game.id == game_id).first()
    if not wishlist:
        raise HTTPException(status_code=404, detail="Game not found")
    if wishlist.file_type != "wishlist":
        raise HTTPException(status_code=400, detail="Only wishlist items can link to a local entry")

    scanned_item = scan_single_game_path(payload.selected_path)
    if not scanned_item:
        raise HTTPException(status_code=400, detail="Selected path is not a supported game folder, archive, or executable")

    folder_path = scanned_item["folder_path"]
    raw_name = scanned_item["raw_name"]

    target = db.query(Game).filter(Game.folder_path == folder_path, Game.file_type != "wishlist").first()
    if not target:
        target = db.query(Game).filter(Game.raw_name == raw_name, Game.file_type != "wishlist").first()

    if target:
        target.category = scanned_item["category"]
        target.folder_path = folder_path
        target.file_type = scanned_item["file_type"]
        target.archive_name = scanned_item["archive_name"]
        target.size_bytes = scanned_item["size_bytes"]
        apply_scanned_local_version(target, scanned_item["local_version"])
        target.last_seen_at = datetime.utcnow()
        target.missing_scan_count = 0
    else:
        target = Game(
            title=scanned_item["title"],
            raw_name=raw_name,
            category=scanned_item["category"],
            folder_path=folder_path,
            file_type=scanned_item["file_type"],
            archive_name=scanned_item["archive_name"],
            size_bytes=scanned_item["size_bytes"],
            local_version=scanned_item["local_version"],
            source_type="unknown",
            source_url=None,
            source_id=None,
            is_identified=False,
            last_seen_at=datetime.utcnow(),
            missing_scan_count=0,
        )
        db.add(target)
        db.flush()

    if wishlist.title and (not target.is_identified or target.source_type == "unknown" or target.title == target.raw_name or target.title.startswith("Wishlist Item")):
        target.title = wishlist.title

    if wishlist.source_url and not target.source_url:
        target.source_url = wishlist.source_url
    if wishlist.source_id and not target.source_id:
        target.source_id = wishlist.source_id
    if wishlist.source_type and target.source_type == "unknown":
        target.source_type = wishlist.source_type
    if wishlist.is_identified and not target.is_identified:
        target.is_identified = True

    merge_game_records(target, wishlist, db)
    cleanup_redundant_wishlist_entries(db, target)
    db.commit()
    db.refresh(target)
    persist_snapshot(target, db)
    return {"message": "Wishlist item linked to selected local source successfully", "game": target.to_dict()}

@app.post("/api/games/{game_id}/clear-source")
def clear_game_source(game_id: int, db: Session = Depends(get_db)):
    """Wipe a game's source data so it can be re-identified from scratch."""
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    clear_game_scraped_metadata(game, db, preserve_identification=False)
    game.source_type = "unknown"
    game.source_url = None
    game.source_id = None

    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    return {"message": "Source data cleared. Game is ready to be re-linked.", "game": game.to_dict()}

@app.post("/api/metadata/sync")
def sync_metadata(payload: MetadataSyncPayload, db: Session = Depends(get_db)):
    game = None
    if payload.game_id:
        game = db.query(Game).filter(Game.id == payload.game_id).first()
    elif payload.source_url:
        _, clean_url, sid = determine_source_info(payload.source_url)
        if sid:
            game = db.query(Game).filter(Game.source_id == sid, Game.file_type != 'wishlist').first()
            if not game:
                game = db.query(Game).filter(Game.source_id == sid).first()
        if not game and clean_url:
            game = db.query(Game).filter(Game.source_url == clean_url, Game.file_type != 'wishlist').first()
            if not game:
                game = db.query(Game).filter(Game.source_url == clean_url).first()
        if not game:
            game = db.query(Game).filter(Game.source_url == payload.source_url, Game.file_type != 'wishlist').first()
            if not game:
                game = db.query(Game).filter(Game.source_url == payload.source_url).first()
            
    if not game:
        if payload.source_url:
            source_type, source_url, source_id = determine_source_info(payload.source_url)
            import time
            stamp = str(int(time.time()))
            game = Game(
                title=payload.title or "Wishlist Item",
                raw_name="wishlist_" + stamp,
                category="Wishlist",
                folder_path="wishlist_" + stamp,
                file_type="wishlist",
                source_type=source_type if source_type != "unknown" else "web",
                source_url=source_url or payload.source_url,
                source_id=source_id,
                is_identified=True
            )
            db.add(game)
            db.commit()
            db.refresh(game)
        else:
            raise HTTPException(status_code=404, detail="Game not found for metadata sync")
            
    if payload.title and not game.title_is_manual:
        game.title = payload.title
        
    if payload.cover_url:
        game.cover_url = payload.cover_url
    if payload.rating:
        game.rating = payload.rating
    if payload.developer:
        game.developer = payload.developer
    if payload.release_date:
        game.release_date = payload.release_date
    if payload.description:
        game.description = payload.description
        
    if payload.latest_version:
        game.latest_version = payload.latest_version.strip()
        apply_comparison_to_game(game, checked_at=utc_now())
            
    if payload.screenshots:
        existing_urls = {s.url for s in game.screenshots}
        for url in payload.screenshots:
            if url not in existing_urls and url.startswith("http"):
                new_s = Screenshot(game_id=game.id, url=url)
                db.add(new_s)
                existing_urls.add(url)
                
    if payload.tags:
        existing_tags = {t.tag_name for t in game.tags}
        for tag in payload.tags:
            if tag not in existing_tags and len(tag) > 1:
                new_t = Tag(game_id=game.id, tag_name=tag)
                db.add(new_t)
                existing_tags.add(tag)

    cleanup_redundant_wishlist_entries(db, game)
    db.commit()
    persist_snapshot(game, db)
    return {"message": "Metadata updated successfully", "game": game.to_dict()}

class WishlistPayload(BaseModel):
    url: str
    title: Optional[str] = None
    cover_url: Optional[str] = None
    developer: Optional[str] = None
    version: Optional[str] = None

@app.post("/api/games/wishlist")
def add_to_wishlist(payload: WishlistPayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from backend.ingest import determine_source_info
    source_type, source_url, source_id = determine_source_info(payload.url)
    if source_type == "unknown" or not source_url:
        raise HTTPException(status_code=400, detail="Invalid URL. Supported: F95Zone, DLsite, Itch.io, Steam")

    existing_game = None
    if source_id:
        existing_game = db.query(Game).filter(Game.source_id == source_id, Game.file_type != "wishlist").first()
    if not existing_game:
        existing_game = db.query(Game).filter(Game.source_url == source_url, Game.file_type != "wishlist").first()
    if existing_game:
        if payload.title and existing_game.title.startswith("Wishlist Item"):
            existing_game.title = payload.title
        if payload.cover_url and not existing_game.cover_url:
            existing_game.cover_url = payload.cover_url
        if payload.developer and not existing_game.developer:
            existing_game.developer = payload.developer
        cleanup_redundant_wishlist_entries(db, existing_game)
        db.commit()
        db.refresh(existing_game)
        persist_snapshot(existing_game, db)
        return {"message": "Game already exists in your available library.", "game": existing_game.to_dict()}

    import time
    stamp = str(int(time.time()))
    game = Game(
        title=payload.title if payload.title else ("Wishlist Item (" + source_type + ")"),
        raw_name="wishlist_" + stamp,
        category="Wishlist",
        folder_path="wishlist_" + stamp,
        file_type="wishlist",
        source_type=source_type,
        source_url=source_url,
        source_id=source_id,
        is_identified=True,
        cover_url=payload.cover_url or None,
        developer=payload.developer or None,
        latest_version=payload.version or None
    )
    db.add(game)
    db.commit()
    db.refresh(game)
    persist_snapshot(game, db)
    
    def bg_scrape_wishlist(gid: int):
        from backend.database import SessionLocal, Game
        from backend.scraper import fetch_game_metadata
        bg_db = SessionLocal()
        try:
            g = bg_db.query(Game).filter(Game.id == gid).first()
            if g:
                fetch_game_metadata(g, bg_db, force_overwrite=True)
                persist_snapshot(g, bg_db)
        except Exception as e:
            print("Background wishlist scrape error:", e)
        finally:
            bg_db.close()
            
    background_tasks.add_task(bg_scrape_wishlist, game.id)
    return {"message": "Added to wishlist instantly!", "game": game.to_dict()}

class IgnorePayload(BaseModel):
    is_ignored: bool

@app.patch("/api/games/{game_id}/ignore")
def ignore_game(game_id: int, payload: IgnorePayload, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    game.is_ignored = payload.is_ignored
    db.commit()
    persist_snapshot(game, db)
    return {"message": "Game ignored status updated", "game": game.to_dict()}

@app.delete("/api/games/{game_id}")
def delete_game(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    if game.file_type == "wishlist":
        game.is_ignored = True
        db.commit()
        persist_snapshot(game, db)
        return {"message": "Game deleted successfully"}
    remove_game_snapshot(game)
    db.delete(game)
    db.commit()
    return {"message": "Game deleted successfully"}


# Extension Status & Heartbeat Tracking
import time

EXTENSION_STATUS = {"connected": False, "last_ping": 0, "version": "Unknown", "last_sync_trigger": 0}

class ExtensionPingPayload(BaseModel):
    version: Optional[str] = "0.2.0"

@app.post("/api/extension/ping")
def ping_extension(payload: ExtensionPingPayload):
    now = time.time()
    EXTENSION_STATUS["connected"] = True
    EXTENSION_STATUS["last_ping"] = now
    if payload.version:
        EXTENSION_STATUS["version"] = payload.version
        
    trigger = (now - EXTENSION_STATUS.get("last_sync_trigger", 0)) > 30
    if trigger:
        EXTENSION_STATUS["last_sync_trigger"] = now
        
    return {"status": "ok", "trigger_queue": trigger}

@app.get("/api/extension/status")
def get_extension_status():
    now = time.time()
    is_active = (now - EXTENSION_STATUS["last_ping"]) < 15
    return {
        "connected": is_active,
        "version": EXTENSION_STATUS["version"] if is_active else None,
        "last_seen_seconds": int(now - EXTENSION_STATUS["last_ping"]) if EXTENSION_STATUS["last_ping"] > 0 else None
    }


def run_library_export_job(export_path: str):
    bg_db = SessionLocal()
    try:
        games_root = get_games_dir().resolve()
        if not games_root.exists() or not games_root.is_dir():
            raise FileNotFoundError(f"Configured library directory does not exist: {games_root}")

        games = bg_db.query(Game).filter(Game.is_ignored == False).all()
        manifest = build_export_manifest(games_root, games, get_settings(), load_source_map_data())

        bundle_path = write_export_bundle(
            export_path,
            games_root,
            manifest,
            progress_callback=lambda completed, total, current_name, detail: update_job(
                EXPORT_LIBRARY_JOB_KEY,
                completed,
                current_name,
                detail,
            ),
        )

        set_job_context(
            EXPORT_LIBRARY_JOB_KEY,
            result={
                "output_path": str(bundle_path),
                "game_count": len(manifest.get("games", [])),
                "excluded_local_records": manifest.get("stats", {}).get("excluded_local_records", 0),
            },
        )
        finish_job(
            EXPORT_LIBRARY_JOB_KEY,
            f"Exported {len(manifest.get('games', []))} library entries and packaged {games_root} to {bundle_path}.",
        )
    except Exception as exc:
        fail_job(EXPORT_LIBRARY_JOB_KEY, str(exc))
    finally:
        bg_db.close()


def run_library_import_job(import_path: str):
    from backend.scraper import fetch_game_metadata

    bg_db = SessionLocal()
    try:
        package_path = Path(import_path).expanduser().resolve()
        manifest = load_export_bundle_manifest(package_path)
        games_root = get_games_dir().resolve()
        extraction_units = 0
        with zipfile.ZipFile(package_path, "r") as bundle:
            extraction_units = sum(
                1
                for info in bundle.infolist()
                if info.filename.startswith("library/") and info.filename != "library/"
            )

        extraction_stats = extract_export_bundle(
            package_path,
            games_root,
            progress_callback=lambda completed, total, current_name, detail: update_job(
                IMPORT_LIBRARY_JOB_KEY,
                completed,
                current_name,
                detail,
            ),
        )
        current_step = extraction_units

        merged_source_entries = merge_source_map_data(manifest.get("source_map"))

        portable_settings = manifest.get("settings") or {}
        restored_settings = {}
        configured_roots = [str(root).strip() for root in list(manifest.get("configured_roots") or []) if str(root).strip()]
        for key in (
            "archive_mode",
            "startup_scan",
            "missing_grace_scans",
            "preferred_source",
            "automatic_game_update_checks",
            "game_update_check_interval_days",
            "last_game_update_check_at",
        ):
            if portable_settings.get(key) is not None:
                restored_settings[key] = portable_settings[key]
        if configured_roots:
            restored_settings["games_dirs"] = [str(games_root), *configured_roots[1:]]
        if restored_settings:
            save_settings(restored_settings)

        ingestion_result = run_ingestion(bg_db)
        bg_db.expire_all()

        imported_records = 0
        skipped_records = 0
        metadata_refreshed = 0
        metadata_failed = 0

        for index, record in enumerate(list(manifest.get("games", [])), start=1):
            record_file_type = str(record.get("file_type") or "folder")
            destination_path = None
            if record_file_type != "wishlist":
                relative_path = record.get("relative_path")
                if relative_path:
                    destination_path = resolve_import_destination(games_root, relative_path)
                else:
                    absolute_folder_path = str(record.get("folder_path") or "").strip()
                    if absolute_folder_path and is_path_within_games_dirs(absolute_folder_path):
                        candidate_path = Path(absolute_folder_path).expanduser()
                        if candidate_path.exists():
                            try:
                                destination_path = candidate_path.resolve()
                            except Exception:
                                destination_path = candidate_path.absolute()
                if destination_path is None:
                    skipped_records += 1
                    current_step += 1
                    update_job(
                        IMPORT_LIBRARY_JOB_KEY,
                        current_step,
                        str(record.get("title") or record.get("raw_name") or "Skipped local entry"),
                        "Skipping a local record whose files are not available in the imported primary root or configured extra roots.",
                    )
                    continue

            game = find_game_for_import_record(bg_db, record, destination_path)
            if game is None:
                fallback_folder_path = str(destination_path) if destination_path is not None else str(
                    record.get("folder_path") or record.get("raw_name") or f"wishlist_import_{int(time.time())}_{index}"
                )
                game = Game(
                    title=str(record.get("title") or record.get("raw_name") or "Imported Game"),
                    raw_name=str(record.get("raw_name") or Path(fallback_folder_path).name),
                    category=str(record.get("category") or "Imported"),
                    folder_path=fallback_folder_path,
                    file_type=record_file_type,
                )
                bg_db.add(game)
                bg_db.flush()

            apply_import_record_to_game(game, record, destination_path, bg_db)
            bg_db.commit()
            bg_db.refresh(game)
            persist_snapshot(game, bg_db)

            imported_records += 1
            current_step += 1
            update_job(
                IMPORT_LIBRARY_JOB_KEY,
                current_step,
                game.title or game.raw_name,
                "Restoring library records, source links, and user data...",
            )

            if needs_metadata_refresh(record):
                try:
                    game = fetch_game_metadata(game, bg_db, force_overwrite=False)
                    metadata_refreshed += 1
                except Exception:
                    bg_db.rollback()
                    metadata_failed += 1

        duplicates_removed = deduplicate_games(bg_db)
        set_job_context(
            IMPORT_LIBRARY_JOB_KEY,
            result={
                "input_path": str(package_path),
                "extracted_files": extraction_stats.get("extracted_files", 0),
                "skipped_files": extraction_stats.get("skipped_files", 0),
                "created_dirs": extraction_stats.get("created_dirs", 0),
                "imported_records": imported_records,
                "skipped_records": skipped_records,
                "metadata_refreshed": metadata_refreshed,
                "metadata_failed": metadata_failed,
                "merged_source_entries": merged_source_entries,
                "duplicates_removed": duplicates_removed,
                "ingestion": ingestion_result,
            },
        )
        finish_job(
            IMPORT_LIBRARY_JOB_KEY,
            "Imported portable library package into the configured games directory. "
            f"Restored {imported_records} records, extracted {extraction_stats.get('extracted_files', 0)} files, "
            f"skipped {extraction_stats.get('skipped_files', 0)} existing files, refreshed metadata for {metadata_refreshed} games, "
            f"and merged {merged_source_entries} durable source snapshots.",
        )
    except Exception as exc:
        bg_db.rollback()
        fail_job(IMPORT_LIBRARY_JOB_KEY, str(exc))
    finally:
        bg_db.close()


def run_rematch_f95zone_job():
    from backend.scraper import rematch_and_scrape_f95zone

    bg_db = SessionLocal()
    try:
        def progress_callback(index, total_games, g, detail=None):
            update_job("rematch-f95zone", index, g.title or g.raw_name, detail)

        res = rematch_and_scrape_f95zone(bg_db, progress_callback=progress_callback)
        EXTENSION_STATUS["last_sync_trigger"] = 0
        finish_job(
            "rematch-f95zone",
            res["message"] + " Chrome extension logged-in queue syncing has also been triggered in the background.",
        )
    except Exception as e:
        bg_db.rollback()
        fail_job("rematch-f95zone", str(e))
    finally:
        bg_db.close()


def run_fix_metadata_job():
    from backend.scraper import fix_all_titles_and_metadata

    bg_db = SessionLocal()
    try:
        def progress_callback(index, total_games, g, detail=None):
            update_job("fix-metadata", index, g.title or g.raw_name, detail)

        res = fix_all_titles_and_metadata(bg_db, progress_callback=progress_callback)
        EXTENSION_STATUS["last_sync_trigger"] = 0
        finish_job("fix-metadata", res["message"])
    except Exception as e:
        bg_db.rollback()
        fail_job("fix-metadata", str(e))
    finally:
        bg_db.close()


def run_flush_metadata_job():
    bg_db = SessionLocal()
    try:
        games = bg_db.query(Game).all()
        cleared = 0

        for index, game in enumerate(games, start=1):
            clear_game_scraped_metadata(game, bg_db, preserve_identification=True)
            bg_db.commit()
            bg_db.refresh(game)
            persist_game_snapshot(game)
            cleared += 1
            update_job(
                "flush-metadata",
                index,
                game.title or game.raw_name,
                "Removing covers, screenshots, descriptions, ratings, versions, and scraped tags...",
            )

        cleared_snapshots = clear_metadata_from_all_snapshots()
        finish_job(
            "flush-metadata",
            f"Cleared scraped metadata for {cleared} games and refreshed {cleared_snapshots} cached source snapshots.",
        )
    except Exception as e:
        bg_db.rollback()
        fail_job("flush-metadata", str(e))
    finally:
        bg_db.close()


def run_tracked_metadata_scan_job(job_key: str, scan_runner):
    bg_db = SessionLocal()
    try:
        def progress_callback(snapshot: Dict[str, Any]):
            current_title = snapshot.get("current_title") or ""
            update_job(
                job_key,
                snapshot.get("processed", 0),
                current_title,
                snapshot.get("detail"),
            )
            context_updates = {}
            for key in (
                "current_index",
                "current_source",
                "current_query",
                "matched_count",
                "manual_review_count",
                "not_found_count",
                "failed_count",
            ):
                if key in snapshot:
                    context_updates[key] = snapshot.get(key)
            if context_updates:
                set_job_context(job_key, **context_updates)

        result = scan_runner(
            bg_db,
            progress_callback=progress_callback,
            should_cancel=lambda: is_job_cancel_requested(job_key),
        )
        set_job_context(
            job_key,
            result=result,
            matched_count=result.get("matched", 0),
            manual_review_count=result.get("manual_review", 0),
            not_found_count=result.get("not_found", 0),
            failed_count=result.get("failed", 0),
            current_source="",
            current_query="",
            current_index=result.get("processed", 0),
        )
        update_job(
            job_key,
            result.get("processed", 0),
            "",
            "Cancelled." if result.get("cancelled") else "Completed.",
        )
        if result.get("cancelled"):
            cancel_job(job_key, result["summary"])
        else:
            finish_job(job_key, result["summary"])
    except Exception as e:
        bg_db.rollback()
        fail_job(job_key, str(e))
    finally:
        bg_db.close()


def run_missing_source_metadata_scan_job():
    from backend.smart_scan import run_missing_source_scan

    run_tracked_metadata_scan_job("missing-source-scan", run_missing_source_scan)


def run_refresh_all_metadata_job():
    from backend.metadata_refresh import refresh_all_metadata

    bg_db = SessionLocal()
    try:
        def progress_callback(snapshot: Dict[str, Any]):
            update_job(
                REFRESH_ALL_METADATA_JOB_KEY,
                snapshot.get("processed", 0),
                snapshot.get("current_title") or "",
                f"Refreshing metadata for {snapshot.get('current_title') or 'linked game'}...",
            )
            set_job_context(REFRESH_ALL_METADATA_JOB_KEY, **snapshot)

        result = refresh_all_metadata(
            bg_db,
            progress_callback=progress_callback,
            should_cancel=lambda: is_job_cancel_requested(REFRESH_ALL_METADATA_JOB_KEY),
        )
        set_job_context(
            REFRESH_ALL_METADATA_JOB_KEY,
            result=result,
            current_game_id=None,
            current_title="",
            current_source="",
            current_index=result.get("processed", 0),
            **{key: result.get(key, 0) for key in (
                "processed",
                "refreshed_count",
                "skipped_count",
                "unsupported_count",
                "failed_count",
            )},
        )
        if not result.get("cancelled"):
            save_settings({"last_full_metadata_refresh_at": utc_now().isoformat()})
        update_job(
            REFRESH_ALL_METADATA_JOB_KEY,
            result.get("processed", 0),
            "",
            "Cancelled." if result.get("cancelled") else "Completed.",
        )
        if result.get("cancelled"):
            cancel_job(REFRESH_ALL_METADATA_JOB_KEY, result["summary"])
        else:
            finish_job(REFRESH_ALL_METADATA_JOB_KEY, result["summary"])
    except Exception as exc:
        bg_db.rollback()
        fail_job(REFRESH_ALL_METADATA_JOB_KEY, str(exc)[:300])
    finally:
        bg_db.close()


def list_update_check_targets(db: Session) -> list[Game]:
    candidates = db.query(Game).filter(
        Game.is_ignored == False,
        Game.file_type.in_(["exe", "folder", "archive"]),
        or_(Game.missing_scan_count == 0, Game.missing_scan_count.is_(None)),
    ).all()
    return [game for game in candidates if resolve_update_source(game).source_type != "unknown"]


def run_update_check_job():
    bg_db = SessionLocal()
    try:
        targets = list_update_check_targets(bg_db)

        def progress_callback(snapshot: Dict[str, Any]):
            update_job(
                UPDATE_CHECK_JOB_KEY,
                snapshot.get("processed", 0),
                snapshot.get("current_title") or "",
                f"Checking {snapshot.get('current_title') or 'linked game'}...",
            )
            set_job_context(UPDATE_CHECK_JOB_KEY, **snapshot)

        def checker(game: Game, session: Session):
            result = check_game_update(game, session)
            try:
                session.refresh(game)
                persist_snapshot(game, session)
            except Exception:
                pass
            return result

        result = check_library_updates(
            bg_db,
            games=targets,
            progress_callback=progress_callback,
            should_cancel=lambda: is_job_cancel_requested(UPDATE_CHECK_JOB_KEY),
            checker=checker,
        )
        set_job_context(
            UPDATE_CHECK_JOB_KEY,
            result=result,
            current_game_id=None,
            current_title="",
            current_source="",
            **{key: result.get(key, 0) for key in (
                "updates_found",
                "up_to_date_count",
                "unknown_local_count",
                "remote_unavailable_count",
                "unsupported_count",
                "version_differs_count",
                "failed_count",
            )},
        )
        if not result.get("cancelled") or result.get("processed", 0) > 0:
            save_settings({"last_game_update_check_at": utc_now().isoformat()})
        update_job(UPDATE_CHECK_JOB_KEY, result.get("processed", 0), "", "Completed.")
        if result.get("cancelled"):
            cancel_job(UPDATE_CHECK_JOB_KEY, result["summary"])
        else:
            finish_job(UPDATE_CHECK_JOB_KEY, result["summary"])
    except Exception as exc:
        bg_db.rollback()
        fail_job(UPDATE_CHECK_JOB_KEY, str(exc)[:300])
    finally:
        bg_db.close()


def start_update_check_job_in_thread() -> bool:
    with UPDATE_CHECK_JOB_START_LOCK:
        running_job = any_running_job()
        if running_job and running_job.get("job_key") != UPDATE_CHECK_JOB_KEY:
            return False
        if get_job(UPDATE_CHECK_JOB_KEY).get("status") == "running":
            return False
        with ACTIVE_UPDATE_CHECK_GAMES_LOCK:
            if ACTIVE_UPDATE_CHECK_GAME_IDS:
                return False
        with SessionLocal() as count_db:
            total = len(list_update_check_targets(count_db))
        start_job(UPDATE_CHECK_JOB_KEY, total, "Checking linked games for updates")
        set_job_context(
            UPDATE_CHECK_JOB_KEY,
            processed=0,
            updates_found=0,
            up_to_date_count=0,
            unknown_local_count=0,
            remote_unavailable_count=0,
            unsupported_count=0,
            version_differs_count=0,
            failed_count=0,
            result=None,
        )
    Thread(target=run_update_check_job, daemon=True).start()
    return True


@app.get("/api/search/f95zone")
def search_f95zone_api(query: str):
    if not query or len(query.strip()) < 2:
        return {"results": []}
    try:
        from backend.scraper import HEADERS
        import requests
        r = requests.get(f"https://f95zone.to/sam/latest_alpha/latest_data.php?cmd=list&cat=games&search={query.strip()}", headers=HEADERS, timeout=10)
        data_list = r.json().get('msg', {}).get('data', [])
        results = []
        if isinstance(data_list, list):
            for item in data_list[:20]:
                results.append({
                    "thread_id": item.get('thread_id'),
                    "title": item.get('title', 'Unknown Title'),
                    "version": item.get('version', ''),
                    "creator": item.get('creator', 'Unknown Developer'),
                    "cover": item.get('cover', ''),
                    "url": f"https://f95zone.to/threads/{item.get('thread_id')}/" if item.get('thread_id') else ""
                })
        return {"results": results}
    except Exception as e:
        return {"results": [], "error": str(e)}

@app.get("/api/search/universal")
def search_universal_api(query: str, platform: str = "all"):
    if not query or len(query.strip()) < 2:
        return {"results": [], "query": query, "platform": platform}
    try:
        from backend.scraper import search_all_sources
        return search_all_sources(query.strip(), platform=platform)
    except Exception as e:
        return {"results": [], "error": str(e), "query": query, "platform": platform}


@app.post("/api/games/{game_id}/fetch-metadata")
def trigger_fetch_metadata(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    try:
        from backend.scraper import rematch_and_scrape_f95zone, fetch_game_metadata
        rematch_and_scrape_f95zone(db, target_game_id=game_id)
        db.refresh(game)
        updated = fetch_game_metadata(game, db, force_overwrite=True)
        cleanup_redundant_wishlist_entries(db, updated)
        db.commit()
        persist_snapshot(updated, db)
        return {"message": "Metadata fetched successfully", "game": updated.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/library/check-updates")
def trigger_library_update_check(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    with UPDATE_CHECK_JOB_START_LOCK:
        running_job = any_running_job()
        if running_job and running_job.get("job_key") != UPDATE_CHECK_JOB_KEY:
            raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')
        current = get_job(UPDATE_CHECK_JOB_KEY)
        if current.get("status") == "running":
            return current
        with ACTIVE_UPDATE_CHECK_GAMES_LOCK:
            if ACTIVE_UPDATE_CHECK_GAME_IDS:
                raise HTTPException(status_code=409, detail="A single-game update check is already running")

        total = len(list_update_check_targets(db))
        state = start_job(UPDATE_CHECK_JOB_KEY, total, "Checking linked games for updates")
        set_job_context(
            UPDATE_CHECK_JOB_KEY,
            processed=0,
            updates_found=0,
            up_to_date_count=0,
            unknown_local_count=0,
            remote_unavailable_count=0,
            unsupported_count=0,
            version_differs_count=0,
            failed_count=0,
            result=None,
        )
    background_tasks.add_task(run_update_check_job)
    return state


@app.post("/api/library/refresh-all-metadata")
def trigger_refresh_all_metadata(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from backend.metadata_refresh import list_metadata_refresh_targets

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != REFRESH_ALL_METADATA_JOB_KEY:
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')
    current = get_job(REFRESH_ALL_METADATA_JOB_KEY)
    if current.get("status") == "running":
        return current

    total = len(list_metadata_refresh_targets(db))
    state = start_job(REFRESH_ALL_METADATA_JOB_KEY, total, "Refreshing metadata from linked sources")
    set_job_context(
        REFRESH_ALL_METADATA_JOB_KEY,
        processed=0,
        current_index=0,
        current_game_id=None,
        current_title="",
        current_source="",
        refreshed_count=0,
        skipped_count=0,
        unsupported_count=0,
        failed_count=0,
        result=None,
    )
    background_tasks.add_task(run_refresh_all_metadata_job)
    return state

@app.get("/api/library/jobs/{job_key}")
def get_library_job(job_key: str):
    return get_job(job_key)

@app.post("/api/library/jobs/{job_key}/cancel")
def cancel_library_job(job_key: str):
    return request_job_cancel(job_key)

@app.post("/api/library/rematch-f95zone", deprecated=True)
def trigger_rematch_f95zone(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    running_job = any_running_job()
    if running_job and running_job.get("job_key") != "rematch-f95zone":
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job("rematch-f95zone")
    if current.get("status") == "running":
        return current

    total = db.query(Game).count()
    state = start_job("rematch-f95zone", total, "Rematching unidentified games against F95Zone")
    background_tasks.add_task(run_rematch_f95zone_job)
    return state

@app.post("/api/library/fix-metadata", deprecated=True)
def trigger_fix_metadata(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    running_job = any_running_job()
    if running_job and running_job.get("job_key") != "fix-metadata":
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job("fix-metadata")
    if current.get("status") == "running":
        return current

    total = db.query(Game).count()
    state = start_job("fix-metadata", total, "Fixing titles and refetching metadata")
    background_tasks.add_task(run_fix_metadata_job)
    return state

@app.post("/api/library/flush-metadata")
def trigger_flush_metadata(payload: LibraryMetadataFlushPayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    if not payload.confirmation_phrase or payload.confirmation_phrase.strip().upper() != "FLUSH":
        raise HTTPException(status_code=400, detail="Confirmation phrase is required to flush library metadata")

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != "flush-metadata":
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job("flush-metadata")
    if current.get("status") == "running":
        return current

    total = db.query(Game).count()
    state = start_job("flush-metadata", total, "Flushing scraped metadata")
    background_tasks.add_task(run_flush_metadata_job)
    return state

@app.post("/api/library/missing-source-scan")
def trigger_missing_source_metadata_scan(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from backend.smart_scan import list_missing_source_scan_targets

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != "missing-source-scan":
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job("missing-source-scan")
    if current.get("status") == "running":
        return current

    total = len(list_missing_source_scan_targets(db))
    state = start_job("missing-source-scan", total, "Missing source metadata scan")
    set_job_context(
        "missing-source-scan",
        result={
            "cancelled": False,
            "processed": 0,
            "total": total,
            "remaining": total,
            "matched": 0,
            "manual_review": 0,
            "not_found": 0,
            "failed": 0,
            "review_items": [],
            "summary": "",
        },
    )
    if total == 0:
        set_job_context(
            "missing-source-scan",
            result={
                "cancelled": False,
                "processed": 0,
                "total": 0,
                "remaining": 0,
                "matched": 0,
                "manual_review": 0,
                "not_found": 0,
                "failed": 0,
                "review_items": [],
                "summary": "Missing source scan complete. 0 games processed, 0 metadata entries applied automatically, 0 need review, 0 not found, 0 failed.",
            },
        )
        finish_job(
            "missing-source-scan",
            "Missing source scan complete. 0 games processed, 0 metadata entries applied automatically, 0 need review, 0 not found, 0 failed.",
        )
        return get_job("missing-source-scan")

    background_tasks.add_task(run_missing_source_metadata_scan_job)
    return state

@app.post("/api/library/missing-source-scan/review/{game_id}/apply")
def apply_missing_source_review_candidate(
    game_id: int,
    payload: MissingSourceCandidatePayload,
    db: Session = Depends(get_db),
):
    from backend.smart_scan import apply_missing_source_candidate

    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    applied = apply_missing_source_candidate(
        game,
        db,
        {
            "source_type": payload.source_type,
            "source_url": payload.source_url,
            "url": payload.source_url,
            "source_id": payload.source_id,
            "title": payload.title,
            "creator": payload.creator,
            "cover": payload.cover,
            "version": payload.version,
        },
        force_overwrite=True,
    )
    db.refresh(game)
    response = {
        "message": "Metadata applied successfully" if not applied.get("warning") else "Source linked, but metadata refresh reported a warning.",
        "game": game.to_dict(),
    }
    if applied.get("warning"):
        response["warning"] = applied["warning"]
    remove_job_result_item("missing-source-scan", "review_items", game_id)
    return response


@app.post("/api/library/missing-source-scan/review/{game_id}/skip")
def skip_missing_source_review_candidate(game_id: int):
    remove_job_result_item("missing-source-scan", "review_items", game_id)
    return {"status": "skipped", "game_id": game_id}

@app.post("/api/translate")
def translate_texts(payload: TranslatePayload):
    import urllib.request
    import urllib.parse
    import json
    results = []
    for text in payload.texts:
        if not text or not text.strip():
            results.append(text)
            continue
        try:
            url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=' + urllib.parse.quote(text)
            req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
            r = urllib.request.urlopen(req, timeout=5).read()
            res = json.loads(r)
            t_str = "".join([part[0] for part in res[0] if part[0]])
            results.append(t_str)
        except Exception as e:
            results.append(text)
    return {"translations": results}

@app.post("/api/window/minimize")
def win_minimize():
    try:
        import webview
        if len(webview.windows) > 0:
            webview.windows[0].minimize()
    except Exception:
        pass
    return {"status": "ok"}

@app.post("/api/window/maximize")
def win_maximize():
    try:
        import webview
        if len(webview.windows) > 0:
            w = webview.windows[0]
            if getattr(w, 'maximized', False):
                w.restore()
            else:
                w.maximize()
    except Exception:
        pass
    return {"status": "ok"}

@app.post("/api/window/close")
def win_close():
    try:
        import webview
        if len(webview.windows) > 0:
            webview.windows[0].destroy()
    except Exception:
        pass
    import os, signal
    try:
        os.kill(os.getpid(), signal.SIGTERM)
    except Exception:
        pass
    return {"status": "ok"}

# Mount Static Frontend
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

frontend_dir = FRONTEND_DIR
if os.path.exists(frontend_dir):
    static_dir = os.path.join(frontend_dir, "static")
    if not os.path.exists(static_dir):
        os.makedirs(static_dir, exist_ok=True)
    app.mount("/static", StaticFiles(directory=static_dir), name="static")

    @app.get("/")
    def serve_index():
        response = FileResponse(os.path.join(frontend_dir, "index.html"))
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response
