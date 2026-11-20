"""Task 24: every patch is applied. The Engine CI job (scripts/build_engine.py) applies patches/series to the
pinned tag on every PR and fails with exit 3 when one does not apply. This test closes the gap: a .patch file
that is not listed in series would never be tried, and a listed name with no file would break the build."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from sync_upstream import parse_series  # noqa: E402


class PatchSeriesTest(unittest.TestCase):
    def test_series_lists_every_patch_file_and_nothing_else(self):
        series = parse_series((ROOT / "patches" / "series").read_text(encoding="utf-8"))
        files = sorted(p.name for p in (ROOT / "patches").glob("*.patch"))
        self.assertEqual(sorted(series), files)
        self.assertEqual(len(series), len(set(series)), "a patch is listed twice")


if __name__ == "__main__":
    unittest.main()
