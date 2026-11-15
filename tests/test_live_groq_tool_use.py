"""Live tool-use check against Groq's OpenAI-compatible API (brief: the Groq live test, last task).

It asks a real model to call one tool, then checks that the call names the tool and its arguments match the schema.
It runs only when GROQ_API_KEY is set (the manual-dispatch workflow sets it from a GitHub secret). Otherwise every
test is skipped, so the normal CI run stays offline and deterministic. The key is read from the environment only;
it is never printed, logged or written to a file.

It calls Groq directly, not through the engine: the engine refuses provider keys in its environment by design.
"""

import json
import os
import unittest
import urllib.error
import urllib.request

API_URL = "https://api.groq.com/openai/v1/chat/completions"
MODEL = os.environ.get("GROQ_MODEL", "llama-3.3-70b-versatile")
KEY = os.environ.get("GROQ_API_KEY", "").strip()

TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name, for example Paris"}},
            "required": ["city"],
            "additionalProperties": False,
        },
    },
}


def chat(payload: dict) -> dict:
    request = urllib.request.Request(
        API_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Authorization": f"Bearer {KEY}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The body can echo the request; report the status only.
        raise AssertionError(f"Groq answered HTTP {error.code}") from None


@unittest.skipUnless(KEY, "GROQ_API_KEY is not set: the live tool-use check is skipped")
class GroqToolUse(unittest.TestCase):
    def test_model_calls_the_tool_with_schema_valid_arguments(self):
        reply = chat(
            {
                "model": MODEL,
                "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
                "tools": [TOOL],
                "tool_choice": "required",
                "temperature": 0,
            }
        )
        message = reply["choices"][0]["message"]
        calls = message.get("tool_calls") or []
        self.assertGreaterEqual(len(calls), 1, "the model made no tool call")
        call = calls[0]
        self.assertEqual(call["function"]["name"], "get_weather")
        arguments = json.loads(call["function"]["arguments"])
        self.assertEqual(set(arguments), {"city"}, "arguments must match the schema exactly")
        self.assertIsInstance(arguments["city"], str)
        self.assertTrue(arguments["city"].strip(), "city must not be empty")


if __name__ == "__main__":
    unittest.main()
