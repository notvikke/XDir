import os
import shutil
import sys


def get_app_root() -> str:
    if getattr(sys, "frozen", False):
        return os.path.dirname(os.path.abspath(sys.executable))
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def get_bundle_root() -> str:
    if getattr(sys, "frozen", False):
        meipass = getattr(sys, "_MEIPASS", None)
        if meipass:
            return os.path.abspath(meipass)
        return get_app_root()
    return get_app_root()


def get_data_root() -> str:
    data_root = os.path.join(get_app_root(), "data")
    os.makedirs(data_root, exist_ok=True)
    return data_root


def migrate_legacy_data_file(legacy_relative_path: str, target_path: str) -> None:
    legacy_path = os.path.join(get_app_root(), legacy_relative_path)
    if not os.path.exists(legacy_path) or os.path.exists(target_path):
        return
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    shutil.copy2(legacy_path, target_path)


def migrate_legacy_data_directory(legacy_relative_path: str, target_path: str) -> None:
    legacy_path = os.path.join(get_app_root(), legacy_relative_path)
    if not os.path.isdir(legacy_path) or os.path.exists(target_path):
        return
    os.makedirs(os.path.dirname(target_path), exist_ok=True)
    shutil.copytree(legacy_path, target_path)
