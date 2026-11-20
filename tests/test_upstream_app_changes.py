import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts import upstream_app_changes as m


def sh(repo, *args):
    subprocess.run(["git", "-C", repo, *args], check=True, capture_output=True)


class UpstreamAppChanges(unittest.TestCase):
    def test_groups_by_app_and_area(self):
        changes = [("M", "apps/mobile/lib/thread/a.ts"), ("A", "apps/mobile/lib/thread/b.ts"),
                   ("M", "apps/web/src/x/y.ts"), ("D", "apps/mobile/app.json")]
        groups = m.summarise(changes)
        self.assertEqual(groups["mobile"]["lib/thread"], 2)
        self.assertEqual(groups["mobile"]["(app root)"], 1)
        self.assertEqual(groups["web"]["src/x"], 1)
        text = m.report("v1.0.0", "v1.1.0", changes)
        self.assertLess(text.index("apps/mobile"), text.index("apps/web"))

    def test_real_repo_between_tags(self):
        with tempfile.TemporaryDirectory() as repo:
            sh(repo, "init", "-q")
            sh(repo, "config", "user.email", "t@example.invalid")
            sh(repo, "config", "user.name", "t")
            Path(repo, "apps/mobile/lib").mkdir(parents=True)
            Path(repo, "apps/mobile/lib/a.ts").write_text("1")
            sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "one"); sh(repo, "tag", "v1.0.0")
            self.assertEqual(m.main(["--repo", repo, "--from", "v1.0.0", "--to", "v1.0.0"]), 0)
            Path(repo, "apps/mobile/lib/a.ts").write_text("2")
            Path(repo, "README.md").write_text("x")
            sh(repo, "add", "-A"); sh(repo, "commit", "-qm", "two"); sh(repo, "tag", "v1.2.0")
            self.assertEqual(m.newest_tag(repo), "v1.2.0")
            self.assertEqual(m.main(["--repo", repo, "--from", "v1.0.0"]), 10)


class RepinGate(unittest.TestCase):
    def test_pin_moves_only_after_the_app_is_marked_updated(self):
        from scripts import sync_upstream as s
        with tempfile.TemporaryDirectory() as d:
            f = Path(d, "reviewed.txt")
            f.write_text('{"version": "1.2.0", "upstream": "v0.11.0"}')
            self.assertFalse(s.app_reviewed_for("v0.13.0", f))
            f.write_text('{"upstream": "v0.13.0"}')
            self.assertTrue(s.app_reviewed_for("v0.13.0", f))
            self.assertTrue(s.app_reviewed_for("v0.12.0", f))
            self.assertFalse(s.app_reviewed_for("v0.13.0", Path(d, "missing.txt")))
            f.write_text('{"upstream": "latest"}')
            self.assertFalse(s.app_reviewed_for("v0.13.0", f), "only a release tag counts")
            f.write_text("not json")
            self.assertFalse(s.app_reviewed_for("v0.13.0", f))


if __name__ == "__main__":
    unittest.main()
