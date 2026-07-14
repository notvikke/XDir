import unittest
from datetime import datetime
import tempfile
from types import SimpleNamespace

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker

import backend.database as database
from backend.database import Game

from backend.versioning import (
    apply_comparison_to_game,
    check_game_update,
    compare_versions,
    extract_remote_version,
    normalize_version,
    resolve_update_source,
)


class VersionComparisonTests(unittest.TestCase):
    def assert_comparison(self, local, remote, comparison, status):
        result = compare_versions(local, remote)
        self.assertEqual(comparison, result.comparison, result)
        self.assertEqual(status, result.status, result)
        return result

    def test_harmless_display_differences_are_equal(self):
        for local, remote in (
            ("v1.0", "1.0"),
            ("Ver. 1.2.0", "v1.2"),
            ("  V0.12   BETA ", "0_12-beta"),
        ):
            with self.subTest(local=local, remote=remote):
                result = self.assert_comparison(local, remote, 0, "up_to_date")
                self.assertTrue(result.comparable)

    def test_numeric_sequences_use_component_order(self):
        self.assert_comparison("v1.2", "v1.3", -1, "update_available")
        self.assert_comparison("v1.10", "v1.9", 1, "up_to_date")
        self.assert_comparison("v2.0", "v1.9", 1, "up_to_date")

    def test_dates_and_compatible_counters_are_ordered(self):
        self.assert_comparison("2026-06-01", "2026-07-01", -1, "update_available")
        self.assert_comparison("Build 100", "Build 101", -1, "update_available")
        self.assert_comparison("Chapter 4", "Chapter 5", -1, "update_available")
        self.assert_comparison("Episode 12", "Episode 11", 1, "up_to_date")

    def test_prerelease_and_letter_revisions_are_ordered(self):
        self.assert_comparison("v1.0a", "v1.0b", -1, "update_available")
        self.assert_comparison("v1.0-beta", "v1.0", -1, "update_available")
        self.assert_comparison("v1.0-alpha", "v1.0-rc", -1, "update_available")
        self.assert_comparison("v1.0-preview", "v1.0-beta", -1, "update_available")

    def test_channels_and_unparseable_labels_do_not_create_false_updates(self):
        for local, remote in (
            ("0.5 Public", "0.5 Patreon"),
            ("Final", "Complete Edition"),
            ("Blue Release", "Red Release"),
        ):
            with self.subTest(local=local, remote=remote):
                result = self.assert_comparison(local, remote, None, "version_differs")
                self.assertFalse(result.comparable)

    def test_unknown_versions_have_specific_states(self):
        local_unknown = self.assert_comparison(None, "v1.0", None, "local_version_unknown")
        remote_unknown = self.assert_comparison("v1.0", None, None, "remote_version_unavailable")
        both_unknown = self.assert_comparison("  ", "", None, "remote_version_unavailable")
        self.assertEqual("local_version_missing", local_unknown.reason)
        self.assertEqual("remote_version_missing", remote_unknown.reason)
        self.assertEqual("remote_version_missing", both_unknown.reason)

    def test_normalization_preserves_typed_information(self):
        normalized = normalize_version("  Revision 6 RC  ")
        self.assertEqual("revision", normalized.kind)
        self.assertEqual((6,), normalized.numbers)
        self.assertEqual("rc", normalized.prerelease)

    def test_applying_comparison_sets_and_clears_detection_timestamp(self):
        game = SimpleNamespace(
            local_version="v1.0",
            latest_version="v1.2",
            update_available=False,
            update_detected_at=None,
            last_update_check_status="never",
            last_update_check_error="old error",
        )

        first = apply_comparison_to_game(game)
        self.assertEqual("update_available", first.status)
        self.assertTrue(game.update_available)
        self.assertIsNotNone(game.update_detected_at)
        detected_at = game.update_detected_at

        apply_comparison_to_game(game)
        self.assertEqual(detected_at, game.update_detected_at)

        game.local_version = "v1.2"
        apply_comparison_to_game(game)
        self.assertEqual("up_to_date", game.last_update_check_status)
        self.assertFalse(game.update_available)
        self.assertIsNone(game.update_detected_at)
        self.assertIsNone(game.last_update_check_error)


class VersionStatePersistenceTests(unittest.TestCase):
    def test_game_serializes_durable_update_check_fields(self):
        checked_at = datetime(2026, 7, 14, 8, 30)
        detected_at = datetime(2026, 7, 14, 8, 31)
        game = Game(
            title="Example",
            raw_name="Example",
            folder_path="C:/Games/Example",
            last_update_check_at=checked_at,
            last_update_check_status="update_available",
            last_update_check_error=None,
            update_detected_at=detected_at,
            local_version_is_manual=True,
            title_is_manual=True,
        )

        payload = game.to_dict()

        self.assertEqual(checked_at.isoformat(), payload["last_update_check_at"])
        self.assertEqual("update_available", payload["last_update_check_status"])
        self.assertEqual(detected_at.isoformat(), payload["update_detected_at"])
        self.assertTrue(payload["local_version_is_manual"])
        self.assertTrue(payload["title_is_manual"])

    def test_init_db_migrates_existing_games_table_idempotently(self):
        original_engine = database.engine
        original_session_local = database.SessionLocal
        with tempfile.TemporaryDirectory() as temp_dir:
            db_path = temp_dir.replace("\\", "/") + "/legacy.db"
            temp_engine = create_engine(f"sqlite:///{db_path}", connect_args={"check_same_thread": False})
            with temp_engine.begin() as connection:
                connection.execute(text(
                    "CREATE TABLE games (id INTEGER PRIMARY KEY, title VARCHAR NOT NULL, "
                    "raw_name VARCHAR NOT NULL, folder_path VARCHAR NOT NULL)"
                ))
                connection.execute(text(
                    "INSERT INTO games (id, title, raw_name, folder_path) "
                    "VALUES (1, 'Legacy', 'Legacy', 'C:/Games/Legacy')"
                ))
            database.engine = temp_engine
            database.SessionLocal = sessionmaker(bind=temp_engine)
            try:
                database.init_db()
                database.init_db()
                with temp_engine.connect() as connection:
                    columns = {row[1] for row in connection.execute(text("PRAGMA table_info(games)"))}
                    legacy_title = connection.execute(text("SELECT title FROM games WHERE id = 1")).scalar_one()
            finally:
                database.engine = original_engine
                database.SessionLocal = original_session_local
                temp_engine.dispose()

        self.assertEqual("Legacy", legacy_title)
        self.assertTrue({
            "last_update_check_at",
            "last_update_check_status",
            "last_update_check_error",
            "update_detected_at",
            "local_version_is_manual",
            "title_is_manual",
        }.issubset(columns))


class FakeResponse:
    def __init__(self, text_value, status_code=200):
        self.text = text_value
        self.status_code = status_code

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeDb:
    def __init__(self):
        self.commits = 0
        self.rollbacks = 0

    def add(self, _value):
        return None

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1


def make_game(**overrides):
    values = {
        "id": 1,
        "title": "Example",
        "file_type": "folder",
        "is_ignored": False,
        "source_type": "f95zone",
        "source_url": "https://f95zone.to/threads/example.12345/",
        "source_id": "12345",
        "sources": [],
        "local_version": "v1.0",
        "latest_version": "v1.1",
        "update_available": True,
        "update_detected_at": datetime(2026, 7, 1),
        "last_update_check_at": None,
        "last_update_check_status": "update_available",
        "last_update_check_error": None,
    }
    values.update(overrides)
    return SimpleNamespace(**values)


class ProviderUpdateCheckTests(unittest.TestCase):
    def test_preferred_game_source_wins_over_main_source(self):
        preferred = SimpleNamespace(
            source_type="itch",
            source_url="https://creator.itch.io/example",
            source_id=None,
            is_preferred=True,
        )
        other = SimpleNamespace(
            source_type="dlsite",
            source_url="https://www.dlsite.com/maniax/work/=/product_id/RJ123456.html",
            source_id="RJ123456",
            is_preferred=False,
        )
        game = make_game(sources=[other, preferred])

        source = resolve_update_source(game)

        self.assertEqual("itch", source.source_type)
        self.assertEqual(preferred.source_url, source.source_url)

    def test_extractors_only_accept_explicit_versions(self):
        cases = (
            ("f95zone", "<title>Completed - Example [v1.2.3b] [Dev] | F95zone</title>", "v1.2.3b"),
            ("dlsite", "<div id='work_update'>Updated 2026-07-01<br>Version 2.4 beta</div>", "2.4 beta"),
            ("itch", "<meta itemprop='softwareVersion' content='0.9 rc'><time>2026-07-14</time>", "0.9 rc"),
        )
        for source_type, html, expected in cases:
            with self.subTest(source_type=source_type):
                self.assertEqual(expected, extract_remote_version(source_type, html))

        self.assertIsNone(extract_remote_version("itch", "<time>Updated July 14, 2026</time>"))
        self.assertIsNone(extract_remote_version("dlsite", "<div id='work_update'>Updated 2026-07-01</div>"))

    def test_itch_extractor_reads_structured_software_version(self):
        html = '<script type="application/ld+json">{"@type":"SoftwareApplication","softwareVersion":"1.4 rc"}</script>'

        self.assertEqual("1.4 rc", extract_remote_version("itch", html))

    def test_successful_check_changes_only_version_state(self):
        game = make_game(
            title="Keep Title",
            developer="Keep Dev",
            cover_url="cover.jpg",
            description="Keep Description",
            rating="4.8",
            screenshots=["shot.jpg"],
            tags=["tag"],
        )
        db = FakeDb()
        getter = lambda *_args, **_kwargs: FakeResponse("<title>Example [v1.3] [Dev]</title>")

        result = check_game_update(game, db, http_get=getter)

        self.assertEqual("update_available", result.status)
        self.assertEqual("v1.3", game.latest_version)
        self.assertEqual("Keep Title", game.title)
        self.assertEqual("Keep Dev", game.developer)
        self.assertEqual("cover.jpg", game.cover_url)
        self.assertEqual("Keep Description", game.description)
        self.assertEqual("4.8", game.rating)
        self.assertEqual(["shot.jpg"], game.screenshots)
        self.assertEqual(["tag"], game.tags)

    def test_failed_request_preserves_previous_remote_and_update_state(self):
        detected_at = datetime(2026, 7, 1)
        game = make_game(latest_version="v1.1", update_available=True, update_detected_at=detected_at)
        db = FakeDb()

        def fail_get(*_args, **_kwargs):
            raise RuntimeError("socket credentials must not leak")

        result = check_game_update(game, db, http_get=fail_get)

        self.assertEqual("failed", result.status)
        self.assertEqual("v1.1", game.latest_version)
        self.assertTrue(game.update_available)
        self.assertEqual(detected_at, game.update_detected_at)
        self.assertIn("socket credentials", game.last_update_check_error)
        self.assertNotIn("Traceback", game.last_update_check_error)

    def test_reachable_page_without_version_preserves_previous_remote_state(self):
        detected_at = datetime(2026, 7, 1)
        game = make_game(latest_version="v1.1", update_available=True, update_detected_at=detected_at)

        result = check_game_update(
            game,
            FakeDb(),
            http_get=lambda *_args, **_kwargs: FakeResponse("<title>Example [Completed] [Dev]</title>"),
        )

        self.assertEqual("remote_version_unavailable", result.status)
        self.assertEqual("v1.1", game.latest_version)
        self.assertTrue(game.update_available)
        self.assertEqual(detected_at, game.update_detected_at)

    def test_steam_is_reported_as_unsupported(self):
        game = make_game(
            source_type="steam",
            source_url="https://store.steampowered.com/app/123/Example/",
            source_id="123",
        )

        result = check_game_update(game, FakeDb(), http_get=lambda *_args, **_kwargs: self.fail("must not fetch"))

        self.assertEqual("unsupported_source", result.status)
        self.assertEqual("steam", result.source_type)


if __name__ == "__main__":
    unittest.main()
