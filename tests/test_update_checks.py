import unittest

from backend.update_checks import compare_versions, derive_update_status


class UpdateCheckTests(unittest.TestCase):
    def test_compare_versions_understands_numeric_release_order(self):
        self.assertLess(compare_versions("1.0", "1.1"), 0)
        self.assertGreater(compare_versions("2.0", "1.9"), 0)
        self.assertEqual(compare_versions("v1.2.0", "1.2"), 0)

    def test_derive_update_status_only_confirms_newer_remote_versions(self):
        self.assertEqual(derive_update_status("1.0", "1.1"), ("update_available", True))
        self.assertEqual(derive_update_status("2.0", "1.9"), ("version_differs", False))
        self.assertEqual(derive_update_status("1.0", "1.0"), ("up_to_date", False))

    def test_derive_update_status_explains_unknown_versions(self):
        self.assertEqual(derive_update_status(None, "1.0"), ("local_version_unknown", False))
        self.assertEqual(derive_update_status("1.0", None), ("remote_version_unavailable", False))

    def test_non_numeric_version_labels_are_differences_not_confirmed_updates(self):
        self.assertEqual(derive_update_status("Alpha", "Final"), ("version_differs", False))


if __name__ == "__main__":
    unittest.main()
