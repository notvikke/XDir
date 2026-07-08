import unittest
from types import SimpleNamespace

from backend.smart_scan import (
    build_source_search_order,
    choose_best_candidate,
    choose_review_thumbnail,
    score_candidate_match,
    should_include_in_missing_source_scan,
    should_include_in_smart_scan,
)
from backend.title_normalization import generate_query_candidates


class SmartScanTests(unittest.TestCase):
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

    def test_should_include_in_smart_scan_flags_unresolved_games(self):
        unresolved = SimpleNamespace(
            title="DesertStalker-v0.18.2-PC",
            raw_name="DesertStalker-v0.18.2-PC",
            source_url=None,
            source_id=None,
            source_type="unknown",
            is_identified=False,
            developer=None,
            description=None,
            rating=None,
            cover_url=None,
            screenshots=[],
        )
        resolved = SimpleNamespace(
            title="Desert Stalker",
            raw_name="DesertStalker-v0.18.2-PC",
            source_url="https://f95zone.to/threads/12345/",
            source_id="12345",
            source_type="f95zone",
            is_identified=True,
            developer="Zetan",
            description="A desert survival VN.",
            rating="4.5 / 5",
            cover_url="https://example.com/cover.jpg",
            screenshots=["https://example.com/shot-1.jpg"],
        )

        self.assertTrue(should_include_in_smart_scan(unresolved))
        self.assertFalse(should_include_in_smart_scan(resolved))

    def test_should_include_in_missing_source_scan_only_targets_games_without_main_source(self):
        missing_source = SimpleNamespace(
            title="Fresh Folder Game",
            raw_name="FreshFolderGame",
            source_url=None,
            source_id=None,
            source_type="unknown",
            is_identified=False,
            file_type="folder",
            is_ignored=False,
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
            cover_url=None,
            description=None,
            screenshots=[],
        )

        self.assertTrue(should_include_in_missing_source_scan(missing_source))
        self.assertFalse(should_include_in_missing_source_scan(metadata_only_gap))

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


if __name__ == "__main__":
    unittest.main()
