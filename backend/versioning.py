from dataclasses import dataclass
from datetime import datetime, timezone
import json
import re
import time
from typing import Callable, Iterable, Optional
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup


@dataclass(frozen=True)
class NormalizedVersion:
    raw: str
    canonical: str
    kind: str
    numbers: tuple[int, ...]
    prerelease: Optional[str] = None
    letter_revision: Optional[str] = None
    qualifier: Optional[str] = None


@dataclass(frozen=True)
class VersionComparison:
    status: str
    local_version: Optional[str]
    remote_version: Optional[str]
    comparable: bool
    comparison: Optional[int]
    reason: str

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "local_version": self.local_version,
            "remote_version": self.remote_version,
            "comparable": self.comparable,
            "comparison": self.comparison,
            "reason": self.reason,
        }


@dataclass(frozen=True)
class UpdateSource:
    source_type: str
    source_url: Optional[str]
    source_id: Optional[str]


@dataclass(frozen=True)
class UpdateCheckResult:
    status: str
    local_version: Optional[str]
    latest_version: Optional[str]
    checked_at: datetime
    source_type: str
    source_url: Optional[str]
    comparable: bool = False
    comparison: Optional[int] = None
    reason: str = ""
    error: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "status": self.status,
            "local_version": self.local_version,
            "latest_version": self.latest_version,
            "checked_at": self.checked_at.isoformat(),
            "source_type": self.source_type,
            "source_url": self.source_url,
            "comparable": self.comparable,
            "comparison": self.comparison,
            "reason": self.reason,
            "error": self.error,
        }


_COUNTER_NAMES = {
    "build": "build",
    "chapter": "chapter",
    "episode": "episode",
    "revision": "revision",
    "rev": "revision",
    "patch": "patch",
}
_PRERELEASE_ALIASES = {
    "a": "alpha",
    "alpha": "alpha",
    "b": "beta",
    "beta": "beta",
    "rc": "rc",
    "preview": "preview",
    "pre": "preview",
    "demo": "demo",
}
_PRERELEASE_RANK = {
    "demo": 0,
    "preview": 1,
    "alpha": 2,
    "beta": 3,
    "rc": 4,
}
_STABLE_WORDS = {"final", "stable", "release", "released"}
UPDATE_CHECK_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.9",
}
SUPPORTED_UPDATE_SOURCES = {"f95zone", "dlsite", "itch"}
KNOWN_UPDATE_SOURCES = SUPPORTED_UPDATE_SOURCES | {"steam"}


def utc_now() -> datetime:
    """Return UTC as a naive datetime for compatibility with existing SQLite rows."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _clean_display(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    clean = re.sub(r"\s+", " ", str(value).strip())
    return clean or None


def _trim_numeric_components(numbers: tuple[int, ...]) -> tuple[int, ...]:
    values = list(numbers)
    while len(values) > 1 and values[-1] == 0:
        values.pop()
    return tuple(values)


def _compare_number_sequences(left: tuple[int, ...], right: tuple[int, ...]) -> int:
    width = max(len(left), len(right))
    padded_left = left + (0,) * (width - len(left))
    padded_right = right + (0,) * (width - len(right))
    return (padded_left > padded_right) - (padded_left < padded_right)


def normalize_version(value: Optional[str]) -> Optional[NormalizedVersion]:
    raw = _clean_display(value)
    if not raw:
        return None

    canonical = raw.casefold()
    canonical = canonical.replace("_", ".")
    canonical = re.sub(r"\bver(?:sion)?\.?\s*", "", canonical, count=1)
    canonical = re.sub(r"^v(?=\d)", "", canonical)
    canonical = re.sub(r"\s*[-–—/]\s*", ".", canonical)
    canonical = re.sub(r"\s+", " ", canonical).strip(" .")

    date_match = re.fullmatch(r"(\d{4})\.(\d{1,2})\.(\d{1,2})", canonical)
    if date_match:
        numbers = tuple(int(part) for part in date_match.groups())
        return NormalizedVersion(raw, ".".join(str(part) for part in numbers), "date", numbers)

    counter_match = re.match(r"^(build|chapter|episode|revision|rev|patch)\s*\.?\s*(\d+(?:\.\d+)*)\b(.*)$", canonical)
    kind = "numeric"
    remainder = canonical
    if counter_match:
        kind = _COUNTER_NAMES[counter_match.group(1)]
        numeric_text = counter_match.group(2)
        remainder = counter_match.group(3).strip(" .")
    else:
        numeric_match = re.search(r"\d+(?:\.\d+)*", canonical)
        if not numeric_match:
            return NormalizedVersion(raw, canonical, "label", (), qualifier=canonical)
        numeric_text = numeric_match.group(0)
        prefix = canonical[:numeric_match.start()].strip(" .")
        remainder = canonical[numeric_match.end():].strip(" .")
        if prefix and prefix not in _STABLE_WORDS:
            remainder = f"{prefix} {remainder}".strip()

    numbers = tuple(int(part) for part in numeric_text.split("."))
    suffix_match = re.match(r"^([a-z])(?=$|[.\s])", remainder)
    letter_revision = None
    prerelease = None
    if suffix_match:
        suffix = suffix_match.group(1)
        remainder = remainder[suffix_match.end():].strip(" .")
        if suffix in ("a", "b"):
            letter_revision = suffix

    words = re.findall(r"[a-z]+", remainder)
    for word in words:
        if word in _PRERELEASE_ALIASES:
            prerelease = _PRERELEASE_ALIASES[word]
            break

    qualifier_words = [
        word for word in words
        if word not in _PRERELEASE_ALIASES and word not in _STABLE_WORDS
    ]
    qualifier = " ".join(qualifier_words) or None
    canonical_parts = [kind, ".".join(str(part) for part in _trim_numeric_components(numbers))]
    if prerelease:
        canonical_parts.append(prerelease)
    if letter_revision:
        canonical_parts.append(letter_revision)
    if qualifier:
        canonical_parts.append(qualifier)
    return NormalizedVersion(
        raw=raw,
        canonical=":".join(canonical_parts),
        kind=kind,
        numbers=numbers,
        prerelease=prerelease,
        letter_revision=letter_revision,
        qualifier=qualifier,
    )


def compare_versions(local: Optional[str], remote: Optional[str]) -> VersionComparison:
    local_display = _clean_display(local)
    remote_display = _clean_display(remote)
    normalized_local = normalize_version(local_display)
    normalized_remote = normalize_version(remote_display)

    if normalized_remote is None:
        return VersionComparison(
            "remote_version_unavailable", local_display, remote_display, False, None, "remote_version_missing"
        )
    if normalized_local is None:
        return VersionComparison(
            "local_version_unknown", local_display, remote_display, False, None, "local_version_missing"
        )

    if normalized_local.canonical == normalized_remote.canonical:
        return VersionComparison("up_to_date", local_display, remote_display, True, 0, "versions_equivalent")

    if normalized_local.kind == "label" or normalized_remote.kind == "label":
        return VersionComparison(
            "version_differs", local_display, remote_display, False, None, "unorderable_version_labels"
        )
    if normalized_local.kind != normalized_remote.kind:
        return VersionComparison(
            "version_differs", local_display, remote_display, False, None, "incompatible_version_kinds"
        )

    numeric_comparison = _compare_number_sequences(normalized_local.numbers, normalized_remote.numbers)
    if numeric_comparison:
        status = "update_available" if numeric_comparison < 0 else "up_to_date"
        return VersionComparison(
            status,
            local_display,
            remote_display,
            True,
            numeric_comparison,
            "remote_numeric_version_is_newer" if numeric_comparison < 0 else "local_numeric_version_is_newer",
        )

    if normalized_local.qualifier != normalized_remote.qualifier:
        return VersionComparison(
            "version_differs", local_display, remote_display, False, None, "version_channels_differ"
        )

    if normalized_local.letter_revision != normalized_remote.letter_revision:
        left_letter = ord(normalized_local.letter_revision) if normalized_local.letter_revision else ord("z") + 1
        right_letter = ord(normalized_remote.letter_revision) if normalized_remote.letter_revision else ord("z") + 1
        comparison = (left_letter > right_letter) - (left_letter < right_letter)
        return VersionComparison(
            "update_available" if comparison < 0 else "up_to_date",
            local_display,
            remote_display,
            True,
            comparison,
            "letter_revision_order",
        )

    if normalized_local.prerelease != normalized_remote.prerelease:
        left_rank = _PRERELEASE_RANK.get(normalized_local.prerelease, len(_PRERELEASE_RANK))
        right_rank = _PRERELEASE_RANK.get(normalized_remote.prerelease, len(_PRERELEASE_RANK))
        comparison = (left_rank > right_rank) - (left_rank < right_rank)
        return VersionComparison(
            "update_available" if comparison < 0 else "up_to_date",
            local_display,
            remote_display,
            True,
            comparison,
            "prerelease_order",
        )

    return VersionComparison("up_to_date", local_display, remote_display, True, 0, "versions_equivalent")


def evaluate_game_update_state(game) -> VersionComparison:
    return compare_versions(getattr(game, "local_version", None), getattr(game, "latest_version", None))


def apply_comparison_to_game(game, *, checked_at: Optional[datetime] = None) -> VersionComparison:
    result = evaluate_game_update_state(game)
    game.last_update_check_status = result.status
    game.last_update_check_error = None
    if checked_at is not None:
        game.last_update_check_at = checked_at
    if result.status == "update_available":
        game.update_available = True
        if not getattr(game, "update_detected_at", None):
            game.update_detected_at = checked_at or utc_now()
    elif result.status == "up_to_date":
        game.update_available = False
        game.update_detected_at = None
    else:
        game.update_available = False
        game.update_detected_at = None
    return result


def _infer_source_type(source_type: Optional[str], source_url: Optional[str], source_id: Optional[str]) -> str:
    clean_type = str(source_type or "unknown").strip().casefold()
    if clean_type in KNOWN_UPDATE_SOURCES:
        return clean_type
    hostname = (urlparse(str(source_url or "")).hostname or "").casefold()
    if hostname == "f95zone.to" or hostname.endswith(".f95zone.to"):
        return "f95zone"
    if hostname == "dlsite.com" or hostname.endswith(".dlsite.com"):
        return "dlsite"
    if hostname.endswith(".itch.io"):
        return "itch"
    if hostname == "steampowered.com" or hostname.endswith(".steampowered.com"):
        return "steam"
    if str(source_id or "").upper().startswith(("RJ", "VJ", "BJ")):
        return "dlsite"
    return clean_type or "unknown"


def build_update_source(
    source_type: Optional[str],
    source_url: Optional[str],
    source_id: Optional[str],
) -> UpdateSource:
    return UpdateSource(_infer_source_type(source_type, source_url, source_id), source_url, source_id)


def resolve_update_source(game) -> UpdateSource:
    preferred = next((source for source in list(getattr(game, "sources", []) or []) if source.is_preferred), None)
    if preferred is not None:
        source_type = _infer_source_type(preferred.source_type, preferred.source_url, preferred.source_id)
        return UpdateSource(source_type, preferred.source_url, preferred.source_id)
    source_url = getattr(game, "source_url", None)
    source_id = getattr(game, "source_id", None)
    source_type = _infer_source_type(getattr(game, "source_type", None), source_url, source_id)
    return UpdateSource(source_type, source_url, source_id)


def _valid_source_url(source_type: str, source_url: Optional[str]) -> bool:
    if not source_url:
        return False
    parsed = urlparse(str(source_url).strip())
    if parsed.scheme not in ("http", "https"):
        return False
    host = (parsed.hostname or "").casefold()
    allowed_hosts = {
        "f95zone": ("f95zone.to",),
        "dlsite": ("dlsite.com",),
        "itch": ("itch.io",),
        "steam": ("steampowered.com",),
    }.get(source_type, ())
    return any(host == suffix or host.endswith(f".{suffix}") for suffix in allowed_hosts)


def _source_request_url(source: UpdateSource) -> Optional[str]:
    if _valid_source_url(source.source_type, source.source_url):
        return str(source.source_url).strip()
    if source.source_type == "dlsite" and str(source.source_id or "").upper().startswith(("RJ", "VJ", "BJ")):
        code = str(source.source_id).upper()
        return f"https://www.dlsite.com/maniax/work/=/product_id/{code}.html"
    return None


def source_request_url(source: UpdateSource) -> Optional[str]:
    """Return a validated request URL for a linked source, including DLsite code fallback."""
    return _source_request_url(source)


def has_usable_linked_source(game, *, supported_sources: Optional[set[str]] = None) -> bool:
    """Return whether any stored source link is complete enough to use without rematching."""
    allowed = supported_sources or KNOWN_UPDATE_SOURCES
    candidates = [
        UpdateSource(
            _infer_source_type(source.source_type, source.source_url, source.source_id),
            source.source_url,
            source.source_id,
        )
        for source in list(getattr(game, "sources", []) or [])
    ]
    main_url = getattr(game, "source_url", None)
    main_id = getattr(game, "source_id", None)
    candidates.append(
        UpdateSource(
            _infer_source_type(getattr(game, "source_type", None), main_url, main_id),
            main_url,
            main_id,
        )
    )
    return any(source.source_type in allowed and _source_request_url(source) for source in candidates)


def _explicit_version_from_text(text: str) -> Optional[str]:
    match = re.search(
        r"\b(?:version|ver\.?|build|revision|rev\.?|patch)\s*[:#._-]*\s*"
        r"(v?\d+(?:[._-]\d+)*(?:[a-z])?(?:\s*(?:alpha|beta|rc|preview|demo))?)\b",
        text or "",
        flags=re.IGNORECASE,
    )
    return re.sub(r"\s+", " ", match.group(1)).strip() if match else None


def extract_remote_version(source_type: str, html: str) -> Optional[str]:
    if not html:
        return None
    soup = BeautifulSoup(html, "html.parser")
    if source_type == "f95zone":
        title_node = soup.select_one("h1.p-title-value") or soup.find("h1") or soup.title
        title = title_node.get_text(" ", strip=True) if title_node else ""
        counter_match = re.search(
            r"\[((?:build|revision|rev|chapter|episode|patch)\s*\d+(?:[._-]\d+)*)\]",
            title,
            flags=re.IGNORECASE,
        )
        if counter_match:
            return re.sub(r"\s+", " ", counter_match.group(1)).strip()
        match = re.search(
            r"\[(?:ver\.?\s*)?(v?\d+(?:[._-]\d+)*(?:[a-z])?(?:\s*(?:alpha|beta|rc|preview|demo|public|patreon))?)\]",
            title,
            flags=re.IGNORECASE,
        )
        if not match:
            return _explicit_version_from_text(title)
        value = match.group(1).strip()
        return value if value.casefold().startswith("v") else f"v{value}"

    if source_type == "dlsite":
        update_node = soup.select_one("#work_update, .work_update_list, .work_update")
        return _explicit_version_from_text(update_node.get_text(" ", strip=True) if update_node else "")

    if source_type == "itch":
        explicit = soup.select_one(
            "[itemprop='softwareVersion'], meta[name='softwareVersion'], meta[name='version'], [data-version]"
        )
        if explicit:
            value = explicit.get("content") or explicit.get("data-version") or explicit.get_text(" ", strip=True)
            return _clean_display(value)
        for script in soup.select("script[type='application/ld+json']"):
            try:
                structured = json.loads(script.string or script.get_text() or "{}")
            except (TypeError, ValueError):
                continue
            records = structured if isinstance(structured, list) else [structured]
            for record in records:
                if isinstance(record, dict) and record.get("softwareVersion"):
                    return _clean_display(record["softwareVersion"])
        labels = soup.find_all(string=re.compile(r"\b(?:version|ver\.)\s*[:#]", re.IGNORECASE))
        return _explicit_version_from_text(" ".join(str(label) for label in labels))
    return None


def _safe_error(exc: Exception) -> str:
    message = re.sub(r"\s+", " ", str(exc or "Update check failed")).strip()
    return (message or "Update check failed")[:300]


def _result_for_game(
    game,
    source: UpdateSource,
    checked_at: datetime,
    *,
    status: str,
    reason: str,
    error: Optional[str] = None,
    comparison: Optional[VersionComparison] = None,
) -> UpdateCheckResult:
    return UpdateCheckResult(
        status=status,
        local_version=getattr(game, "local_version", None),
        latest_version=getattr(game, "latest_version", None),
        checked_at=checked_at,
        source_type=source.source_type,
        source_url=source.source_url,
        comparable=bool(comparison and comparison.comparable),
        comparison=comparison.comparison if comparison else None,
        reason=reason,
        error=error,
    )


def check_game_update(
    game,
    db,
    *,
    http_get: Callable = requests.get,
    timeout: float = 10,
) -> UpdateCheckResult:
    source = resolve_update_source(game)
    checked_at = utc_now()
    game.last_update_check_status = "checking"
    game.last_update_check_error = None
    db.add(game)
    db.commit()

    if source.source_type not in SUPPORTED_UPDATE_SOURCES:
        status = "unsupported_source"
        game.last_update_check_status = status
        game.last_update_check_at = checked_at
        db.add(game)
        db.commit()
        return _result_for_game(game, source, checked_at, status=status, reason="source_not_supported")

    request_url = _source_request_url(source)
    if not request_url:
        status = "unsupported_source"
        game.last_update_check_status = status
        game.last_update_check_at = checked_at
        db.add(game)
        db.commit()
        return _result_for_game(game, source, checked_at, status=status, reason="source_url_not_supported")

    try:
        response = http_get(request_url, headers=UPDATE_CHECK_HEADERS, timeout=timeout)
        response.raise_for_status()
        remote_version = extract_remote_version(source.source_type, response.text)
        game.last_update_check_at = checked_at
        if not remote_version:
            game.last_update_check_status = "remote_version_unavailable"
            game.last_update_check_error = None
            db.add(game)
            db.commit()
            return _result_for_game(
                game,
                source,
                checked_at,
                status="remote_version_unavailable",
                reason="source_exposed_no_reliable_version",
            )

        game.latest_version = remote_version
        for linked_source in list(getattr(game, "sources", []) or []):
            if linked_source.is_preferred:
                linked_source.version_reported = remote_version
                break
        comparison = apply_comparison_to_game(game, checked_at=checked_at)
        db.add(game)
        db.commit()
        return _result_for_game(
            game,
            source,
            checked_at,
            status=comparison.status,
            reason=comparison.reason,
            comparison=comparison,
        )
    except Exception as exc:
        db.rollback()
        error = _safe_error(exc)
        game.last_update_check_at = checked_at
        game.last_update_check_status = "failed"
        game.last_update_check_error = error
        db.add(game)
        db.commit()
        return _result_for_game(game, source, checked_at, status="failed", reason="provider_request_failed", error=error)


def check_library_updates(
    db,
    *,
    games: Optional[Iterable] = None,
    progress_callback: Optional[Callable[[dict], None]] = None,
    should_cancel: Optional[Callable[[], bool]] = None,
    checker: Callable = check_game_update,
    throttle_seconds: float = 0.35,
) -> dict:
    if games is None:
        from backend.database import Game

        games = db.query(Game).filter(
            Game.is_ignored == False,
            Game.file_type != "wishlist",
        ).all()
    eligible = [game for game in list(games) if resolve_update_source(game).source_type != "unknown"]
    counters = {
        "updates_found": 0,
        "up_to_date_count": 0,
        "unknown_local_count": 0,
        "remote_unavailable_count": 0,
        "unsupported_count": 0,
        "version_differs_count": 0,
        "failed_count": 0,
    }
    updates = []
    manual_review = []
    failures = []
    processed = 0
    cancelled = False

    for game in eligible:
        if should_cancel and should_cancel():
            cancelled = True
            break
        try:
            result = checker(game, db)
        except Exception as exc:
            rollback = getattr(db, "rollback", None)
            if callable(rollback):
                try:
                    rollback()
                except Exception:
                    pass
            checked_at = utc_now()
            error = _safe_error(exc)
            game.last_update_check_at = checked_at
            game.last_update_check_status = "failed"
            game.last_update_check_error = error
            add = getattr(db, "add", None)
            commit = getattr(db, "commit", None)
            if callable(add) and callable(commit):
                try:
                    add(game)
                    commit()
                except Exception:
                    if callable(rollback):
                        rollback()
            source = resolve_update_source(game)
            result = _result_for_game(
                game,
                source,
                checked_at,
                status="failed",
                reason="unexpected_game_check_failure",
                error=error,
            )
        processed += 1
        if result.status == "update_available":
            counters["updates_found"] += 1
            updates.append({"game_id": game.id, "title": game.title, **result.to_dict()})
        elif result.status == "up_to_date":
            counters["up_to_date_count"] += 1
        elif result.status == "local_version_unknown":
            counters["unknown_local_count"] += 1
        elif result.status == "remote_version_unavailable":
            counters["remote_unavailable_count"] += 1
        elif result.status == "unsupported_source":
            counters["unsupported_count"] += 1
        elif result.status == "version_differs":
            counters["version_differs_count"] += 1
            manual_review.append({"game_id": game.id, "title": game.title, **result.to_dict()})
        elif result.status == "failed":
            counters["failed_count"] += 1
            failures.append({"game_id": game.id, "title": game.title, **result.to_dict()})

        if progress_callback:
            progress_callback({
                "processed": processed,
                "total": len(eligible),
                "current_game_id": game.id,
                "current_title": game.title,
                "current_source": result.source_type,
                **counters,
            })
        if throttle_seconds > 0 and processed < len(eligible):
            time.sleep(throttle_seconds)

    summary = (
        f"Update check {'cancelled' if cancelled else 'complete'}. {processed} of {len(eligible)} games processed, "
        f"{counters['updates_found']} updates found, {counters['failed_count']} failed."
    )
    return {
        "cancelled": cancelled,
        "processed": processed,
        "total": len(eligible),
        **counters,
        "updates": updates,
        "manual_review": manual_review,
        "failures": failures,
        "summary": summary,
    }
