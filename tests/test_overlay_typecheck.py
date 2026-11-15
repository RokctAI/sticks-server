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
        tests = source.index("vitest run on {len")  # the step line, not the docstring
        self.assertLess(upstream, overlay)
        self.assertLess(overlay, tests)

    def test_our_errors_fail_and_upstream_package_errors_do_not(self):
        output = "\n".join([
            "packages/auth/src/index.ts(44,36): error TS6142: Module './email.js' was resolved, but '--jsx' is not set.",
            "apps/sticks-engine/src/engine.ts(12,5): error TS2322: Type 'number' is not assignable to type 'string'.",
        ])
        self.assertEqual(
            b.overlay_type_errors(output, "apps/sticks-engine"),
            ["apps/sticks-engine/src/engine.ts(12,5): error TS2322: Type 'number' is not assignable to type 'string'."],
        )

    def test_clean_output_has_no_errors(self):
        self.assertEqual(b.overlay_type_errors("", "apps/sticks-engine"), [])
        self.assertEqual(
            b.overlay_type_errors("packages/x/src/a.ts(1,1): error TS1: upstream only", "apps/sticks-engine"),
            [],
        )

    def test_config_level_errors_are_ours(self):
        output = "error TS5083: Cannot read file 'tsconfig.base.json'."
        self.assertEqual(b.overlay_type_errors(output, "apps/sticks-engine"), [output])

    def test_our_prefix_does_not_match_a_longer_folder_name(self):
        output = "apps/sticks-engine-old/src/a.ts(1,1): error TS1: not ours"
        self.assertEqual(b.overlay_type_errors(output, "apps/sticks-engine"), [])

    def test_overlay_tsconfig_extends_the_upstream_base(self):
        text = (ROOT / "overlay" / "apps" / "sticks-engine" / "tsconfig.json").read_text(encoding="utf-8")
        # tsconfig.json sits in apps/sticks-engine/, so the checkout root is two levels up.
        self.assertIn('"extends": "../../tsconfig.base.json"', text)


if __name__ == "__main__":
    unittest.main()
