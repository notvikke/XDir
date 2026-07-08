import os
import subprocess
from datetime import datetime
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Depends, HTTPException, Query, Body, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import or_
from sqlalchemy.orm import Session
from pydantic import BaseModel
from pathlib import Path

from backend.database import get_db, init_db, Game, Screenshot, Tag, CustomTag, JournalEntry, SessionLocal
from backend.scanner import inspect_archive, scan_single_game_path
from backend.ingest import run_ingestion, determine_source_info, merge_game_records, cleanup_redundant_wishlist_entries
from backend.config import get_settings, save_settings, get_games_dir
from backend.runtime import get_app_root, get_bundle_root
from backend.source_map import persist_game_snapshot, remove_game_snapshot, SOURCE_MAP_PATH, clear_metadata_from_all_snapshots
from backend.job_progress import (
    any_running_job,
    cancel_job,
    fail_job,
    finish_job,
    get_job,
    is_job_cancel_requested,
    request_job_cancel,
    set_job_context,
    start_job,
    update_job,
)

app = FastAPI(title="XDir API", version="0.2.0")
APP_ROOT = get_app_root()
BUNDLE_ROOT = get_bundle_root()
EXTENSION_DIR = os.path.join(BUNDLE_ROOT, "extension")
FRONTEND_DIR = os.path.join(BUNDLE_ROOT, "frontend")

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


class SmartScanCandidatePayload(BaseModel):
    source_type: str
    source_url: str
    source_id: Optional[str] = None
    title: Optional[str] = None
    creator: Optional[str] = None
    cover: Optional[str] = None
    version: Optional[str] = None


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

class CustomTagPayload(BaseModel):
    tag_name: str

class JournalPayload(BaseModel):
    entry_text: str

class TranslatePayload(BaseModel):
    texts: List[str]

@app.get("/api/stats")
def get_stats(db: Session = Depends(get_db)):
    visible_clause = visible_library_entry_clause()
    total = db.query(Game).filter(Game.file_type != "wishlist", Game.is_ignored == False, visible_clause).count()
    identified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == True, Game.is_ignored == False, visible_clause).count()
    unidentified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == False, Game.is_ignored == False, visible_clause).count()
    installed = db.query(Game).filter(Game.file_type.in_(["exe", "folder"]), Game.is_ignored == False, visible_clause).count()
    archives = db.query(Game).filter(Game.file_type == "archive", Game.is_ignored == False, visible_clause).count()
    wishlist = db.query(Game).filter(Game.file_type == "wishlist", Game.is_ignored == False, visible_clause).count()
    s = get_settings()
    return {
        "total": total,
        "identified": identified,
        "unidentified": unidentified,
        "installed": installed,
        "archives": archives,
        "wishlist": wishlist,
        "games_dir": s.get("games_dir", ""),
        "extension_dir": EXTENSION_DIR
    }

class SettingsPayload(BaseModel):
    games_dir: Optional[str] = None
    archive_mode: Optional[str] = None
    startup_scan: Optional[bool] = None
    missing_grace_scans: Optional[int] = None
    auto_update: Optional[bool] = None
    preferred_source: Optional[str] = None

@app.get("/api/settings")
def get_app_settings():
    s = get_settings()
    s["extension_dir"] = EXTENSION_DIR
    return s

@app.post("/api/settings")
def update_app_settings(payload: SettingsPayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    data = {}
    if payload.games_dir is not None:
        data["games_dir"] = payload.games_dir
    if payload.archive_mode is not None:
        data["archive_mode"] = payload.archive_mode
    if payload.startup_scan is not None:
        data["startup_scan"] = payload.startup_scan
    if payload.missing_grace_scans is not None:
        data["missing_grace_scans"] = max(1, int(payload.missing_grace_scans))
    if payload.auto_update is not None:
        data["auto_update"] = payload.auto_update
    if payload.preferred_source is not None:
        data["preferred_source"] = payload.preferred_source
    updated = save_settings(data)
    
    if payload.games_dir is not None:
        try:
            background_tasks.add_task(run_ingestion)
        except Exception:
            pass
            
    updated["extension_dir"] = EXTENSION_DIR
    return {"message": "Settings saved successfully", "settings": updated}

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
        game.title = payload.title
        
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
            subprocess.Popen([r'explorer', '/select,', path])
            return {"message": "Opened containing folder in Explorer", "action": "explorer"}
        else:
            if os.path.isfile(path) and path.lower().endswith('.exe'):
                exe_path = path
            else:
                exe_path = None
                if os.path.isdir(path):
                    for f in os.listdir(path):
                        if f.lower().endswith('.exe') and not f.lower().startswith('unins'):
                            exe_path = os.path.join(path, f)
                            break
                    if not exe_path:
                        subprocess.Popen([r'explorer', path])
                        return {"message": "Opened folder in Explorer (no direct exe found)", "action": "explorer"}
                else:
                    subprocess.Popen([r'explorer', os.path.dirname(path)])
                    return {"message": "Opened folder in Explorer", "action": "explorer"}
                    
            if exe_path:
                os.startfile(exe_path)
                return {"message": f"Launched game: {os.path.basename(exe_path)}", "action": "launch"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to launch/open: {str(e)}")

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
        target.local_version = scanned_item["local_version"] or target.local_version
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
            
    if payload.title:
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
        game.latest_version = payload.latest_version
        if game.local_version:
            clean_local = game.local_version.lower().replace('v', '').replace('ver', '').strip()
            clean_latest = payload.latest_version.lower().replace('v', '').replace('ver', '').strip()
            if clean_latest != clean_local and clean_latest > clean_local:
                game.update_available = True
            else:
                game.update_available = False
        else:
            game.update_available = False
            
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


def run_smart_metadata_scan_job():
    from backend.smart_scan import run_smart_metadata_scan

    run_tracked_metadata_scan_job("smart-scan", run_smart_metadata_scan)


def run_missing_source_metadata_scan_job():
    from backend.smart_scan import run_missing_source_metadata_scan

    run_tracked_metadata_scan_job("missing-source-scan", run_missing_source_metadata_scan)

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

@app.post("/api/library/fetch-all-metadata")
def trigger_fetch_all_metadata(db: Session = Depends(get_db)):
    from backend.scraper import fetch_all_missing_metadata
    count = fetch_all_missing_metadata(db)
    return {"message": f"Successfully scraped metadata for {count} games!"}

@app.get("/api/library/jobs/{job_key}")
def get_library_job(job_key: str):
    return get_job(job_key)

@app.post("/api/library/jobs/{job_key}/cancel")
def cancel_library_job(job_key: str):
    return request_job_cancel(job_key)

@app.post("/api/library/rematch-f95zone")
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

@app.post("/api/library/fix-metadata")
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

@app.post("/api/library/smart-scan")
def trigger_smart_metadata_scan(background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from backend.smart_scan import list_smart_scan_targets

    running_job = any_running_job()
    if running_job and running_job.get("job_key") != "smart-scan":
        raise HTTPException(status_code=409, detail=f'Library job "{running_job.get("label") or running_job.get("job_key")}" is already running')

    current = get_job("smart-scan")
    if current.get("status") == "running":
        return current

    total = len(list_smart_scan_targets(db))
    state = start_job("smart-scan", total, "Smart metadata scan")
    set_job_context(
        "smart-scan",
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
            "smart-scan",
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
                "summary": "Smart scan complete. 0 games processed, 0 metadata entries applied automatically, 0 need review, 0 not found, 0 failed.",
            },
        )
        finish_job(
            "smart-scan",
            "Smart scan complete. 0 games processed, 0 metadata entries applied automatically, 0 need review, 0 not found, 0 failed.",
        )
        return get_job("smart-scan")

    background_tasks.add_task(run_smart_metadata_scan_job)
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

@app.post("/api/library/smart-scan/review/{game_id}/apply")
def apply_smart_scan_review_candidate(
    game_id: int,
    payload: SmartScanCandidatePayload,
    db: Session = Depends(get_db),
):
    from backend.smart_scan import apply_smart_scan_candidate

    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")

    applied = apply_smart_scan_candidate(
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
    return response

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
