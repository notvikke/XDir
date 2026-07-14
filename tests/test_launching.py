import os
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from tempfile import TemporaryDirectory


class LaunchingTests(unittest.TestCase):
    def _load_module(self):
        import importlib
        import importlib.util

        spec = importlib.util.find_spec("backend.launching")
        self.assertIsNotNone(
            spec,
            "Expected a backend.launching module for launch-target resolution and playtime accumulation.",
        )
        return importlib.import_module("backend.launching")

    def test_choose_launch_executable_prefers_folder_named_binary_over_helpers(self):
        launching = self._load_module()

        with TemporaryDirectory() as tmp_dir:
            game_dir = Path(tmp_dir) / "Example Game"
            game_dir.mkdir()
            (game_dir / "UnityCrashHandler64.exe").write_bytes(b"x" * 600)
            (game_dir / "launcher.exe").write_bytes(b"x" * 1500)
            (game_dir / "Example Game.exe").write_bytes(b"x" * 900)

            chosen = launching.choose_launch_executable(game_dir)

            self.assertEqual(chosen, (game_dir / "Example Game.exe").resolve())

    def test_choose_launch_executable_ignores_uninstallers_and_setup_helpers(self):
        launching = self._load_module()

        with TemporaryDirectory() as tmp_dir:
            game_dir = Path(tmp_dir) / "Another Title"
            game_dir.mkdir()
            (game_dir / "unins000.exe").write_bytes(b"x" * 800)
            (game_dir / "setup.exe").write_bytes(b"x" * 1200)
            (game_dir / "another-title.exe").write_bytes(b"x" * 700)

            chosen = launching.choose_launch_executable(game_dir)

            self.assertEqual(chosen, (game_dir / "another-title.exe").resolve())

    def test_calculate_session_seconds_clamps_negative_durations(self):
        launching = self._load_module()
        end_time = datetime(2026, 7, 10, 12, 0, 0)
        start_time = end_time + timedelta(seconds=30)

        self.assertEqual(launching.calculate_session_seconds(start_time, end_time), 0)

    def test_accumulate_playtime_increments_total_and_session_count(self):
        launching = self._load_module()
        start_time = datetime(2026, 7, 10, 10, 0, 0)
        end_time = start_time + timedelta(minutes=42, seconds=5)

        total_seconds, session_count, last_played = launching.accumulate_playtime(
            3600,
            3,
            start_time,
            end_time,
        )

        self.assertEqual(total_seconds, 3600 + (42 * 60) + 5)
        self.assertEqual(session_count, 4)
        self.assertEqual(last_played, start_time)


if __name__ == "__main__":
    unittest.main()
