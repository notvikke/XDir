import importlib
import importlib.util
import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory


class LibraryDirectoryTests(unittest.TestCase):
    def _load_config_module(self):
        spec = importlib.util.find_spec("backend.config")
        self.assertIsNotNone(
            spec,
            "Expected backend.config to be importable for directory-list normalization.",
        )
        return importlib.import_module("backend.config")

    def _load_scanner_module(self):
        spec = importlib.util.find_spec("backend.scanner")
        self.assertIsNotNone(
            spec,
            "Expected backend.scanner to be importable for multi-root scanning.",
        )
        return importlib.import_module("backend.scanner")

    def test_get_settings_promotes_legacy_games_dir_into_games_dirs(self):
        config = self._load_config_module()

        with TemporaryDirectory() as tmp_dir:
            settings_path = Path(tmp_dir) / "settings.json"
            settings_path.write_text(
                json.dumps(
                    {
                        "games_dir": r"D:\Games",
                        "preferred_source": "itch",
                    }
                ),
                encoding="utf-8",
            )

            original_settings_file = config.SETTINGS_FILE
            config.SETTINGS_FILE = str(settings_path)
            try:
                settings = config.get_settings()
            finally:
                config.SETTINGS_FILE = original_settings_file

        self.assertEqual(settings["games_dir"], r"D:\Games")
        self.assertEqual(settings["games_dirs"], [r"D:\Games"])
        self.assertEqual(settings["preferred_source"], "itch")

    def test_scan_games_directories_collects_entries_from_every_root(self):
        scanner = self._load_scanner_module()
        self.assertTrue(
            hasattr(scanner, "scan_games_directories"),
            "Expected backend.scanner to expose scan_games_directories() for multi-root discovery.",
        )

        with TemporaryDirectory() as tmp_dir:
            root_a = Path(tmp_dir) / "Games A"
            root_b = Path(tmp_dir) / "Games B"
            (root_a / "Game One").mkdir(parents=True)
            (root_b / "Game Two").mkdir(parents=True)
            (root_a / "Game One" / "run.exe").write_bytes(b"exe")
            (root_b / "Game Two" / "play.exe").write_bytes(b"exe")

            results = scanner.scan_games_directories([root_a, root_b])

        scanned_paths = {item["folder_path"] for item in results}
        self.assertIn(str((root_a / "Game One").resolve()), scanned_paths)
        self.assertIn(str((root_b / "Game Two").resolve()), scanned_paths)


if __name__ == "__main__":
    unittest.main()
