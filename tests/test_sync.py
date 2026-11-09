import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sync_upstream as s  # noqa: E402
import render_env  # noqa: E402

LS = """\
aaa\trefs/tags/v0.8.0
bbb\trefs/tags/v0.10.0
ccc\trefs/tags/v0.9.1
ddd\trefs/tags/android
eee\trefs/tags/v0.9.0-rc1
"""

RPC = """\
export const router = {
  bots: {
    list: oc.output(x),
    create: oc
      .input(y),
  },
  threads: {
    subscribe: oc.output(eventIterator(z)),
  },
};
"""

CHANGELOG = """\
# Changelog

## [Unreleased]

### Changed

- unreleased thing

## [0.9.0] - 2026-11-06

### Added

- shiny

### Changed

- group messages go to every bot

## [0.8.0] - 2026-11-04

### Changed

- old thing
"""


class SyncTests(unittest.TestCase):
    def test_newest_tag_ignores_non_release_and_sorts_numerically(self):
        self.assertEqual(s.newest_tag(LS), "v0.10.0")
        self.assertIsNone(s.newest_tag("x\trefs/tags/android\n"))

    def test_series_skips_comments(self):
        self.assertEqual(s.parse_series("# c\n\na.patch\n  b.patch \n"), ["a.patch", "b.patch"])

    def test_contract_procedures(self):
        self.assertEqual(s.contract_procedures(RPC), {"bots/list", "bots/create", "threads/subscribe"})

    def test_changelog_since_only_between_pin_and_new(self):
        out = s.changelog_since(CHANGELOG, "v0.8.0", "v0.9.0")
        self.assertIn("group messages go to every bot", out)
        self.assertNotIn("old thing", out)
        self.assertNotIn("unreleased thing", out)
        self.assertNotIn("shiny", out)  # Added is not in the kept headings

    def test_pin_file_and_render(self):
        pin = s.read_pin(Path(__file__).resolve().parent.parent / "upstream.pin")
        self.assertTrue(s.tag_key(pin["TAG"]))
        out = render_env.render(pin)
        self.assertIn(f"RAKAZO_IMAGE_TAG={pin['TAG']}@sha256:", out)

    def test_used_procedures_file_parses(self):
        text = (Path(__file__).resolve().parent.parent / "contracts" / "used-procedures.txt").read_text()
        used = s.used_procedures(text)
        self.assertIn("threads/subscribe", used)
        self.assertTrue(all("/" in u for u in used))


if __name__ == "__main__":
    unittest.main()
