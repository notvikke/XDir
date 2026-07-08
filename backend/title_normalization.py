import re
from typing import Any, Dict, List, Optional


PLATFORM_TAGS = (
    "pc",
    "windows",
    "win",
    "mac",
    "linux",
    "android",
)
NOISE_WORDS = (
    "final",
    "completed",
    "compressed",
    "mod",
    "repack",
    "crack",
    "update",
)
VERSION_PATTERN = re.compile(
    r"(?i)\b(?:v|ver(?:sion)?|rev|build)[\s._-]*(\d+(?:[._-]\d+){0,3})\b|\b(\d+\.\d+(?:\.\d+){0,2})\b"
)
BRACKET_TAG_PATTERN = re.compile(r"\[[^\]]*\]|\([^)]*\)")
FILE_EXTENSION_PATTERN = re.compile(r"\.(zip|rar|7z|iso|exe|tar|gz|bz2)$", re.IGNORECASE)
RANDOM_SUFFIX_PATTERN = re.compile(r"([_-])\d{4,}$")
CAMEL_CASE_PATTERN = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def _collapse_spaces(value: str) -> str:
    return re.sub(r"\s+", " ", value or "").strip()


def strip_file_extension(value: str) -> str:
    return FILE_EXTENSION_PATTERN.sub("", value or "")


def split_pascal_case(value: str) -> str:
    return CAMEL_CASE_PATTERN.sub(" ", value or "")


def replace_separators(value: str) -> str:
    return re.sub(r"[_\-.]+", " ", value or "")


def remove_bracketed_tags(value: str) -> str:
    return BRACKET_TAG_PATTERN.sub(" ", value or "")


def remove_random_numeric_suffix(value: str) -> str:
    return RANDOM_SUFFIX_PATTERN.sub("", value or "")


def extract_versions(value: str) -> List[str]:
    seen = set()
    versions: List[str] = []
    for match in VERSION_PATTERN.finditer(value or ""):
        raw = match.group(1) or match.group(2) or ""
        cleaned = raw.replace("_", ".").replace("-", ".").strip(". ")
        if not cleaned:
            continue
        version = f"v{cleaned}"
        key = version.lower()
        if key in seen:
            continue
        seen.add(key)
        versions.append(version)
    return versions


def shorten_version(version: str) -> Optional[str]:
    parts = re.sub(r"(?i)^v", "", version or "").split(".")
    if len(parts) < 2:
        return None
    return f"v{parts[0]}.{parts[1]}"


def remove_versions(value: str) -> str:
    return _collapse_spaces(VERSION_PATTERN.sub(" ", value or ""))


def extract_platform_tags(value: str) -> List[str]:
    tokens = re.split(r"[^a-zA-Z0-9]+", value or "")
    seen = set()
    found: List[str] = []
    for token in tokens:
        lowered = token.lower().strip()
        if lowered in PLATFORM_TAGS and lowered not in seen:
            seen.add(lowered)
            found.append(token.upper() if lowered == "pc" else token.title())
    return found


def remove_platform_tags(value: str) -> str:
    if not value:
        return ""
    cleaned = value
    for platform in PLATFORM_TAGS:
        cleaned = re.sub(rf"(?i)\b{re.escape(platform)}\b", " ", cleaned)
    return _collapse_spaces(cleaned)


def remove_noise_words(value: str) -> str:
    if not value:
        return ""
    cleaned = value
    for word in NOISE_WORDS:
        cleaned = re.sub(rf"(?i)\b{re.escape(word)}\b", " ", cleaned)
    return _collapse_spaces(cleaned)


def compact_title(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "", value or "").strip()


def normalize_title(value: str) -> str:
    cleaned = strip_file_extension(value or "")
    cleaned = remove_bracketed_tags(cleaned)
    cleaned = remove_random_numeric_suffix(cleaned)
    cleaned = split_pascal_case(cleaned)
    cleaned = remove_versions(cleaned)
    cleaned = replace_separators(cleaned)
    cleaned = remove_platform_tags(cleaned)
    cleaned = remove_noise_words(cleaned)
    cleaned = re.sub(r"[^A-Za-z0-9]+", " ", cleaned)
    return _collapse_spaces(cleaned).lower()


def tokenize_title(value: str) -> List[str]:
    return [token for token in normalize_title(value).split() if len(token) >= 3]


def _add_query(results: List[Dict[str, Any]], seen: set[str], query: str, reason: str) -> None:
    cleaned = _collapse_spaces(query)
    if len(cleaned) < 3:
        return
    key = cleaned.lower()
    if key in seen:
        return
    seen.add(key)
    results.append(
        {
            "query": cleaned,
            "priority": max(1, 100 - len(results)),
            "reason": reason,
        }
    )


def generate_query_candidates(raw_name: str, title_hint: Optional[str] = None) -> List[Dict[str, Any]]:
    source_value = title_hint or raw_name or ""
    original = strip_file_extension(raw_name or source_value)
    if not original:
        return []

    original = remove_bracketed_tags(original)
    original = remove_random_numeric_suffix(original)
    versions = extract_versions(original)
    platforms = extract_platform_tags(original)

    compact_core = compact_title(remove_platform_tags(remove_versions(original)))
    spaced_core = _collapse_spaces(split_pascal_case(replace_separators(compact_core)))

    spaced_original = _collapse_spaces(split_pascal_case(replace_separators(original)))
    spaced_without_platform = _collapse_spaces(split_pascal_case(replace_separators(remove_platform_tags(original))))
    spaced_without_version = _collapse_spaces(split_pascal_case(replace_separators(remove_versions(original))))
    spaced_clean = _collapse_spaces(
        split_pascal_case(
            replace_separators(
                remove_noise_words(remove_platform_tags(remove_versions(original)))
            )
        )
    )

    results: List[Dict[str, Any]] = []
    seen: set[str] = set()

    _add_query(results, seen, compact_core, "compact-core")
    _add_query(results, seen, spaced_core, "split-core")

    for version in versions:
        _add_query(results, seen, f"{spaced_core} {version}", "versioned")
        short_version = shorten_version(version)
        if short_version:
            _add_query(results, seen, f"{spaced_core} {short_version}", "short-versioned")

    if platforms:
        _add_query(results, seen, f"{spaced_core} {' '.join(platforms)}", "platform-tag")

    _add_query(results, seen, spaced_without_platform, "without-platform")
    _add_query(results, seen, spaced_without_version, "without-version")
    _add_query(results, seen, spaced_original, "spaced-original")
    _add_query(results, seen, spaced_clean, "clean")

    hint_clean = _collapse_spaces(split_pascal_case(replace_separators(title_hint or "")))
    if hint_clean and normalize_title(hint_clean) != normalize_title(raw_name):
        _add_query(results, seen, hint_clean, "title-hint")

    for token in tokenize_title(spaced_core):
        _add_query(results, seen, token.title(), "token")

    return results
