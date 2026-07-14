import unittest
from datetime import datetime
from tempfile import TemporaryDirectory
from unittest.mock import patch

from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

import backend.database as database
from backend.database import Base, CustomTag, Game, GameSource, JournalEntry, Tag
from backend.job_progress import get_job, start_job
from backend.metadata_refresh import (
    list_metadata_refresh_targets,
    refresh_all_metadata,
    resolve_metadata_refresh_source,
)


class MetadataRefreshTests(unittest.TestCase):
    def test_refresh_route_and_job_contract_are_registered(self):
        import backend.main as main

        routes = {(route.path, method) for route in main.app.routes for method in getattr(route, "methods", set())}
        self.assertIn(("/api/library/refresh-all-metadata", "POST"), routes)

        state = start_job("refresh-all-metadata-test", 3, "Refresh test")
        state = get_job("refresh-all-metadata-test")
        for field in (
            "processed",
            "total",
            "current_index",
            "current_game_id",
            "current_title",
            "current_source",
            "refreshed_count",
            "skipped_count",
            "unsupported_count",
            "failed_count",
        ):
            self.assertIn(field, state)

    def setUp(self):
        self.engine = create_engine(
            "sqlite://",
            connect_args={"check_same_thread": False},
            poolclass=StaticPool,
        )
        Base.metadata.create_all(self.engine)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.db = self.Session()

    def tearDown(self):
        self.db.close()
        self.engine.dispose()

    def make_game(self, **overrides):
        unique_name = str(overrides.get("title") or "RemoteGame").replace(" ", "")
        values = {
            "title": "My Manual Title",
            "raw_name": "RemoteGame-v1.0",
            "folder_path": rf"D:\\Games\\{unique_name}-v1.0",
            "file_type": "archive",
            "archive_name": "RemoteGame-v1.0.zip",
            "source_type": "f95zone",
            "source_url": "https://f95zone.to/threads/12345/",
            "source_id": "12345",
            "is_identified": True,
            "is_ignored": False,
            "missing_scan_count": 0,
            "local_version": "v1.0",
            "local_version_is_manual": True,
            "title_is_manual": True,
            "playing_progress": "playing",
            "user_score": "5",
            "added_at": datetime(2024, 1, 2, 3, 4, 5),
            "last_played": datetime(2026, 7, 1, 12, 0, 0),
            "cover_url": "https://old.example/cover.jpg",
            "description": "Old description",
            "developer": "Old developer",
            "rating": "3.0",
            "release_date": "2024-01-01",
            "latest_version": "v1.0",
        }
        values.update(overrides)
        game = Game(**values)
        self.db.add(game)
        self.db.flush()
        if values.get("source_url"):
            game.sources.append(
                GameSource(
                    game_id=game.id,
                    source_type=values.get("source_type", "f95zone"),
                    source_url=values.get("source_url"),
                    source_id=values.get("source_id"),
                    is_preferred=True,
                )
            )
        game.tags.append(Tag(game_id=game.id, tag_name="Old source tag"))
        game.custom_tags.append(CustomTag(game_id=game.id, tag_name="My custom tag"))
        game.journal_entries.append(JournalEntry(game_id=game.id, entry_text="My journal"))
        self.db.commit()
        return game

    def test_preferred_source_wins_and_main_source_is_fallback(self):
        game = self.make_game()
        game.sources[0].source_type = "itch"
        game.sources[0].source_url = "https://studio.itch.io/remote-game"
        game.sources[0].source_id = None
        self.db.commit()

        preferred = resolve_metadata_refresh_source(game)
        self.assertEqual(preferred.source_type, "itch")
        self.assertEqual(preferred.source_url, "https://studio.itch.io/remote-game")

        game.sources[0].source_url = "not-a-url"
        game.sources[0].source_type = "unknown"
        fallback = resolve_metadata_refresh_source(game)
        self.assertEqual(fallback.source_type, "f95zone")
        self.assertEqual(fallback.source_id, "12345")

        self.assertEqual([item.id for item in list_metadata_refresh_targets(self.db)], [game.id])

    def test_target_list_excludes_unlinked_ignored_wishlist_and_hidden_games(self):
        included = self.make_game(title="Included")
        self.make_game(title="Ignored", is_ignored=True)
        self.make_game(title="Wishlist", file_type="wishlist")
        self.make_game(title="Hidden", missing_scan_count=1)
        self.make_game(
            title="Unlinked",
            source_type="unknown",
            source_url=None,
            source_id=None,
            is_identified=False,
        )

        targets = list_metadata_refresh_targets(self.db)

        self.assertEqual([game.id for game in targets], [included.id])

    def test_legacy_database_migrates_without_duplicate_sources_and_can_refresh_immediately(self):
        original_engine = database.engine
        original_session_local = database.SessionLocal
        with TemporaryDirectory() as temp_dir:
            legacy_engine = create_engine(
                f"sqlite:///{temp_dir.replace(chr(92), '/')}/legacy.db",
                connect_args={"check_same_thread": False},
            )
            Base.metadata.create_all(legacy_engine)
            LegacySession = sessionmaker(bind=legacy_engine, expire_on_commit=False)
            with LegacySession() as legacy_db:
                game = Game(
                    title="Imported",
                    raw_name="Imported-v1.0",
                    folder_path="C:/Imported/Game",
                    file_type="folder",
                    source_type="itch",
                    source_url="https://studio.itch.io/imported",
                    is_identified=True,
                    playing_progress="completed",
                    user_score="5",
                )
                legacy_db.add(game)
                legacy_db.flush()
                legacy_db.add(GameSource(
                    game_id=game.id,
                    source_type="itch",
                    source_url="https://studio.itch.io/imported",
                    is_preferred=True,
                ))
                legacy_db.commit()
            with legacy_engine.begin() as connection:
                for column in (
                    "last_update_check_at",
                    "last_update_check_status",
                    "last_update_check_error",
                    "update_detected_at",
                    "local_version_is_manual",
                    "title_is_manual",
                ):
                    connection.execute(text(f"ALTER TABLE games DROP COLUMN {column}"))

            database.engine = legacy_engine
            database.SessionLocal = LegacySession
            try:
                database.init_db()
                with LegacySession() as migrated_db:
                    imported = migrated_db.query(Game).one()
                    self.assertEqual(imported.playing_progress, "completed")
                    self.assertEqual(imported.user_score, "5")
                    self.assertEqual(len(imported.sources), 1)
                    self.assertEqual([item.id for item in list_metadata_refresh_targets(migrated_db)], [imported.id])
                    result = refresh_all_metadata(
                        migrated_db,
                        games=[imported],
                        metadata_fetcher=lambda *_args: {"developer": "Imported developer"},
                        throttle_seconds=0,
                    )
                    self.assertEqual(result["refreshed_count"], 1)
                    self.assertEqual(imported.developer, "Imported developer")
            finally:
                database.engine = original_engine
                database.SessionLocal = original_session_local
                legacy_engine.dispose()

    def test_refresh_preserves_user_owned_data_and_source_selection(self):
        game = self.make_game()
        original = {
            "folder_path": game.folder_path,
            "file_type": game.file_type,
            "archive_name": game.archive_name,
            "local_version": game.local_version,
            "playing_progress": game.playing_progress,
            "user_score": game.user_score,
            "added_at": game.added_at,
            "last_played": game.last_played,
            "source_type": game.source_type,
            "source_url": game.source_url,
            "source_id": game.source_id,
            "preferred_source_id": game.sources[0].id,
        }
        calls = []

        def fetcher(source_type, source_url, source_id):
            calls.append((source_type, source_url, source_id))
            return {
                "title": "Remote Canonical Title",
                "developer": "Remote developer",
                "cover_url": "https://remote.example/cover.jpg",
                "screenshots": ["https://remote.example/shot.jpg"],
                "tags": ["Remote tag"],
                "rating": "4.8",
                "description": "Remote description",
                "release_date": "2026-06-01",
                "latest_version": "v1.2",
            }

        result = refresh_all_metadata(
            self.db,
            games=[game],
            metadata_fetcher=fetcher,
            throttle_seconds=0,
        )

        self.assertEqual(result["refreshed_count"], 1)
        self.assertEqual(calls, [("f95zone", original["source_url"], "12345")])
        for field, value in original.items():
            if field == "preferred_source_id":
                continue
            self.assertEqual(getattr(game, field), value, field)
        self.assertEqual(game.title, "My Manual Title")
        self.assertEqual(game.developer, "Remote developer")
        self.assertEqual(game.latest_version, "v1.2")
        self.assertEqual([tag.tag_name for tag in game.tags], ["Remote tag"])
        self.assertEqual([tag.tag_name for tag in game.custom_tags], ["My custom tag"])
        self.assertEqual([entry.entry_text for entry in game.journal_entries], ["My journal"])
        self.assertEqual(len(game.sources), 1)
        self.assertTrue(game.sources[0].is_preferred)
        self.assertEqual(game.sources[0].id, original["preferred_source_id"])

    def test_failed_fetch_preserves_existing_metadata(self):
        game = self.make_game()
        before = game.to_dict()

        def failing_fetcher(*_args):
            raise TimeoutError("source unreachable")

        result = refresh_all_metadata(
            self.db,
            games=[game],
            metadata_fetcher=failing_fetcher,
            throttle_seconds=0,
        )

        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["failed_games"][0]["reason"], "source_unreachable")
        after = game.to_dict()
        for field in ("title", "cover_url", "description", "developer", "rating", "latest_version"):
            self.assertEqual(after[field], before[field], field)

    def test_database_write_is_committed_by_refresh_service_for_atomic_rollback(self):
        game = self.make_game()

        with patch("backend.metadata_refresh.apply_metadata_to_game") as apply_metadata:
            result = refresh_all_metadata(
                self.db,
                games=[game],
                metadata_fetcher=lambda *_args: {"developer": "Updated"},
                throttle_seconds=0,
            )

        self.assertEqual(result["refreshed_count"], 1)
        self.assertFalse(apply_metadata.call_args.kwargs["commit"])
        self.assertFalse(apply_metadata.call_args.kwargs["persist_snapshot_after"])

    def test_empty_metadata_and_unsupported_sources_are_classified(self):
        empty = self.make_game(title="Empty parser")
        unsupported = self.make_game(
            title="Unsupported",
            source_type="gog",
            source_url="https://gog.com/game/example",
            source_id="example",
        )

        result = refresh_all_metadata(
            self.db,
            games=[empty, unsupported],
            metadata_fetcher=lambda *_args: {},
            throttle_seconds=0,
        )

        self.assertEqual(result["failed_count"], 1)
        self.assertEqual(result["failed_games"][0]["reason"], "parser_returned_no_metadata")
        self.assertEqual(result["unsupported_count"], 1)
        self.assertEqual(result["unsupported_games"][0]["game_id"], unsupported.id)

    def test_progress_updates_per_game_and_cancellation_stops_between_games(self):
        first = self.make_game(title="First")
        second = self.make_game(title="Second")
        snapshots = []

        result = refresh_all_metadata(
            self.db,
            games=[first, second],
            metadata_fetcher=lambda *_args: {"developer": "Updated"},
            progress_callback=snapshots.append,
            should_cancel=lambda: len(snapshots) >= 2,
            throttle_seconds=0,
        )

        self.assertTrue(result["cancelled"])
        self.assertEqual(result["processed"], 1)
        self.assertEqual(snapshots[-1]["current_game_id"], first.id)
        self.assertEqual(snapshots[-1]["refreshed_count"], 1)


if __name__ == "__main__":
    unittest.main()
