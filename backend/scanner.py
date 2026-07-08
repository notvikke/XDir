import os
import re
import zipfile
from pathlib import Path
from typing import List, Dict, Any, Optional
from backend.config import get_games_dir

ROOT_DIR = get_games_dir()

def clean_name(name: str) -> Dict[str, str]:
    # Check for exact RJ/BJ/VJ code anywhere in string
    rj_match = re.search(r'([R|B|V]J\d{6,8})', name, flags=re.IGNORECASE)
    if rj_match:
        return {"type": "dlsite_id", "value": rj_match.group(1).upper(), "raw": name}
    
    # Check for URLs if any
    url_match = re.search(r'(https?://[^\s]+)', name)
    if url_match:
        return {"type": "url", "value": url_match.group(1), "raw": name}

    # Remove file extensions
    cleaned = re.sub(r'\.(zip|rar|7z|exe|tar|gz|bz2|iso)$', '', name, flags=re.IGNORECASE)
    # Remove square brackets and parentheses content like [FitGirl Repack], (1), (f95), [ENG], etc.
    cleaned = re.sub(r'\[.*?\]|\(.*?\)', ' ', cleaned)
    # Remove version numbers
    cleaned = re.sub(r'\b(v|ver|rev|build|eng|ver\.)[\s\._-]*\d+[\d\._-]*\b', ' ', cleaned, flags=re.IGNORECASE)
    # Remove common words
    cleaned = re.sub(r'\b(win|english|eng|ai|append|repack|repacks|x64|x86|pc|final|game|fixed|patched|complete|edition|mod|dlc|dlcs|demo|gog)\b', ' ', cleaned, flags=re.IGNORECASE)
    # Replace underscores, hyphens, and dots with spaces
    cleaned = re.sub(r'[_\-\.]+', ' ', cleaned)
    # Collapse multiple spaces
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    
    return {"type": "search_query", "value": cleaned, "raw": name}

def parse_version(name: str) -> Optional[str]:
    # Match version patterns like v1.08, ver.1.2.3, v2.05, 1.0.5, etc.
    patterns = [
        r'\b(v|ver|rev|build)[\s\._-]*(\d+[\d\._-]*\d|\d+)\b',
        r'[\s_\-\.]v(\d+(\.\d+)+)',
        r'[\s_\-\.](\d+\.\d+(\.\d+)?)(?:[\s_\-\.]|$)'
    ]
    for p in patterns:
        m = re.search(p, name, flags=re.IGNORECASE)
        if m:
            val = m.group(2) if len(m.groups()) >= 2 and m.group(2) else m.group(1)
            val = val.strip('._- ')
            if not val.lower().startswith('v'):
                return f"v{val}"
            return val.lower()
    return None

def inspect_archive(file_path: Path) -> List[str]:
    """Inspect contents of zip archives without extracting."""
    if not file_path.name.lower().endswith('.zip'):
        return []
    try:
        with zipfile.ZipFile(file_path, 'r') as zf:
            names = zf.namelist()
            # Return up to 10 executable or interesting files
            interesting = [n for n in names if n.lower().endswith(('.exe', '.html', '.bat', '.txt', '.pdf', '.url'))]
            return interesting[:10]
    except Exception:
        return []

def is_category_folder(folder_name: str) -> bool:
    lower = folder_name.lower()
    return any(k in lower for k in ['dlsite', 'itch', 'f95', 'games', 'setups', 'vn', 'visual novel', 'legit', 'series', 'collection', 'pack', 'bundle', 'franchise', 'anthology'])

def scan_games_directory(root_path: Optional[Path] = None) -> List[Dict[str, Any]]:
    results = []
    if root_path is None:
        root_path = get_games_dir()
    if not root_path.exists():
        return results

    for item in sorted(os.listdir(root_path)):
        item_path = root_path / item
        if item_path.is_file():
            if item.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                results.append(_create_entry(root_path.name, item_path))
        elif item_path.is_dir():
            if is_category_folder(item):
                for subitem in sorted(os.listdir(item_path)):
                    sub_path = item_path / subitem
                    if sub_path.is_file() and subitem.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                        results.append(_create_entry(item, sub_path))
                    elif sub_path.is_dir():
                        results.append(_create_entry(item, sub_path))
            else:
                subfiles = os.listdir(item_path)
                has_archives = any(f.lower().endswith(('.zip', '.rar', '.7z')) for f in subfiles if (item_path / f).is_file())
                is_explicit_series = any(f.lower() in ('.xdir_series', '.xdir_category') for f in subfiles)
                
                if has_archives or is_explicit_series:
                    for subitem in sorted(subfiles):
                        sub_path = item_path / subitem
                        if sub_path.is_file() and subitem.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
                            results.append(_create_entry(item, sub_path))
                        elif sub_path.is_dir():
                            results.append(_create_entry(item, sub_path))
                else:
                    # Auto-detect if it's a series folder (e.g. "Rance" containing "Rance 1", "Rance 2")
                    has_root_exe = any(f.lower().endswith(('.exe', '.html', '.swf')) for f in subfiles if (item_path / f).is_file())
                    subdirs = [f for f in subfiles if (item_path / f).is_dir()]
                    
                    platform_names = {'windows', 'win', 'mac', 'linux', 'www', 'game', 'data', 'build', 'release', 'renpy', 'src', 'app'}
                    looks_like_game_internals = any(d.lower() in platform_names for d in subdirs)
                    
                    valid_game_subdirs = 0
                    for d in subdirs:
                        d_path = item_path / d
                        try:
                            d_files = os.listdir(d_path)
                            if any(df.lower().endswith(('.exe', '.html', '.swf', '.zip', '.rar', '.7z')) for df in d_files):
                                valid_game_subdirs += 1
                        except: pass
                        
                    if not has_root_exe and valid_game_subdirs >= 2 and not looks_like_game_internals:
                        # Auto-detected as a series folder containing multiple games
                        for subitem in sorted(subdirs):
                            results.append(_create_entry(item, item_path / subitem))
                    elif not has_root_exe and valid_game_subdirs == 1 and len(subdirs) > 1 and not looks_like_game_internals:
                        # Auto-detected series, but maybe only 1 game has an exe right now
                        # Check if the other folders might be other games (just without exes)
                        for subitem in sorted(subdirs):
                            results.append(_create_entry(item, item_path / subitem))
                    else:
                        results.append(_create_entry(root_path.name, item_path))

    return results

def scan_single_game_path(selected_path: str) -> Optional[Dict[str, Any]]:
    if not selected_path:
        return None

    item_path = Path(selected_path).expanduser()
    if not item_path.exists():
        return None

    if item_path.is_file() and not item_path.name.lower().endswith(('.zip', '.rar', '.7z', '.iso', '.exe')):
        return None

    try:
        games_root = get_games_dir().resolve()
    except Exception:
        games_root = None

    category = item_path.parent.name or "Manual"
    if games_root and item_path.parent == games_root:
        category = games_root.name

    return _create_entry(category, item_path)

def _create_entry(category: str, item_path: Path) -> Dict[str, Any]:
    name = item_path.name
    cleaned_info = clean_name(name)
    title = cleaned_info["value"]
    if not title:
        title = name
        
    is_file = item_path.is_file()
    size_bytes = item_path.stat().st_size if is_file else 0
    
    if is_file and name.lower().endswith(('.zip', '.rar', '.7z', '.iso')):
        file_type = "archive"
        archive_name = name
    elif is_file and name.lower().endswith('.exe'):
        file_type = "exe"
        archive_name = None
    else:
        file_type = "folder"
        archive_name = None
        # Check if folder contains an exe
        if item_path.is_dir():
            try:
                for f in os.listdir(item_path):
                    if f.lower().endswith('.exe'):
                        file_type = "exe"
                        break
            except Exception:
                pass

    version = parse_version(name)
    
    return {
        "title": title,
        "raw_name": name,
        "category": category,
        "folder_path": str(item_path.resolve()),
        "file_type": file_type,
        "archive_name": archive_name,
        "size_bytes": size_bytes,
        "local_version": version,
        "cleaned_info": cleaned_info
    }
