import csv
import os
import re
from datetime import datetime
from pathlib import Path
from sqlalchemy.orm import Session
from backend.database import SessionLocal, init_db, Game
from backend.config import get_settings
from backend.scanner import scan_games_directory

CSV_PATH = Path("games_report.csv").resolve()

def normalize_name(name: str) -> str:
    name = re.sub(r'(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|windows|win32|win64|linux|mac\b|edition|complete|deluxe|game|part|chapter|english|translated|archive|rar|zip|7z|\bv\d+\b).*', '', name or '', flags=re.IGNORECASE)
    name = re.sub(r'[\'\"’‘`]', '', name)
    name = re.sub(r'[^a-zA-Z0-9]', ' ', name)
    return ' '.join(name.split()).lower()

def determine_source_info(link_or_id: str):
    if not link_or_id or link_or_id.strip() == "":
        return "unknown", None, None
    
    val = link_or_id.strip()
    
    # Check DLsite ID
    rj_match = re.search(r'([RVB]J\d{6,8})', val, flags=re.IGNORECASE)
    if rj_match or (val.upper().startswith(('RJ', 'VJ', 'BJ')) and len(val) <= 10):
        code = rj_match.group(1).upper() if rj_match else val.upper()
        url = f"https://www.dlsite.com/maniax/work/=/product_id/{code}.html"
        return "dlsite", url, code
        
    # Check F95zone
    if "f95zone.to" in val:
        m = re.search(r'/threads/.*?(\d+)(?:/|$|\?|#)', val)
        tid = m.group(1) if m else None
        clean_url = f"https://f95zone.to/threads/{tid}/" if tid else val
        return "f95zone", clean_url, tid
        
    # Check Itch
    if ".itch.io" in val:
        # Strip devlog, community, or other subpages from URL to get the main game page
        m = re.match(r'(https?://[^/]+\.itch\.io/[^/\?]+)', val)
        clean_url = m.group(1) if m else val
        return "itch", clean_url, None
        
    # Check Steam
    if "steampowered.com" in val or "/app/" in val:
        m = re.search(r'/app/(\d+)', val)
        sid = m.group(1) if m else None
        return "steam", val, sid
        
    return "unknown", val, None

def run_ingestion(db: Session = None):
    close_db = False
    if db is None:
        init_db()
        db = SessionLocal()
        close_db = True
        
    try:
        scan_started_at = datetime.utcnow()
        # Load CSV map: (category, raw_name) -> link_or_id
        csv_map = {}
        if CSV_PATH.exists():
            with open(CSV_PATH, mode='r', encoding='utf-8', errors='replace') as f:
                reader = csv.DictReader(f)
                for row in reader:
                    cat = row.get('Category', '').strip()
                    raw = row.get('Local Folder/File', '').strip()
                    link = row.get('Import Link / ID', '').strip()
                    if raw:
                        csv_map[(cat, raw)] = link
                        # Also index by just raw name as fallback
                        csv_map[raw] = link
                        
        # Scan filesystem
        scanned_items = scan_games_directory()
        scanned_paths = set()
        
        added_count = 0
        updated_count = 0
        
        for item in scanned_items:
            cat = item["category"]
            raw = item["raw_name"]
            folder_path = item["folder_path"]
            scanned_paths.add(folder_path)
            
            # Look up link in CSV map, fallback to raw string (in case the folder name itself is an RJ code)
            link_or_id = csv_map.get((cat, raw)) or csv_map.get(raw) or raw
            source_type, source_url, source_id = determine_source_info(link_or_id)
            
            is_identified = source_type != "unknown" and source_url is not None
            
            # Check if game already exists in DB
            game = db.query(Game).filter(Game.folder_path == folder_path).first()
            if not game:
                # Also check by raw_name if folder path changed slightly
                game = db.query(Game).filter(Game.raw_name == raw).first()
            if not game:
                # Check for wishlist graduation (perfect title match)
                game = db.query(Game).filter(Game.file_type == "wishlist", Game.title == item["title"]).first()
            if not game and source_id:
                # Deduplication fallback: if the new folder is a DLsite code (RJ01105757), 
                # check if there's an existing orphaned archive with that same source_id!
                game = db.query(Game).filter(Game.source_id == source_id).first()
                
            if game:
                # Update existing (prefer folder/exe over archive)
                if not game.title:
                    game.title = item["title"]
                if game.raw_name.startswith('wishlist_'):
                    game.raw_name = raw
                game.category = cat
                if game.file_type == 'archive' or item["file_type"] in ('exe', 'folder'):
                    game.folder_path = folder_path
                    game.file_type = item["file_type"]
                if item["archive_name"]:
                    game.archive_name = item["archive_name"]
                if not game.size_bytes or item["file_type"] in ('exe', 'folder'):
                    game.size_bytes = item["size_bytes"]
                if not game.local_version and item["local_version"]:
                    game.local_version = item["local_version"]
                if not game.is_identified and is_identified:
                    game.source_type = source_type
                    game.source_url = source_url
                    game.source_id = source_id
                    game.is_identified = True
                game.last_seen_at = scan_started_at
                game.missing_scan_count = 0
                updated_count += 1
            else:
                # Create new
                new_game = Game(
                    title=item["title"],
                    raw_name=raw,
                    category=cat,
                    folder_path=folder_path,
                    file_type=item["file_type"],
                    archive_name=item["archive_name"],
                    size_bytes=item["size_bytes"],
                    local_version=item["local_version"],
                    source_type=source_type,
                    source_url=source_url,
                    source_id=source_id,
                    is_identified=is_identified,
                    last_seen_at=scan_started_at,
                    missing_scan_count=0
                )
                db.add(new_game)
                added_count += 1
                
        db.commit()
        dups_removed = deduplicate_games(db)
        
        # Cleanup orphaned games that were deleted from disk, but only after repeated misses.
        settings = get_settings()
        missing_grace_scans = max(1, int(settings.get("missing_grace_scans", 3) or 3))
        all_games = db.query(Game).filter(Game.file_type != 'wishlist').all()
        orphaned_removed = 0
        for g in all_games:
            if g.folder_path in scanned_paths:
                g.last_seen_at = scan_started_at
                g.missing_scan_count = 0
                continue
            if g.folder_path and os.path.exists(g.folder_path):
                g.last_seen_at = scan_started_at
                g.missing_scan_count = 0
                continue

            g.missing_scan_count = (g.missing_scan_count or 0) + 1
            if g.missing_scan_count >= missing_grace_scans:
                db.delete(g)
                orphaned_removed += 1
        db.commit()
        
        print(f"Ingestion complete: {added_count} added, {updated_count} updated, {dups_removed} duplicates merged, {orphaned_removed} dead entries removed.")
        return {"added": added_count, "updated": updated_count, "duplicates_removed": dups_removed, "orphans_removed": orphaned_removed}
    finally:
        if close_db:
            db.close()

def clean_base_title(name: str) -> str:
    if not name: return ""
    n = re.sub(r'(\bv\d+.*|\b\d+b\b|rev\d+|fixed|ver\b.*|windows|linux|mac|edition|complete|deluxe|english|translated|archive|rar|zip|7z|wt|mod|cheat|walkthrough|patch).*', '', name, flags=re.IGNORECASE).strip()
    n = re.sub(r'[\'\"’‘`]', '', n)
    n = re.sub(r'[^a-zA-Z0-9]', ' ', n)
    return ' '.join(n.split()).lower()

def normalized_source_key(game: Game):
    source_type = (game.source_type or "unknown").lower()
    if game.source_id:
        return ("source_id", source_type, game.source_id.lower())
    if game.source_url and source_type != "unknown":
        return ("source_url", source_type, game.source_url.lower())
    return None

def is_metadata_rich(game: Game) -> bool:
    developer = (game.developer or "").strip().lower()
    has_named_developer = developer not in ("", "unknown", "unknown dev", "unknown dev / circle")
    return bool(
        game.cover_url
        or has_named_developer
        or game.description
        or (game.rating and game.rating != "N/A")
        or len(game.screenshots) > 0
    )

def should_merge_title_group(grouped_games: list[Game]) -> bool:
    playable_games = [g for g in grouped_games if g.file_type != "wishlist"]
    if len(playable_games) < 2:
        return False

    has_archive = any(g.file_type == "archive" for g in playable_games)
    has_launchable = any(g.file_type in ("exe", "folder") for g in playable_games)
    if not (has_archive and has_launchable):
        return False

    strong_games = [g for g in playable_games if is_metadata_rich(g)]
    weak_games = [g for g in playable_games if not is_metadata_rich(g)]
    if not strong_games or not weak_games:
        return False

    strong_source_keys = {normalized_source_key(g) for g in strong_games if normalized_source_key(g)}
    if len(strong_source_keys) > 1:
        return False

    return True

def deduplicate_games(db: Session) -> int:
    games = db.query(Game).all()
    duplicate_keys = {}
    for g in games:
        if g.source_id:
            key = ("source_id", (g.source_type or "unknown").lower(), g.source_id.lower())
            duplicate_keys.setdefault(key, []).append(g)
        elif g.source_url and g.source_type != "unknown":
            key = ("source_url", (g.source_type or "unknown").lower(), g.source_url.lower())
            duplicate_keys.setdefault(key, []).append(g)
        elif g.file_type == "wishlist" and g.source_url:
            key = ("wishlist_source_url", g.source_url.lower())
            duplicate_keys.setdefault(key, []).append(g)
        if g.file_type != "wishlist":
            base_title = clean_base_title(g.title or g.raw_name)
            if base_title:
                duplicate_keys.setdefault(("base_title", base_title), []).append(g)

    removed = 0
    removed_ids = set()
    for key, grouped_games in duplicate_keys.items():
        grouped_games = [g for g in grouped_games if g.id not in removed_ids]
        if len(grouped_games) < 2:
            continue
        if key[0] == "base_title" and not should_merge_title_group(grouped_games):
            continue

        grouped_games.sort(
            key=lambda x: (
                x.file_type != "wishlist",
                x.file_type in ("exe", "folder"),
                is_metadata_rich(x),
                bool(x.cover_url),
                bool(x.source_url),
                -(x.missing_scan_count or 0),
            ),
            reverse=True,
        )
        primary = grouped_games[0]
        for dup in grouped_games[1:]:
            if dup.id in removed_ids:
                continue
            merged = merge_game_records(primary, dup, db)
            if merged:
                removed += merged
                removed_ids.add(dup.id)
    db.commit()
    return removed

def merge_game_records(primary: Game, duplicate: Game, db: Session) -> int:
    if primary.id == duplicate.id:
        return 0

    for field in (
        "title",
        "developer",
        "description",
        "cover_url",
        "rating",
        "release_date",
        "local_version",
        "latest_version",
        "archive_name",
    ):
        if not getattr(primary, field) and getattr(duplicate, field):
            setattr(primary, field, getattr(duplicate, field))

    if primary.file_type == "archive" and duplicate.file_type in ("exe", "folder"):
        primary.folder_path = duplicate.folder_path
        primary.file_type = duplicate.file_type

    if not primary.source_url and duplicate.source_url:
        primary.source_url = duplicate.source_url
        primary.source_type = duplicate.source_type
        primary.source_id = duplicate.source_id
        primary.is_identified = duplicate.is_identified

    primary.last_seen_at = max(
        [dt for dt in [primary.last_seen_at, duplicate.last_seen_at] if dt is not None],
        default=primary.last_seen_at or duplicate.last_seen_at,
    )
    primary.missing_scan_count = min(primary.missing_scan_count or 0, duplicate.missing_scan_count or 0)

    existing_screenshots = {s.url for s in primary.screenshots}
    for screenshot in list(duplicate.screenshots):
        if screenshot.url not in existing_screenshots:
            screenshot.game_id = primary.id
            existing_screenshots.add(screenshot.url)
        else:
            db.delete(screenshot)

    existing_tags = {t.tag_name for t in primary.tags}
    for tag in list(duplicate.tags):
        if tag.tag_name not in existing_tags:
            tag.game_id = primary.id
            existing_tags.add(tag.tag_name)
        else:
            db.delete(tag)

    existing_custom_tags = {t.tag_name for t in primary.custom_tags}
    for tag in list(duplicate.custom_tags):
        if tag.tag_name not in existing_custom_tags:
            tag.game_id = primary.id
            existing_custom_tags.add(tag.tag_name)
        else:
            db.delete(tag)

    for journal_entry in list(duplicate.journal_entries):
        journal_entry.game_id = primary.id

    db.delete(duplicate)
    return 1

if __name__ == "__main__":
    run_ingestion()
