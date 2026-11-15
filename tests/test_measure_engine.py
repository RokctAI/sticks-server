import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import measure_engine as m  # noqa: E402


class ProcStatus(unittest.TestCase):
    def test_reads_vmrss_in_kb(self):
        text = "Name:\tnode\nVmPeak:\t  900000 kB\nVmRSS:\t  123456 kB\nThreads:\t11\n"
        self.assertEqual(m.vmrss_kb(text), 123456)

    def test_missing_vmrss_counts_as_zero(self):
        self.assertEqual(m.vmrss_kb("Name:\tgone\n"), 0)


class ProcessTree(unittest.TestCase):
    def test_root_and_all_descendants_only(self):
        # 1 -> 10 -> {11, 12 -> 13}; 99 is unrelated.
        table = {1: 0, 10: 1, 11: 10, 12: 10, 13: 12, 99: 0}
        self.assertEqual(sorted(m.descendants(10, table)), [10, 11, 12, 13])

    def test_a_lone_root(self):
        self.assertEqual(m.descendants(5, {5: 1}), [5])


class Summary(unittest.TestCase):
    def test_both_runs_are_reported_with_their_process_counts(self):
        text = m.format_summary([
            ("tsx (source, as before)", 2048 * 1024 // 2, 3),
            ("built (esbuild bundle, plain node)", 150 * 1024, 1),
        ])
        self.assertIn("| tsx (source, as before) | 1024.0 MB | 3 |", text)
        self.assertIn("| built (esbuild bundle, plain node) | 150.0 MB | 1 |", text)
        self.assertIn("postgres:18-alpine", text)

    def test_the_table_names_both_columns(self):
        text = m.format_summary([("x", 1024, 1)])
        self.assertIn("| Run | Idle RSS, engine process tree | Processes in the tree |", text)


class Bundler(unittest.TestCase):
    def test_node_modules_stay_external_and_workspace_packages_are_bundled(self):
        js = m.BUNDLER_JS
        self.assertIn("external: true", js)
        self.assertIn("node_modules", js)
        # Workspace packages (not under node_modules) fall through to esbuild's own bundling.
        self.assertIn("return undefined;", js)

    def test_bundle_targets_the_engine_entry_and_one_output_file(self):
        self.assertIn('"apps/sticks-engine/src/index.ts"', m.BUNDLER_JS)
        self.assertIn('"apps/sticks-engine/dist/sticks-engine.mjs"', m.BUNDLER_JS)
        self.assertIn('format: "esm"', m.BUNDLER_JS)
        self.assertIn('platform: "node"', m.BUNDLER_JS)

    def test_the_bundle_keeps_the_same_depth_for_the_packages_path(self):
        # engine.ts resolves ../../../packages from its own folder; dist/ sits at the same depth as src/.
        self.assertEqual(Path(m.BUNDLE_OUT).parent.parts[:-1], Path(m.ENGINE_ENTRY).parent.parts[:-1])


class PackageOfFrame(unittest.TestCase):
    def test_unscoped_and_scoped_packages_under_node_modules(self):
        self.assertEqual(m.package_of("file:///w/node_modules/.pnpm/hono@4/node_modules/hono/dist/index.js"), "hono")
        self.assertEqual(m.package_of("/w/node_modules/@prisma/client/runtime/library.js"), "@prisma/client")

    def test_the_last_node_modules_segment_wins(self):
        url = "/w/node_modules/.pnpm/a@1/node_modules/a/node_modules/b/index.js"
        self.assertEqual(m.package_of(url), "b")

    def test_the_bundled_engine_file_is_one_label(self):
        self.assertEqual(m.package_of("file:///w/apps/sticks-engine/dist/sticks-engine.mjs"), m.BUNDLED_LABEL)

    def test_no_url_is_node_itself(self):
        self.assertEqual(m.package_of(""), "node internals")

    def test_the_other_row_is_split_by_url_prefix(self):
        self.assertEqual(m.package_of("node:internal/fs"), "node: builtins")
        self.assertEqual(m.package_of("eval"), "eval / anonymous")
        self.assertEqual(m.package_of("<anonymous>"), "eval / anonymous")
        self.assertEqual(m.package_of("file:///w/packages/x/src/y.ts"), "file: outside node_modules")
        self.assertEqual(m.package_of("/w/packages/x/src/y.ts"), "file: outside node_modules")
        self.assertEqual(m.package_of("something-else"), "other (no file path)")


class AggregateProfile(unittest.TestCase):
    def test_sums_self_size_per_package_over_the_whole_tree(self):
        root = {
            "callFrame": {"url": "", "functionName": "(root)"},
            "selfSize": 0,
            "children": [
                {"callFrame": {"url": "file:///w/node_modules/hono/i.js"}, "selfSize": 100,
                 "children": [{"callFrame": {"url": "file:///w/node_modules/hono/j.js"}, "selfSize": 50,
                               "children": []}]},
                {"callFrame": {"url": "file:///w/node_modules/zod/z.js"}, "selfSize": 30, "children": []},
            ],
        }
        totals, total = m.aggregate_profile(root)
        self.assertEqual(totals["hono"], 150)
        self.assertEqual(totals["zod"], 30)
        self.assertEqual(total, 180)

    def test_table_ranks_largest_first_and_caps_at_fifteen(self):
        totals = {f"pkg{i}": i * 1024 * 1024 for i in range(1, 30)}
        text = m.format_profile_table(totals, sum(totals.values()))
        rows = [line for line in text.splitlines() if line.startswith("| ") and "pkg" in line]
        self.assertEqual(len(rows), m.PROFILE_TOP)
        self.assertIn("| 1 | pkg29 |", rows[0])
        self.assertIn("allocation-site attribution", text)


if __name__ == "__main__":
    unittest.main()
