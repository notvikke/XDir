import os
import re
from datetime import datetime
from pathlib import Path


IGNORED_EXE_PATTERNS = (
    "unins",
    "uninstall",
    "setup",
    "vc_redist",
    "dxsetup",
    "crashhandler",
    "unitycrashhandler",
    "notification_helper",
    "updater",
)


def _normalize_label(value: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", " ", str(value or "").lower())
    return " ".join(cleaned.split())


def _looks_ignored_executable(name: str) -> bool:
    normalized = _normalize_label(Path(name).stem)
    return any(pattern in normalized.replace(" ", "") for pattern in IGNORED_EXE_PATTERNS)


def _score_executable_candidate(executable_path: Path, folder_name: str) -> tuple[int, int, int, str]:
    stem = executable_path.stem
    normalized_stem = _normalize_label(stem)
    normalized_folder = _normalize_label(folder_name)
    folder_tokens = [token for token in normalized_folder.split() if len(token) >= 3]

    exact_match = int(normalized_stem == normalized_folder and bool(normalized_folder))
    token_matches = sum(1 for token in folder_tokens if token in normalized_stem)
    looks_generic_launcher = int(normalized_stem in {"launcher", "start", "game", "play"})

    try:
        size_bytes = executable_path.stat().st_size
    except Exception:
        size_bytes = 0

    return (
        exact_match,
        token_matches,
        -looks_generic_launcher,
        size_bytes,
        executable_path.name.lower(),
    )


def choose_launch_executable(target_path: str | os.PathLike[str]) -> Path | None:
    candidate = Path(target_path).expanduser()
    if not candidate.exists():
        return None

    if candidate.is_file():
        return candidate.resolve() if candidate.suffix.lower() == ".exe" else None

    if not candidate.is_dir():
        return None

    executables = []
    for entry in candidate.iterdir():
        if not entry.is_file() or entry.suffix.lower() != ".exe":
            continue
        if _looks_ignored_executable(entry.name):
            continue
        executables.append(entry)

    if not executables:
        return None

    folder_name = candidate.name
    executables.sort(key=lambda path: _score_executable_candidate(path, folder_name), reverse=True)
    return executables[0].resolve()


def calculate_session_seconds(started_at: datetime, ended_at: datetime) -> int:
    if not started_at or not ended_at:
        return 0
    return max(0, int((ended_at - started_at).total_seconds()))


def accumulate_playtime(
    existing_total_seconds: int | None,
    existing_session_count: int | None,
    started_at: datetime,
    ended_at: datetime,
) -> tuple[int, int, datetime]:
    session_seconds = calculate_session_seconds(started_at, ended_at)
    total_seconds = max(0, int(existing_total_seconds or 0)) + session_seconds
    session_count = max(0, int(existing_session_count or 0)) + 1
    return total_seconds, session_count, started_at
