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
    def test_table_states_the_measure_and_the_image(self):
        text = m.format_summary(2048 * 1024 // 2, 3)
        self.assertIn("Idle RSS, engine process tree | 1024.0 MB", text)
        self.assertIn("Processes in the tree | 3", text)
        self.assertIn("postgres:18-alpine", text)

    def test_note_is_added_when_given(self):
        self.assertIn("| Note | cold start later |", m.format_summary(1, 1, "cold start later"))


if __name__ == "__main__":
    unittest.main()
