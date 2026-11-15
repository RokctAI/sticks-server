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
# Both models the shared release workflow uses. Each one is checked on its own, so the run shows which passed.
MODELS = ["groq/compound", "llama-3.3-70b-versatile"]
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
class GroqKey(unittest.TestCase):
    def test_key_is_accepted_by_the_models_endpoint(self):
        # GET /models: 200 for a valid key, 401 for an invalid one, 403 when the key lacks access.
        request = urllib.request.Request(
            "https://api.groq.com/openai/v1/models",
            headers={"Authorization": f"Bearer {KEY}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                status = response.status
                ids = [m.get("id") for m in json.loads(response.read().decode("utf-8")).get("data", [])]
        except urllib.error.HTTPError as error:
            print(f"RESULT /models: HTTP {error.code}")
            self.fail(f"/models answered HTTP {error.code}")
        print(f"RESULT /models: HTTP {status}, {len(ids)} models visible")
        self.assertIn("llama-3.3-70b-versatile", ids)
        self.assertIn("groq/compound", ids)


@unittest.skipUnless(KEY, "GROQ_API_KEY is not set: the live tool-use check is skipped")
class GroqToolUse(unittest.TestCase):
    def test_each_model_calls_the_tool_with_schema_valid_arguments(self):
        for model in MODELS:
            with self.subTest(model=model):
                reply = chat(
                    {
                        "model": model,
                        "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
                        "tools": [TOOL],
                        "tool_choice": "required",
                        "temperature": 0,
                    }
                )
                message = reply["choices"][0]["message"]
                calls = message.get("tool_calls") or []
                self.assertGreaterEqual(len(calls), 1, f"{model}: the model made no tool call")
                call = calls[0]
                self.assertEqual(call["function"]["name"], "get_weather", f"{model}: wrong tool name")
                arguments = json.loads(call["function"]["arguments"])
                self.assertEqual(set(arguments), {"city"}, f"{model}: arguments must match the schema exactly")
                self.assertIsInstance(arguments["city"], str)
                self.assertTrue(arguments["city"].strip(), f"{model}: city must not be empty")
                print(f"RESULT {model}: PASS (tool call {call['function']['name']} {arguments})")


if __name__ == "__main__":
    unittest.main()
