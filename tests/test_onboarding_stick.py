import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class OnboardingStickTest(unittest.TestCase):
    def test_embedded_instruction_matches_template(self):
        src = (ROOT / "overlay/apps/sticks-engine/src/onboarding-stick.ts").read_text(encoding="utf-8")
        m = re.search(r"^export const ONBOARDING_INSTRUCTIONS = (\".*\");$", src, re.M)
        self.assertIsNotNone(m)
        self.assertEqual(json.loads(m.group(1)), (ROOT / "templates/onboarding-bot.md").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
