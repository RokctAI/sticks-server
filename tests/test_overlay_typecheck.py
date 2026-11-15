import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_engine as b  # noqa: E402


class OverlayTypecheck(unittest.TestCase):
    def test_only_tsconfigs_under_apps_are_typechecked(self):
        files = [
            "apps/sticks-engine/src/index.ts",
            "apps/sticks-engine/tsconfig.json",
            "tsconfig.json",
            "overlay/tsconfig.json",
            "apps/other/tsconfig.base.json",
        ]
        self.assertEqual(b.overlay_typecheck_projects(files), ["apps/sticks-engine/tsconfig.json"])

    def test_no_tsconfig_means_nothing_to_check(self):
        self.assertEqual(b.overlay_typecheck_projects(["apps/sticks-engine/src/index.ts"]), [])

    def test_build_runs_tsc_no_emit_after_upstream_typecheck(self):
        source = (ROOT / "scripts" / "build_engine.py").read_text(encoding="utf-8")
        upstream = source.index('"run", "check"')
        overlay = source.index('"tsc", "--noEmit"')
        tests = source.index("vitest run on")
        self.assertLess(upstream, overlay)
        self.assertLess(overlay, tests)

    def test_overlay_tsconfig_extends_the_upstream_base(self):
        text = (ROOT / "overlay" / "apps" / "sticks-engine" / "tsconfig.json").read_text(encoding="utf-8")
        self.assertIn('"extends": "../../../tsconfig.base.json"', text)


if __name__ == "__main__":
    unittest.main()
