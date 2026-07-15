import importlib
import importlib.util
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace


def _make_source(url: str, source_type: str = "f95zone", source_id: str = "12345", preferred: bool = True):
    return SimpleNamespace(
        source_type=source_type,
        source_url=url,
        source_id=source_id,
        title_reported="Example Game",
        version_reported="v1.2",
        is_preferred=preferred,
        added_at=datetime(2026, 7, 10, 10, 0, 0),
    )


def _make_game(path: str, file_type: str = "folder", title: str = "Example Game"):
    return SimpleNamespace(
        title=title,
        raw_name=Path(path).name if path else "wishlist_123",
        category="Games",
        folder_path=path,
        file_type=file_type,
        archive_name=Path(path).name if file_type == "archive" and path else None,
        size_bytes=2048,
        source_type="f95zone",
        source_url="https://f95zone.to/threads/12345/",
        source_id="12345",
        is_identified=True,
        local_version="v1.0",
        latest_version="v1.2",
        update_available=True,
        last_update_check_at=datetime(2026, 7, 11, 12, 0, 0),
        last_update_check_status="update_available",
        last_update_check_error=None,
        update_detected_at=datetime(2026, 7, 11, 12, 0, 1),
        local_version_is_manual=True,
        title_is_manual=True,
        rating="4.5 / 5",
        developer="Dev Team",
        release_date="2026-07-10",
        cover_url="https://example.com/cover.jpg",
        description="Portable export payload",
        playing_progress="playing",
        user_score="4",
        is_ignored=False,
        added_at=datetime(2026, 7, 1, 8, 30, 0),
        last_played=datetime(2026, 7, 9, 21, 0, 0),
        last_seen_at=datetime(2026, 7, 10, 9, 0, 0),
        sources=[_make_source("https://f95zone.to/threads/12345/")],
        screenshots=[SimpleNamespace(url="https://example.com/shot-1.jpg", local_path=None)],
        tags=[SimpleNamespace(tag_name="RPGM")],
        custom_tags=[SimpleNamespace(tag_name="Favorite")],
        journal_entries=[SimpleNamespace(entry_text="Reached chapter 2", created_at=datetime(2026, 7, 9, 22, 0, 0))],
    )


class LibraryPortabilityTests(unittest.TestCase):
    def _load_module(self):
        spec = importlib.util.find_spec("backend.library_portability")
        self.assertIsNotNone(
            spec,
            "Expected a backend.library_portability module that owns the portable export/import helpers.",
        )
        return importlib.import_module("backend.library_portability")

    def test_build_export_manifest_uses_relative_paths_and_keeps_wishlist_portable(self):
        portability = self._load_module()
        self.assertTrue(
            hasattr(portability, "build_export_manifest"),
            "Expected backend.library_portability to expose build_export_manifest().",
        )

        with TemporaryDirectory() as tmp_dir:
            games_root = Path(tmp_dir) / "Game setups"
            (games_root / "Series" / "Example Game").mkdir(parents=True)
            (games_root / "Loose.zip").write_bytes(b"zip")

            folder_game = _make_game(str((games_root / "Series" / "Example Game").resolve()), "folder")
            archive_game = _make_game(str((games_root / "Loose.zip").resolve()), "archive", title="Loose Archive")
            wishlist_game = _make_game("wishlist_123", "wishlist", title="Wishlist Entry")

            manifest = portability.build_export_manifest(
                games_root,
                [folder_game, archive_game, wishlist_game],
                {
                    "games_dir": str(games_root),
                    "games_dirs": [str(games_root), str((games_root / "Extra").resolve())],
                    "archive_mode": "explorer",
                    "preferred_source": "itch",
                    "startup_scan": True,
                    "missing_grace_scans": 3,
                },
                {"version": 1, "entries": [{"source_url": "https://f95zone.to/threads/12345/"}]},
            )

            self.assertEqual(manifest["games"][0]["relative_path"], "Series/Example Game")
            self.assertEqual(manifest["games"][1]["relative_path"], "Loose.zip")
            self.assertIsNone(manifest["games"][2]["relative_path"])
            self.assertEqual(manifest["settings"]["preferred_source"], "itch")
            self.assertNotIn("games_dir", manifest["settings"])
            self.assertNotIn("games_dirs", manifest["settings"])
            self.assertEqual(manifest["source_map"]["entries"][0]["source_url"], "https://f95zone.to/threads/12345/")
            self.assertIn("total_playtime_seconds", manifest["games"][0])
            self.assertIn("play_session_count", manifest["games"][0])
            self.assertIn("last_played", manifest["games"][0])
            self.assertEqual("2026-07-11T12:00:00", manifest["games"][0]["last_update_check_at"])
            self.assertEqual("update_available", manifest["games"][0]["last_update_check_status"])
            self.assertEqual("2026-07-11T12:00:01", manifest["games"][0]["update_detected_at"])
            self.assertTrue(manifest["games"][0]["local_version_is_manual"])
            self.assertTrue(manifest["games"][0]["title_is_manual"])

    def test_write_export_bundle_embeds_only_manifest_and_no_library_file_payload(self):
        portability = self._load_module()
        self.assertTrue(
            hasattr(portability, "write_export_bundle"),
            "Expected backend.library_portability to expose write_export_bundle().",
        )

        with TemporaryDirectory() as tmp_dir:
            games_root = Path(tmp_dir) / "Game setups"
            game_dir = games_root / "Series" / "Example Game"
            game_dir.mkdir(parents=True)
            (game_dir / "run.exe").write_bytes(b"exe")
            (games_root / "Loose.zip").write_bytes(b"zip")

            manifest = portability.build_export_manifest(
                games_root,
                [
                    _make_game(str(game_dir.resolve()), "folder"),
                    _make_game(str((games_root / "Loose.zip").resolve()), "archive", title="Loose Archive"),
                ],
                {"archive_mode": "explorer", "preferred_source": "f95zone"},
                {"version": 1, "entries": []},
            )

            export_path = Path(tmp_dir) / "backup.xdir.zip"
            portability.write_export_bundle(export_path, games_root, manifest)

            self.assertTrue(export_path.exists())
            with zipfile.ZipFile(export_path, "r") as bundle:
                names = set(bundle.namelist())

            self.assertIn("manifest.json", names)
            self.assertNotIn("library/Series/Example Game/run.exe", names)
            self.assertNotIn("library/Loose.zip", names)

    def test_resolve_import_destination_blocks_path_traversal(self):
        portability = self._load_module()
        self.assertTrue(
            hasattr(portability, "resolve_import_destination"),
            "Expected backend.library_portability to expose resolve_import_destination().",
        )

        with TemporaryDirectory() as tmp_dir:
            games_root = Path(tmp_dir).resolve()
            resolved = portability.resolve_import_destination(games_root, "Series/Example Game")

            self.assertEqual(resolved, (games_root / "Series" / "Example Game").resolve())

            with self.assertRaises(ValueError):
                portability.resolve_import_destination(games_root, "../evil.txt")

            with self.assertRaises(ValueError):
                portability.resolve_import_destination(games_root, "C:/Windows/system32")

    def test_needs_metadata_refresh_requires_a_linked_source_and_missing_media(self):
        portability = self._load_module()
        self.assertTrue(
            hasattr(portability, "needs_metadata_refresh"),
            "Expected backend.library_portability to expose needs_metadata_refresh().",
        )

        self.assertTrue(
            portability.needs_metadata_refresh(
                {
                    "source_type": "f95zone",
                    "source_url": "https://f95zone.to/threads/12345/",
                    "source_id": "12345",
                    "cover_url": None,
                    "screenshots": [],
                    "description": "Already has text",
                    "developer": "Dev Team",
                }
            )
        )
        self.assertFalse(
            portability.needs_metadata_refresh(
                {
                    "source_type": "unknown",
                    "source_url": None,
                    "source_id": None,
                    "cover_url": None,
                    "screenshots": [],
                }
            )
        )
        self.assertFalse(
            portability.needs_metadata_refresh(
                {
                    "source_type": "f95zone",
                    "source_url": "https://f95zone.to/threads/12345/",
                    "source_id": "12345",
                    "cover_url": "https://example.com/cover.jpg",
                    "screenshots": ["https://example.com/shot-1.jpg"],
                    "description": "Portable export payload",
                    "developer": "Dev Team",
                }
            )
        )


if __name__ == "__main__":
    unittest.main()
