import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class GithubPluginModuleTest(unittest.TestCase):
    def test_embedded_description_matches_openapi_json(self):
        src = (ROOT / "overlay/apps/sticks-engine/src/github-plugin-document.ts").read_text(encoding="utf-8")
        m = re.search(r"GITHUB_PLUGIN_DOCUMENT: unknown = (\{.*\});\s*$", src, re.S)
        self.assertIsNotNone(m)
        self.assertEqual(json.loads(m.group(1)), json.loads((ROOT / "overlay/plugins/github/openapi.json").read_text(encoding="utf-8")))


if __name__ == "__main__":
    unittest.main()
