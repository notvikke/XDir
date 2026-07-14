import os
import json
from pathlib import Path
from backend.runtime import get_data_root, migrate_legacy_data_file

SETTINGS_FILE = os.path.join(get_data_root(), "settings.json")
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

def get_settings() -> dict:
    defaults = {
        "games_dir": get_default_games_dir(),
        "archive_mode": "explorer",
        "startup_scan": True,
        "missing_grace_scans": 3,
        "auto_update": True,
        "automatic_update_checks": True,
        "update_check_interval_days": 7,
        "last_update_check_at": None,
        "preferred_source": "f95zone",
    }
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                defaults.update(data)
        except Exception:
            pass
    return defaults

def save_settings(new_settings: dict) -> dict:
    current = get_settings()
    current.update(new_settings)
    try:
        os.makedirs(os.path.dirname(SETTINGS_FILE), exist_ok=True)
        with open(SETTINGS_FILE, "w", encoding="utf-8") as f:
            json.dump(current, f, indent=2)
    except Exception as e:
        print("Failed to save settings:", e)
    return current

def get_games_dir() -> Path:
    s = get_settings()
    return Path(s.get("games_dir", get_default_games_dir()))
