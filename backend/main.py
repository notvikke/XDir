import os
import subprocess
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, Depends, HTTPException, Query, Body, BackgroundTasks, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session
from pydantic import BaseModel
from pathlib import Path

from backend.database import get_db, init_db, Game, Screenshot, Tag, CustomTag, JournalEntry
from backend.scanner import inspect_archive
from backend.ingest import run_ingestion, determine_source_info
from backend.config import get_settings, save_settings, get_games_dir
from backend.runtime import get_app_root

app = FastAPI(title="XDir API", version="1.0.0")
APP_ROOT = get_app_root()
EXTENSION_DIR = os.path.join(APP_ROOT, "extension")
FRONTEND_DIR = os.path.join(APP_ROOT, "frontend")

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
    total = db.query(Game).filter(Game.file_type != "wishlist", Game.is_ignored == False).count()
    identified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == True, Game.is_ignored == False).count()
    unidentified = db.query(Game).filter(Game.file_type != "wishlist", Game.is_identified == False, Game.is_ignored == False).count()
    installed = db.query(Game).filter(Game.file_type.in_(["exe", "folder"]), Game.is_ignored == False).count()
    archives = db.query(Game).filter(Game.file_type == "archive", Game.is_ignored == False).count()
    wishlist = db.query(Game).filter(Game.file_type == "wishlist", Game.is_ignored == False).count()
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
    query = db.query(Game)
    
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
    games = db.query(Game).filter(Game.is_identified == True, Game.cover_url == None).limit(20).all()
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
        
    return game.to_dict()

@app.delete("/api/games/{game_id}/custom_tags/{tag_name}")
def delete_custom_tag(game_id: int, tag_name: str, db: Session = Depends(get_db)):
    ct = db.query(CustomTag).filter(CustomTag.game_id == game_id, CustomTag.tag_name == tag_name).first()
    if ct:
        db.delete(ct)
        db.commit()
    game = db.query(Game).filter(Game.id == game_id).first()
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
    db.commit()
    
    # Auto-fetch metadata after linking
    try:
        from backend.scraper import fetch_game_metadata
        fetch_game_metadata(game, db, force_overwrite=True)
    except Exception:
        pass
    
    db.refresh(game)
    return {"message": f"Game linked to {source_type.upper()} and metadata fetched!", "game": game.to_dict()}

@app.post("/api/games/{game_id}/clear-source")
def clear_game_source(game_id: int, db: Session = Depends(get_db)):
    """Wipe a game's source data so it can be re-identified from scratch."""
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    
    game.source_type = "unknown"
    game.source_url = None
    game.source_id = None
    game.cover_url = None
    game.description = None
    game.developer = None
    game.latest_version = None
    game.is_identified = False
    game.update_available = False
    
    # Clear screenshots and scraped tags
    for s in list(game.screenshots):
        db.delete(s)
    for t in list(game.tags):
        db.delete(t)
    
    db.commit()
    db.refresh(game)
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
            
    # If a real game was updated, clean up any redundant wishlist entry with the same source_id
    if game.file_type != 'wishlist' and game.source_id:
        dups = db.query(Game).filter(Game.source_id == game.source_id, Game.file_type == 'wishlist').all()
        for d in dups:
            db.delete(d)
        if dups:
            db.commit()
            
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
                
    db.commit()
    return {"message": "Metadata updated successfully", "game": game.to_dict()}

class WishlistPayload(BaseModel):
    url: str

@app.post("/api/games/wishlist")
def add_to_wishlist(payload: WishlistPayload, background_tasks: BackgroundTasks, db: Session = Depends(get_db)):
    from backend.ingest import determine_source_info
    source_type, source_url, source_id = determine_source_info(payload.url)
    if source_type == "unknown" or not source_url:
        raise HTTPException(status_code=400, detail="Invalid URL. Supported: F95Zone, DLsite, Itch.io, Steam")
        
    import time
    stamp = str(int(time.time()))
    game = Game(
        title="Wishlist Item (" + source_type + ")",
        raw_name="wishlist_" + stamp,
        category="Wishlist",
        folder_path="wishlist_" + stamp,
        file_type="wishlist",
        source_type=source_type,
        source_url=source_url,
        source_id=source_id,
        is_identified=True
    )
    db.add(game)
    db.commit()
    db.refresh(game)
    
    def bg_scrape_wishlist(gid: int):
        from backend.database import SessionLocal, Game
        from backend.scraper import fetch_game_metadata
        bg_db = SessionLocal()
        try:
            g = bg_db.query(Game).filter(Game.id == gid).first()
            if g:
                fetch_game_metadata(g, bg_db, force_overwrite=True)
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
    return {"message": "Game ignored status updated", "game": game.to_dict()}

@app.delete("/api/games/{game_id}")
def delete_game(game_id: int, db: Session = Depends(get_db)):
    game = db.query(Game).filter(Game.id == game_id).first()
    if not game:
        raise HTTPException(status_code=404, detail="Game not found")
    db.delete(game)
    db.commit()
    return {"message": "Game deleted successfully"}


# Extension Status & Heartbeat Tracking
import time
from backend.scraper import fetch_game_metadata, fetch_all_missing_metadata

EXTENSION_STATUS = {"connected": False, "last_ping": 0, "version": "Unknown", "last_sync_trigger": 0}

class ExtensionPingPayload(BaseModel):
    version: Optional[str] = "1.0.0"

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
        return {"message": "Metadata fetched successfully", "game": updated.to_dict()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/library/fetch-all-metadata")
def trigger_fetch_all_metadata(db: Session = Depends(get_db)):
    from backend.scraper import fetch_all_missing_metadata
    count = fetch_all_missing_metadata(db)
    return {"message": f"Successfully scraped metadata for {count} games!"}

@app.post("/api/library/rematch-f95zone")
def trigger_rematch_f95zone(db: Session = Depends(get_db)):
    from backend.scraper import rematch_and_scrape_f95zone
    res = rematch_and_scrape_f95zone(db)
    EXTENSION_STATUS["last_sync_trigger"] = 0  # Force immediate sync on next extension ping
    res["message"] += " Chrome extension logged-in queue syncing has also been triggered in the background."
    return res

@app.post("/api/library/fix-metadata")
def trigger_fix_metadata(db: Session = Depends(get_db)):
    from backend.scraper import fix_all_titles_and_metadata
    res = fix_all_titles_and_metadata(db)
    EXTENSION_STATUS["last_sync_trigger"] = 0
    return res

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
