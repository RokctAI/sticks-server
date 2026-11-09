import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sync_upstream as s  # noqa: E402
import render_env  # noqa: E402
import extract_used_procedures as x  # noqa: E402
import stick_defaults as d  # noqa: E402

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

    def test_area_grouping_and_watch_flag(self):
        numstat = "3\t1\tapps/mobile/app/chat.tsx\n10\t0\tapps/web/src/a.tsx\n2\t2\tapps/api/src/x.ts\n-\t-\tapps/www/img.png\n1\t1\tsomething.txt\n"
        summary = s.summarize_diff(numstat)
        self.assertEqual(summary["Mobile app"]["added"], 3)
        self.assertEqual(summary["Web app"]["files"], ["apps/web/src/a.tsx"])
        self.assertIn("Other", summary)
        self.assertEqual(summary["Website"]["added"], 0)  # binary file counts as 0
        text = s.format_changes(summary)
        self.assertIn("CHECK BY HAND", text)
        self.assertIn("Mobile app", text)
        self.assertNotIn("Desktop app", text.split("CHECK BY HAND")[1].split("Changed files")[0])

    def test_no_client_change_message(self):
        text = s.format_changes(s.summarize_diff("1\t1\tapps/api/src/x.ts\n"))
        self.assertIn("No change in the mobile, web or desktop apps.", text)
        self.assertNotIn("CHECK BY HAND", text)

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

    def test_extractor_reads_literals_and_skips_media_types(self):
        dart = "post('threads/send'); h = 'application/json'; c = 'image/png'; x('bots/list'); y = \"a/b\";"
        self.assertEqual(x.extract(dart), {"threads/send", "bots/list"})

    def test_checked_in_list_matches_format(self):
        text = (Path(__file__).resolve().parent.parent / "contracts" / "used-procedures.txt").read_text()
        listed = x.read_list(text)
        self.assertEqual(listed, sorted(listed))
        self.assertGreater(len(listed), 100)

    def test_render_refuses_missing_digest(self):
        pin = {"TAG": "v0.9.0", "APP_IMAGE": "a", "COMPUTER_IMAGE": "c", "APP_IMAGE_DIGEST": "sha256:1"}
        with self.assertRaises(ValueError):
            render_env.render(pin)
        self.assertIn("RAKAZO_COMPUTER_IMAGE_TAG=v0.9.0\n", render_env.render(pin, allow_unpinned=True))

    def test_defaults_block_is_added_once_and_replaced(self):
        once = d.apply_block("You are Zinhle.")
        self.assertTrue(once.startswith("You are Zinhle."))
        self.assertIn("ticket_create", once)
        self.assertEqual(d.apply_block(once), once)  # idempotent
        edited = once.replace("ticket_create", "XX")
        self.assertEqual(d.apply_block(edited), once)  # edited-away text is restored
        self.assertEqual(d.apply_block(""), d.default_block() + "\n")
        self.assertEqual(d.remove_block(once).strip(), "You are Zinhle.")

    def test_defaults_block_handles_a_broken_marker(self):
        broken = "Mine.\n" + d.START + "\nhalf"
        out = d.apply_block(broken)
        self.assertEqual(out.count(d.START), 1)
        self.assertEqual(out.count(d.END), 1)
        self.assertIn("Mine.", out)


if __name__ == "__main__":
    unittest.main()
