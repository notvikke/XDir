import os
import json
from pathlib import Path
from typing import Iterable
from backend.runtime import get_data_root, migrate_legacy_data_file

SETTINGS_FILE = os.path.join(get_data_root(), "settings.json")
DEPRECATED_SETTINGS = {"auto_update"}
PERSISTENT_SETTINGS = {
    "games_dir",
    "games_dirs",
    "archive_mode",
    "startup_scan",
    "missing_grace_scans",
    "preferred_source",
    "automatic_game_update_checks",
    "game_update_check_interval_days",
    "last_game_update_check_at",
    "last_full_metadata_refresh_at",
    "theme_mode",
    "accent_color",
}
migrate_legacy_data_file(os.path.join("backend", "settings.json"), SETTINGS_FILE)

def get_default_games_dir() -> str:
    if os.path.exists(r"D:\Game setups"):
        return r"D:\Game setups"
    home_games = os.path.join(os.path.expanduser("~"), "Games")
    if not os.path.exists(home_games):
        try:
            os.makedirs(home_games, exist_ok=True)
        except Exception:
            pass
    return home_games


def _normalize_directory_string(value) -> str | None:
    raw = str(value or "").strip()
    if not raw:
        return None
    return os.path.normpath(os.path.expanduser(raw))


def normalize_games_dirs(
    raw_dirs: Iterable[str] | str | None,
    fallback_dir: str | None = None,
    *,
    require_at_least_one: bool = True,
) -> list[str]:
    normalized: list[str] = []
    seen: set[str] = set()

    def add(candidate) -> None:
        clean = _normalize_directory_string(candidate)
        if not clean:
            return
        key = os.path.normcase(clean)
        if key in seen:
            return
        seen.add(key)
        normalized.append(clean)

    if isinstance(raw_dirs, (str, os.PathLike)):
        add(raw_dirs)
    else:
        for candidate in list(raw_dirs or []):
            add(candidate)

    if fallback_dir:
        add(fallback_dir)

    if require_at_least_one and not normalized:
        add(get_default_games_dir())

    return normalized

def get_settings() -> dict:
    default_games_dir = get_default_games_dir()
    defaults = {
        "games_dir": default_games_dir,
        "games_dirs": [default_games_dir],
        "archive_mode": "explorer",
        "startup_scan": True,
        "missing_grace_scans": 3,
        "automatic_game_update_checks": True,
        "game_update_check_interval_days": 7,
        "last_game_update_check_at": None,
        "last_full_metadata_refresh_at": None,
        "preferred_source": "f95zone",
        "theme_mode": "midnight",
        "accent_color": "blue",
    }
    loaded_settings = {}
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                loaded_settings = json.load(f)
                loaded_settings = {
                    key: value
                    for key, value in loaded_settings.items()
                    if key in PERSISTENT_SETTINGS and key not in DEPRECATED_SETTINGS
                }
                defaults.update(loaded_settings)
        except Exception:
            pass

    normalized_dirs = normalize_games_dirs(
        loaded_settings.get("games_dirs") if "games_dirs" in loaded_settings else None,
        loaded_settings.get("games_dir", defaults.get("games_dir")),
        require_at_least_one=True,
    )
    defaults["games_dirs"] = normalized_dirs
    defaults["games_dir"] = normalized_dirs[0] if normalized_dirs else ""
    return defaults

def save_settings(new_settings: dict) -> dict:
    new_settings = {
        key: value
        for key, value in dict(new_settings or {}).items()
        if key in PERSISTENT_SETTINGS and key not in DEPRECATED_SETTINGS
    }
    current = get_settings()
    if "games_dir" in new_settings and "games_dirs" not in new_settings:
        existing_dirs = normalize_games_dirs(
            current.get("games_dirs"),
            current.get("games_dir"),
            require_at_least_one=True,
        )
        new_settings = dict(new_settings)
        new_settings["games_dirs"] = normalize_games_dirs(
            [new_settings.get("games_dir"), *existing_dirs],
            require_at_least_one=True,
        )
    explicit_games_dirs = "games_dirs" in new_settings
    current.update(new_settings)
    current["games_dirs"] = normalize_games_dirs(
        current.get("games_dirs"),
        None if explicit_games_dirs else current.get("games_dir"),
        require_at_least_one=True,
    )
    current["games_dir"] = current["games_dirs"][0] if current["games_dirs"] else ""
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2)
    except Exception as e:
        print("Failed to save settings:", e)
    return current

def get_games_dirs() -> list[Path]:
    s = get_settings()
    return [Path(path) for path in list(s.get("games_dirs", []))]

def get_games_dir() -> Path:
    s = get_settings()
    return Path(s.get("games_dir", get_default_games_dir()))


def is_path_within_games_dirs(target_path: str | os.PathLike[str], games_dirs: Iterable[str | os.PathLike[str]] | None = None) -> bool:
    try:
        candidate = Path(target_path).expanduser().resolve()
    except Exception:
        return False

    configured_dirs = games_dirs if games_dirs is not None else get_games_dirs()
    for root_value in list(configured_dirs or []):
        try:
            root = Path(root_value).expanduser().resolve()
        except Exception:
            continue
        if candidate == root or root in candidate.parents:
            return True
    return False
