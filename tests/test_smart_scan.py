import unittest
from types import SimpleNamespace
from unittest.mock import patch

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.smart_scan import (
    build_missing_source_review_item,
    build_game_search_queries,
    build_source_search_order,
    choose_best_candidate,
    choose_review_thumbnail,
    choose_unambiguous_auto_match,
    apply_missing_source_candidate,
    score_candidate_match,
    should_include_in_missing_source_scan,
)
from backend.title_normalization import generate_query_candidates
from backend.database import Base, Game
from backend.job_progress import get_job, set_job_context, start_job


class SmartScanTests(unittest.TestCase):
    def test_only_canonical_missing_source_routes_are_registered(self):
        import backend.main as main

        routes = {(route.path, method) for route in main.app.routes for method in getattr(route, "methods", set())}
        self.assertIn(("/api/library/missing-source-scan", "POST"), routes)
        self.assertIn(("/api/library/missing-source-scan/review/{game_id}/apply", "POST"), routes)
        self.assertIn(("/api/library/missing-source-scan/review/{game_id}/skip", "POST"), routes)
        self.assertNotIn(("/api/library/smart-scan", "POST"), routes)
        self.assertNotIn(("/api/library/smart-scan/review/{game_id}/apply", "POST"), routes)

    def test_build_source_search_order_prefers_selected_source_first(self):
        self.assertEqual(
            build_source_search_order("dlsite"),
            ["dlsite", "f95zone", "itch"],
        )
        self.assertEqual(
            build_source_search_order("itch"),
            ["itch", "f95zone", "dlsite"],
        )
        self.assertEqual(
            build_source_search_order("unknown"),
            ["f95zone", "dlsite", "itch"],
        )

    def test_generate_query_candidates_handles_messy_folder_names(self):
        queries = [entry["query"] for entry in generate_query_candidates("DesertStalker-v0.18.2-PC")]

        self.assertIn("DesertStalker", queries)
        self.assertIn("Desert Stalker", queries)
        self.assertIn("Desert Stalker v0.18.2", queries)
        self.assertIn("Desert Stalker v0.18", queries)
        self.assertIn("Desert Stalker PC", queries)
        self.assertIn("Desert", queries)
        self.assertIn("Stalker", queries)
        self.assertEqual(len(queries), len(set(queries)))
        self.assertTrue(all(len(query.strip()) >= 3 for query in queries))

    def test_game_search_queries_include_title_folder_archive_and_product_code(self):
        game = SimpleNamespace(
            title="Friendly Name",
            raw_name="RawFolder-v1.0",
            folder_path="C:/Games/ActualFolder-v1.0",
            archive_name="ArchiveName-v1.0.zip",
            source_id="RJ01234567",
        )

        queries = [item["query"] for item in build_game_search_queries(game)]

        self.assertIn("Friendly Name", queries)
        self.assertTrue(any("Raw Folder" in query or "RawFolder" in query for query in queries))
        self.assertTrue(any("Actual Folder" in query or "ActualFolder" in query for query in queries))
        self.assertTrue(any("Archive Name" in query or "ArchiveName" in query for query in queries))
        self.assertIn("RJ01234567", queries)

    def test_missing_source_scan_only_targets_visible_unlinked_games(self):
        missing_source = SimpleNamespace(
            title="Fresh Folder Game",
            raw_name="FreshFolderGame",
            source_url=None,
            source_id=None,
            source_type="unknown",
            is_identified=False,
            file_type="folder",
            is_ignored=False,
            missing_scan_count=0,
            sources=[],
        )
        metadata_only_gap = SimpleNamespace(
            title="Linked Game",
            raw_name="LinkedGame",
            source_url="https://f95zone.to/threads/12345/",
            source_id="12345",
            source_type="f95zone",
            is_identified=True,
            file_type="folder",
            is_ignored=False,
            missing_scan_count=0,
            sources=[],
            cover_url=None,
            description=None,
            screenshots=[],
        )

        self.assertTrue(should_include_in_missing_source_scan(missing_source))
        self.assertFalse(should_include_in_missing_source_scan(metadata_only_gap))

    def test_missing_source_scan_excludes_valid_preferred_source_even_when_main_fields_are_stale(self):
        game = SimpleNamespace(
            title="Linked Itch Game",
            raw_name="LinkedItchGame",
            source_url=None,
            source_id=None,
            source_type="unknown",
            is_identified=False,
            file_type="folder",
            is_ignored=False,
            missing_scan_count=0,
            sources=[
                SimpleNamespace(
                    source_type="itch",
                    source_url="https://studio.itch.io/linked-game",
                    source_id=None,
                    is_preferred=True,
                )
            ],
        )

        self.assertFalse(should_include_in_missing_source_scan(game))

    def test_missing_source_scan_excludes_hidden_ignored_and_wishlist_entries(self):
        base = {
            "title": "Unlinked",
            "raw_name": "Unlinked",
            "source_url": None,
            "source_id": None,
            "source_type": "unknown",
            "is_identified": False,
            "file_type": "folder",
            "is_ignored": False,
            "missing_scan_count": 0,
            "sources": [],
        }

        self.assertFalse(should_include_in_missing_source_scan(SimpleNamespace(**{**base, "is_ignored": True})))
        self.assertFalse(should_include_in_missing_source_scan(SimpleNamespace(**{**base, "file_type": "wishlist"})))
        self.assertFalse(should_include_in_missing_source_scan(SimpleNamespace(**{**base, "missing_scan_count": 1})))

    def test_score_candidate_match_prefers_exact_title_and_matching_creator(self):
        exact = score_candidate_match(
            "DesertStalker-v0.18.2-PC",
            {
                "title": "Desert Stalker",
                "creator": "Zetan",
                "source_type": "f95zone",
                "url": "https://f95zone.to/threads/12345/",
            },
            developer_hint="Zetan",
        )
        partial = score_candidate_match(
            "DesertStalker-v0.18.2-PC",
            {
                "title": "Desert Stalker Remake",
                "creator": "Another Dev",
                "source_type": "itch",
                "url": "https://anotherdev.itch.io/desert-stalker-remake",
            },
            developer_hint="Zetan",
        )

        self.assertEqual(exact["confidence"], "high")
        self.assertGreater(exact["score"], partial["score"])
        self.assertIn("Exact normalized title match", exact["reasons"])

    def test_choose_best_candidate_prefers_f95zone_when_scores_tie(self):
        best = choose_best_candidate(
            [
                {
                    "title": "Desert Stalker",
                    "creator": "Zetan",
                    "source_type": "itch",
                    "score": 91,
                    "confidence": "high",
                    "url": "https://zetan.itch.io/desert-stalker",
                },
                {
                    "title": "Desert Stalker",
                    "creator": "Zetan",
                    "source_type": "f95zone",
                    "score": 91,
                    "confidence": "high",
                    "url": "https://f95zone.to/threads/12345/",
                },
            ]
        )

        self.assertIsNotNone(best)
        self.assertEqual(best["source_type"], "f95zone")

    def test_auto_match_requires_one_extremely_high_confidence_winner(self):
        clear_winner = {
            "title": "Desert Stalker",
            "source_type": "f95zone",
            "source_id": "12345",
            "url": "https://f95zone.to/threads/12345/",
            "score": 98,
            "confidence": "high",
        }
        ambiguous = {
            "title": "Desert Stalker",
            "source_type": "itch",
            "url": "https://zetan.itch.io/desert-stalker",
            "score": 96,
            "confidence": "high",
        }

        self.assertEqual(choose_unambiguous_auto_match([clear_winner]), clear_winner)
        self.assertIsNone(choose_unambiguous_auto_match([clear_winner, ambiguous]))

    def test_review_item_exposes_canonical_candidate_contract(self):
        game = SimpleNamespace(
            id=42,
            title="Desert Stalker",
            raw_name="DesertStalker-v0.18.2-PC",
            folder_path=r"D:\\Games\\DesertStalker-v0.18.2-PC",
            cover_url=None,
            description=None,
            developer=None,
            rating=None,
            screenshots=[],
            source_url=None,
            source_id=None,
        )
        candidate = {
            "source_type": "f95zone",
            "source_id": "12345",
            "url": "https://f95zone.to/threads/12345/",
            "title": "Desert Stalker",
            "creator": "Zetan",
            "cover": "https://example.com/cover.jpg",
            "version": "v0.18.2",
            "score": 84,
            "confidence": "medium",
            "reasons": ["Exact normalized title match", "Developer/circle partial match"],
        }

        item = build_missing_source_review_item(game, status="review", candidates=[candidate])

        self.assertEqual(item["game_id"], 42)
        self.assertEqual(item["local_title"], "Desert Stalker")
        self.assertEqual(item["raw_name"], "DesertStalker-v0.18.2-PC")
        self.assertEqual(item["folder_path"], game.folder_path)
        self.assertEqual(item["candidate"]["source_url"], candidate["url"])
        self.assertEqual(item["confidence"], 0.84)
        self.assertEqual(
            item["match_reason"],
            ["normalized_title_match", "developer_partial_match"],
        )

    def test_choose_review_thumbnail_prefers_candidate_cover_then_existing_cover(self):
        game = SimpleNamespace(cover_url="https://example.com/current-cover.jpg")

        self.assertEqual(
            choose_review_thumbnail({"cover": "https://example.com/candidate-cover.jpg"}, game),
            "https://example.com/candidate-cover.jpg",
        )
        self.assertEqual(
            choose_review_thumbnail({}, game),
            "https://example.com/current-cover.jpg",
        )

    def test_applying_candidate_twice_creates_one_preferred_source_and_preserves_manual_title(self):
        engine = create_engine("sqlite:///:memory:", connect_args={"check_same_thread": False})
        Base.metadata.create_all(engine)
        db = sessionmaker(bind=engine, expire_on_commit=False)()
        try:
            game = Game(
                title="My Manual Name",
                raw_name="FolderGame-v1.0",
                folder_path="C:/Games/FolderGame-v1.0",
                file_type="folder",
                title_is_manual=True,
                local_version="v1.0",
                local_version_is_manual=True,
            )
            db.add(game)
            db.commit()
            candidate = {
                "source_type": "itch",
                "source_url": "https://studio.itch.io/folder-game/",
                "source_id": None,
                "title": "Remote Name",
                "creator": "Remote Dev",
                "cover": "https://example.com/cover.jpg",
                "version": "v1.2",
            }

            with patch("backend.smart_scan.fetch_source_metadata", return_value={"developer": "Remote Dev"}), patch(
                "backend.smart_scan.persist_game_snapshot"
            ):
                apply_missing_source_candidate(game, db, candidate, force_overwrite=True)
                apply_missing_source_candidate(
                    game,
                    db,
                    {**candidate, "source_url": candidate["source_url"].rstrip("/")},
                    force_overwrite=True,
                )

            self.assertEqual(game.title, "My Manual Name")
            self.assertEqual(game.folder_path, "C:/Games/FolderGame-v1.0")
            self.assertEqual(game.local_version, "v1.0")
            self.assertTrue(game.local_version_is_manual)
            self.assertEqual(len(game.sources), 1)
            self.assertTrue(game.sources[0].is_preferred)
        finally:
            db.close()
            engine.dispose()

    def test_skip_review_removes_only_the_selected_unresolved_item(self):
        import backend.main as main

        start_job("missing-source-scan", 2, "Missing source scan")
        set_job_context(
            "missing-source-scan",
            result={
                "review_items": [
                    {"game_id": 1, "status": "review"},
                    {"game_id": 2, "status": "review"},
                ]
            },
        )

        response = main.skip_missing_source_review_candidate(1)

        self.assertEqual(response["status"], "skipped")
        self.assertEqual(get_job("missing-source-scan")["result"]["review_items"], [{"game_id": 2, "status": "review"}])


if __name__ == "__main__":
    unittest.main()
