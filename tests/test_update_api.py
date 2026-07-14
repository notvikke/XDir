import tempfile
import unittest
import json
from datetime import datetime, timedelta
from unittest.mock import patch

from fastapi import HTTPException
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app as desktop_app
import backend.config as config
import backend.main as main
import backend.ingest as ingest
from backend.database import Base, Game, GameSource
from backend.versioning import UpdateCheckResult, check_library_updates


class VersionApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.db = sessionmaker(bind=self.engine)()
        self.game = Game(
            title="Example",
            raw_name="Example-v1.0",
            folder_path="C:/Games/Example",
            file_type="folder",
            source_type="f95zone",
            source_url="https://f95zone.to/threads/example.123/",
            source_id="123",
            is_identified=True,
            local_version="v1.0",
            latest_version="v1.2",
            update_available=True,
            update_detected_at=datetime(2026, 7, 1),
            added_at=datetime(2026, 7, 1),
            last_seen_at=datetime(2026, 7, 1),
            last_update_check_at=datetime(2026, 7, 1),
            last_update_check_status="update_available",
        )
        self.db.add(self.game)
        self.db.commit()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def test_manual_version_is_trimmed_and_recalculated(self):
        with patch("backend.main.persist_snapshot"):
            response = main.update_game_version(
                self.game.id,
                main.GameVersionPayload(local_version="  v1.2  "),
                self.db,
            )

        self.assertEqual("v1.2", response["game"]["local_version"])
        self.assertTrue(response["game"]["local_version_is_manual"])
        self.assertEqual("up_to_date", response["game"]["last_update_check_status"])
        self.assertFalse(response["game"]["update_available"])

    def test_manual_version_can_be_explicitly_cleared(self):
        with patch("backend.main.persist_snapshot"):
            response = main.update_game_version(
                self.game.id,
                main.GameVersionPayload(local_version="   "),
                self.db,
            )

        self.assertIsNone(response["game"]["local_version"])
        self.assertTrue(response["game"]["local_version_is_manual"])
        self.assertEqual("local_version_unknown", response["game"]["last_update_check_status"])

    def test_mark_latest_installed_preserves_last_check_time(self):
        previous_check = self.game.last_update_check_at
        with patch("backend.main.persist_snapshot"):
            response = main.mark_latest_installed(self.game.id, self.db)

        payload = response["game"]
        self.assertEqual("v1.2", payload["local_version"])
        self.assertTrue(payload["local_version_is_manual"])
        self.assertEqual("up_to_date", payload["last_update_check_status"])
        self.assertFalse(payload["update_available"])
        self.assertIsNone(payload["update_detected_at"])
        self.assertEqual(previous_check.isoformat(), payload["last_update_check_at"])

    def test_version_route_returns_404_for_unknown_game(self):
        with self.assertRaises(HTTPException) as raised:
            main.update_game_version(999, main.GameVersionPayload(local_version="v1.0"), self.db)
        self.assertEqual(404, raised.exception.status_code)

    def test_manual_title_edit_sets_explicit_ownership(self):
        with patch("backend.main.persist_snapshot"):
            response = main.update_game(
                self.game.id,
                main.UpdateGamePayload(title="  My title  "),
                self.db,
            )

        self.assertEqual(response["title"], "My title")
        self.assertTrue(response["title_is_manual"])

    def test_extension_sync_uses_numeric_comparison(self):
        self.game.local_version = "v1.9"
        self.db.commit()
        with patch("backend.main.persist_snapshot"):
            response = main.sync_metadata(
                main.MetadataSyncPayload(game_id=self.game.id, latest_version="v1.10"),
                self.db,
            )

        self.assertTrue(response["game"]["update_available"])
        self.assertEqual("update_available", response["game"]["last_update_check_status"])
        self.assertIsNotNone(response["game"]["last_update_check_at"])

    def test_extension_sync_preserves_a_manual_title(self):
        self.game.title = "My Manual Name"
        self.game.title_is_manual = True
        self.db.commit()

        with patch("backend.main.persist_snapshot"):
            response = main.sync_metadata(
                main.MetadataSyncPayload(game_id=self.game.id, title="Remote Name"),
                self.db,
            )

        self.assertEqual(response["game"]["title"], "My Manual Name")

    def test_stats_expose_link_summary_and_maintenance_state_without_network(self):
        unlinked = Game(
            title="Unlinked",
            raw_name="Unlinked",
            folder_path="C:/Games/Unlinked",
            file_type="folder",
            source_type="unknown",
            is_identified=False,
            is_ignored=False,
            missing_scan_count=0,
        )
        self.db.add(unlinked)
        self.db.commit()

        with patch("backend.main.get_settings", return_value={
            "games_dir": "C:/Games",
            "games_dirs": ["C:/Games"],
            "automatic_game_update_checks": True,
            "last_game_update_check_at": "2026-07-14T08:00:00",
            "last_full_metadata_refresh_at": "2026-07-13T08:00:00",
        }):
            stats = main.get_stats(self.db)

        self.assertEqual(stats["total_visible_games"], 2)
        self.assertEqual(stats["linked_games"], 1)
        self.assertEqual(stats["unlinked_games"], 1)
        self.assertEqual(stats["games_with_updates"], 1)
        self.assertEqual(stats["last_full_metadata_refresh"], "2026-07-13T08:00:00")
        self.assertEqual(stats["last_library_update_check"], "2026-07-14T08:00:00")
        self.assertTrue(stats["automatic_game_update_checks"])

    def test_single_game_check_returns_structured_result(self):
        def fake_check(game, db):
            game.latest_version = "v1.3"
            game.last_update_check_status = "update_available"
            game.last_update_check_at = datetime(2026, 7, 14, 12, 0)
            game.update_available = True
            db.commit()
            return UpdateCheckResult(
                "update_available",
                game.local_version,
                game.latest_version,
                game.last_update_check_at,
                "f95zone",
                game.source_url,
                comparable=True,
                comparison=-1,
                reason="remote_numeric_version_is_newer",
            )

        with patch("backend.main.check_game_update", side_effect=fake_check), patch("backend.main.persist_snapshot"):
            response = main.trigger_game_update_check(self.game.id, self.db)

        self.assertEqual("Update check completed", response["message"])
        self.assertEqual("update_available", response["result"]["status"])
        self.assertEqual("v1.3", response["game"]["latest_version"])

    def test_single_game_check_rejects_duplicate_active_check(self):
        main.ACTIVE_UPDATE_CHECK_GAME_IDS.add(self.game.id)
        try:
            with self.assertRaises(HTTPException) as raised:
                main.trigger_game_update_check(self.game.id, self.db)
        finally:
            main.ACTIVE_UPDATE_CHECK_GAME_IDS.discard(self.game.id)
        self.assertEqual(409, raised.exception.status_code)


class UpdateSchedulingTests(unittest.TestCase):
    def test_legacy_vague_auto_update_setting_is_dropped(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = temp_dir + "/settings.json"
            with open(settings_path, "w", encoding="utf-8") as handle:
                json.dump({"auto_update": False, "automatic_game_update_checks": True}, handle)
            with patch.object(config, "SETTINGS_FILE", settings_path):
                settings = config.get_settings()
                saved = config.save_settings({"preferred_source": "itch"})

        self.assertNotIn("auto_update", settings)
        self.assertNotIn("auto_update", saved)

    def test_settings_default_to_weekly_automatic_checks(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            settings_path = temp_dir + "/settings.json"
            with patch.object(config, "SETTINGS_FILE", settings_path):
                settings = config.get_settings()

        self.assertTrue(settings["automatic_game_update_checks"])
        self.assertEqual(7, settings["game_update_check_interval_days"])
        self.assertIsNone(settings["last_game_update_check_at"])

    def test_due_calculation_honors_disabled_recent_and_old_checks(self):
        now = datetime(2026, 7, 14, 12, 0)
        base = {
            "automatic_game_update_checks": True,
            "game_update_check_interval_days": 7,
            "last_game_update_check_at": None,
        }
        self.assertTrue(desktop_app.is_game_update_check_due(base, now=now))
        self.assertFalse(desktop_app.is_game_update_check_due({**base, "automatic_game_update_checks": False}, now=now))
        self.assertFalse(desktop_app.is_game_update_check_due({
            **base,
            "last_game_update_check_at": (now - timedelta(days=6)).isoformat(),
        }, now=now))
        self.assertTrue(desktop_app.is_game_update_check_due({
            **base,
            "last_game_update_check_at": (now - timedelta(days=7)).isoformat(),
        }, now=now))

    def test_automatic_check_starts_at_most_once_per_session(self):
        settings = {
            "automatic_game_update_checks": True,
            "game_update_check_interval_days": 7,
            "last_game_update_check_at": None,
        }
        original_started = desktop_app._automatic_game_update_check_started
        desktop_app._automatic_game_update_check_started = False
        try:
            with patch("backend.main.start_update_check_job_in_thread", return_value=True) as starter:
                self.assertTrue(desktop_app.schedule_automatic_game_update_check(settings))
                self.assertFalse(desktop_app.schedule_automatic_game_update_check(settings))
        finally:
            desktop_app._automatic_game_update_check_started = original_started

        starter.assert_called_once_with()


class LibraryUpdateIterationTests(unittest.TestCase):
    def test_library_check_counts_unorderable_version_differences(self):
        game = type("Game", (), {
            "id": 1,
            "title": "Different edition",
            "source_type": "itch",
            "source_url": "https://dev.itch.io/different",
            "source_id": None,
            "sources": [],
        })()

        result = check_library_updates(
            object(),
            games=[game],
            checker=lambda *_args: UpdateCheckResult(
                "version_differs",
                "Final",
                "Complete Edition",
                datetime(2026, 7, 14),
                "itch",
                game.source_url,
            ),
            throttle_seconds=0,
        )

        self.assertEqual(result["version_differs_count"], 1)

    def test_library_check_continues_after_failure(self):
        games = [
            type("Game", (), {"id": 1, "title": "Broken", "source_type": "f95zone", "source_url": "https://f95zone.to/threads/1/", "source_id": "1", "sources": []})(),
            type("Game", (), {"id": 2, "title": "Good", "source_type": "itch", "source_url": "https://dev.itch.io/good", "source_id": None, "sources": []})(),
        ]

        def checker(game, _db):
            if game.id == 1:
                raise RuntimeError("unexpected per-game database failure")
            return UpdateCheckResult("up_to_date", "v1", "v1", datetime(2026, 7, 14), game.source_type, game.source_url)

        result = check_library_updates(object(), games=games, checker=checker, throttle_seconds=0)

        self.assertEqual(2, result["processed"])
        self.assertEqual(1, result["failed_count"])
        self.assertEqual(1, result["up_to_date_count"])

    def test_library_check_cancels_between_games(self):
        games = [
            type("Game", (), {"id": i, "title": f"Game {i}", "source_type": "itch", "source_url": f"https://dev.itch.io/{i}", "source_id": None, "sources": []})()
            for i in range(1, 4)
        ]
        calls = []

        def checker(game, _db):
            calls.append(game.id)
            return UpdateCheckResult("up_to_date", "v1", "v1", datetime(2026, 7, 14), "itch", game.source_url)

        result = check_library_updates(
            object(),
            games=games,
            checker=checker,
            should_cancel=lambda: len(calls) >= 1,
            throttle_seconds=0,
        )

        self.assertTrue(result["cancelled"])
        self.assertEqual([1], calls)
        self.assertEqual(1, result["processed"])


class ScanVersionProtectionTests(unittest.TestCase):
    def test_manual_unknown_version_is_not_repopulated_by_scan(self):
        game = type("Game", (), {"local_version": None, "local_version_is_manual": True})()

        changed = ingest.apply_scanned_local_version(game, "v2.0")

        self.assertFalse(changed)
        self.assertIsNone(game.local_version)

    def test_uncontrolled_missing_version_is_populated_by_scan(self):
        game = type("Game", (), {"local_version": None, "local_version_is_manual": False})()

        changed = ingest.apply_scanned_local_version(game, "v2.0")

        self.assertTrue(changed)
        self.assertEqual("v2.0", game.local_version)


if __name__ == "__main__":
    unittest.main()
