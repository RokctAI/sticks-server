import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_engine as b  # noqa: E402
import sync_upstream as up  # noqa: E402


class OverlayRules(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="overlay-test-"))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write(self, root: Path, rel: str, text: str = "x") -> None:
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")

    def test_overlay_files_skip_the_readme_and_keep_nested_paths(self):
        ov = self.tmp / "overlay"
        self.write(ov, "README.md", "docs")
        self.write(ov, "apps/sticks-engine/src/index.ts")
        self.write(ov, "apps/sticks-engine/src/index.test.ts")
        self.assertEqual(b.overlay_files(ov), [
            "apps/sticks-engine/src/index.test.ts",
            "apps/sticks-engine/src/index.ts",
        ])

    def test_readme_at_a_nested_path_is_copied(self):
        ov = self.tmp / "overlay"
        self.write(ov, "apps/sticks-engine/README.md", "not the top one")
        self.assertEqual(b.overlay_files(ov), ["apps/sticks-engine/README.md"])

    def test_collision_with_upstream_file_is_reported(self):
        up_root = self.tmp / "upstream"
        self.write(up_root, "packages/core/src/index.ts", "upstream")
        self.write(up_root, "other.ts", "upstream")
        files = ["packages/core/src/index.ts", "apps/sticks-engine/src/new.ts"]
        self.assertEqual(b.collisions(files, up_root), ["packages/core/src/index.ts"])

    def test_no_collision_when_all_paths_are_new(self):
        up_root = self.tmp / "upstream"
        self.write(up_root, "packages/core/src/index.ts")
        self.assertEqual(b.collisions(["apps/sticks-engine/src/new.ts"], up_root), [])

    def test_overlay_test_files_selects_vitest_files_only(self):
        files = [
            "apps/sticks-engine/src/a.test.ts",
            "apps/sticks-engine/src/b.test.tsx",
            "apps/sticks-engine/src/c.ts",
            "apps/sticks-engine/src/d.test.js",
        ]
        self.assertEqual(b.overlay_test_files(files), [
            "apps/sticks-engine/src/a.test.ts",
            "apps/sticks-engine/src/b.test.tsx",
        ])

    def test_checked_in_overlay_code_lives_under_apps(self):
        # Every file in overlay/ is copied into the engine build. Code must sit under apps/, so a stray
        # file at the top level (or a root package.json that would change the lockfile) is caught here.
        files = b.overlay_files(ROOT / "overlay")
        self.assertTrue(files, "overlay/ should hold the engine app")
        stray = [f for f in files if not f.startswith("apps/")]
        self.assertEqual(stray, [])


class EngineAndToolVersions(unittest.TestCase):
    def test_node_range_from_upstream_engines(self):
        engines = "^24.15.0 || >=26.0.0"
        self.assertTrue(b.node_satisfies("v24.15.0", engines))
        self.assertTrue(b.node_satisfies("v24.22.3", engines))
        self.assertFalse(b.node_satisfies("v24.14.9", engines))
        self.assertFalse(b.node_satisfies("v25.0.0", engines))
        self.assertTrue(b.node_satisfies("v26.1.0", engines))
        self.assertFalse(b.node_satisfies("v20.9.0", engines))
        self.assertFalse(b.node_satisfies("", engines))

    def test_upstream_node_engines_is_read_from_package_json(self):
        text = json.dumps({"engines": {"node": "^24.15.0 || >=26.0.0"}})
        self.assertEqual(b.upstream_engines_node(text), "^24.15.0 || >=26.0.0")
        self.assertEqual(b.upstream_engines_node("{}"), "")

    def test_workdir_must_be_missing_or_empty(self):
        tmp = Path(tempfile.mkdtemp(prefix="workdir-test-"))
        try:
            self.assertTrue(b.workdir_ok(tmp / "new"))
            (tmp / "full").mkdir()
            self.assertTrue(b.workdir_ok(tmp / "full"))
            (tmp / "full" / "x.txt").write_text("x", encoding="utf-8")
            self.assertFalse(b.workdir_ok(tmp / "full"))
            (tmp / "file").write_text("x", encoding="utf-8")
            self.assertFalse(b.workdir_ok(tmp / "file"))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_vitest_config_lists_only_the_given_files(self):
        text = b.vitest_config_text(["apps/sticks-engine/src/a.test.ts"])
        self.assertIn('"apps/sticks-engine/src/a.test.ts"', text)
        self.assertIn("defineConfig", text)
        self.assertNotIn("packages/", text)

    def test_pin_file_is_readable_by_the_build(self):
        pin = up.read_pin(ROOT / "upstream.pin")
        self.assertTrue(up.tag_key(pin["TAG"]))


class PatchOrder(unittest.TestCase):
    """The build applies patches/series top to bottom; a later patch depends on the earlier one."""

    P1 = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+two\n"
    P2 = "--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-two\n+three\n"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="patch-order-"))
        self.checkout = self.tmp / "co"
        self.checkout.mkdir()
        (self.checkout / "a.txt").write_text("one\n", encoding="utf-8", newline="\n")
        self.patches = self.tmp / "patches"
        self.patches.mkdir()
        (self.patches / "01-one-to-two.patch").write_text(self.P1, encoding="utf-8", newline="\n")
        (self.patches / "02-two-to-three.patch").write_text(self.P2, encoding="utf-8", newline="\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_series_order_is_applied(self):
        applied, problems = up.apply_patches(
            self.checkout, self.patches, ["01-one-to-two.patch", "02-two-to-three.patch"])
        self.assertEqual(problems, [])
        self.assertEqual(applied, ["01-one-to-two.patch", "02-two-to-three.patch"])
        self.assertEqual((self.checkout / "a.txt").read_text(encoding="utf-8").strip(), "three")

    def test_reversed_series_stops_at_the_first_patch_that_does_not_apply(self):
        applied, problems = up.apply_patches(
            self.checkout, self.patches, ["02-two-to-three.patch", "01-one-to-two.patch"])
        self.assertEqual(applied, [])
        self.assertTrue(problems[0].startswith("`02-two-to-three.patch` does not apply"))
        self.assertIn("`01-one-to-two.patch`: not tried", problems[1])
        self.assertEqual((self.checkout / "a.txt").read_text(encoding="utf-8").strip(), "one")


if __name__ == "__main__":
    unittest.main()
