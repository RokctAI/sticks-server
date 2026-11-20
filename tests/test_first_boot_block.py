"""The engine's first boot (brief task 10) carries templates/stick-defaults.md as a string, so it survives
the esbuild bundle. This test keeps the two copies the same."""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class FirstBootBlock(unittest.TestCase):
    def test_engine_block_matches_the_template(self):
        source = (ROOT / "overlay/apps/sticks-engine/src/first-boot.ts").read_text(encoding="utf-8")
        match = re.search(r"^export const DEFAULT_BLOCK = (\".*\");$", source, re.MULTILINE)
        self.assertIsNotNone(match, "DEFAULT_BLOCK must be one JSON string on one line")
        template = (ROOT / "templates/stick-defaults.md").read_text(encoding="utf-8").strip()
        self.assertEqual(json.loads(match.group(1)), template)


if __name__ == "__main__":
    unittest.main()
