"""Patches copied from upstream PRs: the header line, the PR status and dropping on a repin."""
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import sync_upstream as s  # noqa: E402

COPIED = "Keep long email bodies\n\nUpstream: elie222/rakazo#6961\n\ndiff --git a/x b/x\n+Upstream: other/repo#1\n"
OURS = "diff --git a/x b/x\n+Upstream: elie222/rakazo#5\n"


def fake(prs, compare):
    def fetch(path):
        if "/compare/" in path:
            return compare
        return prs
    return fetch


class UpstreamPr(unittest.TestCase):
    def test_header_line(self):
        self.assertEqual(s.upstream_pr(COPIED), ("elie222/rakazo", 6961))

    def test_only_the_header_counts(self):
        self.assertIsNone(s.upstream_pr(OURS))
        self.assertIsNone(s.upstream_pr("Our own change\n\ndiff --git a/x b/x\n+Upstream: a/b#2\n"))

    def test_carried_lists_only_copied_patches(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "0001-ours.patch").write_text(OURS)
            (p / "0002-copied.patch").write_text(COPIED)
            self.assertEqual(s.carried_prs(p, ["0001-ours.patch", "0002-copied.patch", "0003-missing.patch"]),
                             [("0002-copied.patch", "elie222/rakazo", 6961)])


class PrStatus(unittest.TestCase):
    def test_merged_and_in_tag(self):
        f = fake({"merged_at": "x", "merge_commit_sha": "abc", "state": "closed"}, {"status": "ahead"})
        self.assertEqual(s.pr_status("elie222/rakazo", 1, "v0.17.0", f), "in_tag")
        f = fake({"merged_at": "x", "merge_commit_sha": "abc", "state": "closed"}, {"status": "identical"})
        self.assertEqual(s.pr_status("elie222/rakazo", 1, "v0.17.0", f), "in_tag")

    def test_merged_after_the_tag(self):
        f = fake({"merged_at": "x", "merge_commit_sha": "abc", "state": "closed"}, {"status": "behind"})
        self.assertEqual(s.pr_status("elie222/rakazo", 1, "v0.16.0", f), "merged_not_released")

    def test_open_closed_unknown(self):
        self.assertEqual(s.pr_status("a/b", 1, "v1.0.0", fake({"state": "open"}, None)), "open")
        self.assertEqual(s.pr_status("a/b", 1, "v1.0.0", fake({"state": "closed", "merged_at": None}, None)),
                         "closed_unmerged")
        self.assertEqual(s.pr_status("a/b", 1, "v1.0.0", fake(None, None)), "unknown")
        f = fake({"merged_at": "x", "merge_commit_sha": "abc"}, None)
        self.assertEqual(s.pr_status("a/b", 1, "v1.0.0", f), "unknown")

    def test_report_lines(self):
        text = s.format_carried([("0002-c.patch", "elie222/rakazo", 6961, "in_tag"),
                                 ("0003-d.patch", "elie222/rakazo", 7000, "closed_unmerged")], "v0.17.0")
        self.assertIn("elie222/rakazo#6961 is in `v0.17.0`", text)
        self.assertIn("CLOSED WITHOUT MERGING", text)
        self.assertIn("None", s.format_carried([], "v0.17.0"))


class Drop(unittest.TestCase):
    def test_drop_removes_series_line_and_file(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            (p / "series").write_text("# our patches\n0001-a.patch\n0002-b.patch\n")
            (p / "0001-a.patch").write_text(OURS)
            (p / "0002-b.patch").write_text(COPIED)
            s.drop_patches(p, ["0002-b.patch"])
            self.assertEqual((p / "series").read_text(), "# our patches\n0001-a.patch\n")
            self.assertFalse((p / "0002-b.patch").exists())
            self.assertTrue((p / "0001-a.patch").exists())


if __name__ == "__main__":
    unittest.main()
