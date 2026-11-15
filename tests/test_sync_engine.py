"""Weekly sync and the overlay build (spec 11.4): exit 40, the build's tag choice, and the wiring."""
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import build_engine as b  # noqa: E402
import sync_upstream as s  # noqa: E402


class EngineOutcome(unittest.TestCase):
    def test_a_build_that_passes_keeps_the_proposal(self):
        self.assertIsNone(s.engine_outcome(0))

    def test_a_broken_overlay_is_exit_40(self):
        self.assertEqual(s.engine_outcome(1), 40)  # typecheck or overlay tests failed

    def test_a_build_refusal_is_also_40(self):
        self.assertEqual(s.engine_outcome(2), 40)  # overlay collision, or the toolchain is missing

    def test_a_patch_that_does_not_apply_is_20_not_40(self):
        self.assertEqual(s.engine_outcome(3), 20)

    def test_exit_40_is_the_documented_constant(self):
        self.assertEqual(s.EXIT_ENGINE_BROKEN, 40)


class TagChoice(unittest.TestCase):
    def test_the_override_wins_over_the_pin(self):
        self.assertEqual(b.chosen_tag("v0.11.0", "v0.12.0"), "v0.12.0")

    def test_without_an_override_the_pin_is_used(self):
        self.assertEqual(b.chosen_tag("v0.11.0", None), "v0.11.0")

    def test_an_empty_override_falls_back_to_the_pin(self):
        self.assertEqual(b.chosen_tag("v0.11.0", ""), "v0.11.0")


class Wiring(unittest.TestCase):
    def test_report_template_has_the_engine_section(self):
        tpl = (ROOT / "templates" / "report.md").read_text(encoding="utf-8")
        self.assertIn("## Our overlay on the new tag (engine build)", tpl)
        self.assertIn("$engine_build", tpl)

    def test_sync_workflow_opens_an_issue_on_40_and_does_not_call_it_a_run_failure(self):
        wf = (ROOT / ".github" / "workflows" / "sync-upstream.yml").read_text(encoding="utf-8")
        self.assertIn("steps.sync.outputs.code == '40'", wf)
        self.assertIn("steps.sync.outputs.code != '40'", wf)

    def test_sync_workflow_sets_up_node_and_corepack_before_the_check(self):
        wf = (ROOT / ".github" / "workflows" / "sync-upstream.yml").read_text(encoding="utf-8")
        self.assertLess(wf.index("actions/setup-node"), wf.index("id: sync"))
        self.assertLess(wf.index("corepack enable"), wf.index("id: sync"))

    def test_readme_lists_exit_40(self):
        readme = (ROOT / "README.md").read_text(encoding="utf-8")
        self.assertIn("`40` our overlay does not build", readme)


if __name__ == "__main__":
    unittest.main()
