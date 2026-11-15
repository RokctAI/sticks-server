"""Live checks against Groq's OpenAI-compatible API (brief: the Groq live test, last task).

Models change on Groq's side, so nothing here names a model. The test reads GET /models, prints every chat model
with its context window and output limit, then runs the tool-call check on the largest few. Each result is printed
as one RESULT line, so a run shows which models passed and which failed.

It runs only when GROQ_API_KEY is set (the manual-dispatch workflow sets it from a GitHub secret). Otherwise every
test is skipped, so the normal CI run stays offline and deterministic. The key is read from the environment only;
it is never printed, logged or written to a file. It calls Groq directly, not through the engine, which refuses
provider keys in its environment by design.
"""

import json
import os
import re
import unittest
import urllib.error
import urllib.request

BASE = "https://api.groq.com/openai/v1"
KEY = os.environ.get("GROQ_API_KEY", "").strip()
# Groq sits behind Cloudflare, which answers 403 (error 1010) to Python's default User-Agent.
USER_AGENT = "sticks-live-check/1.0"
# How many chat models the tool-call check runs on (largest context window first).
TOOL_CHECK_MODELS = 10
# Models that are not chat models (speech, guards, embeddings, text-to-speech).
NOT_CHAT = re.compile(r"whisper|orpheus|guard|safeguard|embed|tts|speech|vision", re.IGNORECASE)

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


LAST_HEADERS: dict[str, str] = {}


def _request(path: str, payload: dict | None = None) -> dict:
    global LAST_HEADERS
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=None if payload is None else json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "User-Agent": USER_AGENT,
        },
        method="GET" if payload is None else "POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            # Groq reports the key's rate limits in the response headers (tokens per minute, requests per minute).
            LAST_HEADERS = {k.lower(): v for k, v in response.headers.items()}
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        # The body can echo the request; report the status and the start of the body only (never the key).
        body = error.read().decode("utf-8", "replace")[:200]
        raise AssertionError(f"Groq answered HTTP {error.code}: {body!r}") from None


def chat_models() -> list[dict]:
    """Chat models visible to this key, largest context window first."""
    data = _request("/models").get("data", [])
    models = [m for m in data if not NOT_CHAT.search(m.get("id", ""))]
    return sorted(models, key=lambda m: m.get("context_window") or 0, reverse=True)


@unittest.skipUnless(KEY, "GROQ_API_KEY is not set: the live checks are skipped")
class GroqModels(unittest.TestCase):
    def test_key_is_accepted_and_models_are_listed(self):
        everything = _request("/models").get("data", [])
        print(f"RESULT /models: {len(everything)} models visible to this key")
        self.assertTrue(everything, "the key sees no models")

    def test_chat_models_with_their_limits(self):
        for m in chat_models():
            print(
                f"RESULT model {m.get('id')}: context_window={m.get('context_window')} "
                f"max_completion_tokens={m.get('max_completion_tokens')} owned_by={m.get('owned_by')}"
            )
        self.assertTrue(chat_models(), "no chat model visible to this key")


@unittest.skipUnless(KEY, "GROQ_API_KEY is not set: the live checks are skipped")
class GroqToolUse(unittest.TestCase):
    def test_largest_chat_models_call_the_tool_with_schema_valid_arguments(self):
        models = [m["id"] for m in chat_models()[:TOOL_CHECK_MODELS]]
        self.assertTrue(models, "no chat model to check")
        for model in models:
            with self.subTest(model=model):
                try:
                    reply = _request(
                        "/chat/completions",
                        {
                            "model": model,
                            "messages": [{"role": "user", "content": "What is the weather in Paris? Use the tool."}],
                            "tools": [TOOL],
                            "tool_choice": "required",
                            "temperature": 0,
                        },
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
                except AssertionError as error:
                    print(f"RESULT {model}: FAIL ({error})")
                    raise
                print(
                    f"RESULT {model}: PASS (tool call get_weather {arguments}); "
                    f"limit_tokens={LAST_HEADERS.get('x-ratelimit-limit-tokens')} "
                    f"limit_requests={LAST_HEADERS.get('x-ratelimit-limit-requests')} "
                    f"remaining_tokens={LAST_HEADERS.get('x-ratelimit-remaining-tokens')}"
                )


@unittest.skipUnless(KEY, "GROQ_API_KEY is not set: the live checks are skipped")
class GroqRequestSize(unittest.TestCase):
    """Sends one oversized request to each chat model. Groq's error for an oversized request states the limit."""

    def test_request_size_limit_per_model(self):
        filler = "The quick brown fox jumps over the lazy dog. " * 6000  # about 270 KB of text
        for model in [m["id"] for m in chat_models()]:
            with self.subTest(model=model):
                try:
                    _request(
                        "/chat/completions",
                        {
                            "model": model,
                            "messages": [{"role": "user", "content": filler}],
                            "max_completion_tokens": 1,
                            "temperature": 0,
                        },
                    )
                    print(f"RESULT size {model}: accepted the oversized request")
                except AssertionError as error:
                    print(f"RESULT size {model}: {error}")


if __name__ == "__main__":
    unittest.main()
