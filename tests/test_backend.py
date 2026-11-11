import json
import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import apply_stick_defaults as asd  # noqa: E402
import keep_going as k  # noqa: E402
import keep_going_runner as r  # noqa: E402
import setup_tenant as st  # noqa: E402
import stick_defaults as d  # noqa: E402
from sticks_client import SticksClient, SticksError  # noqa: E402

TODAY = "2026-11-11"
NOW = 1794394800.0  # 2026-11-11 11:00 UTC


class FakeServer:
    """Answers oRPC calls from a dict of procedure -> output (or callable(input))."""

    def __init__(self, answers):
        self.answers = answers
        self.calls = []

    def __call__(self, method, url, headers, body):
        self.calls.append((url, headers, json.loads(body)))
        if url.endswith("/api/auth/sign-in/email"):
            return 200, {"set-auth-token": "tok"}, b"{}"
        proc = url.split("/rpc/", 1)[1]
        ans = self.answers.get(proc)
        if isinstance(ans, Exception):
            return 409, {}, json.dumps({"json": {"message": str(ans)}}).encode()
        out = ans(json.loads(body)["json"]) if callable(ans) else ans
        return 200, {}, json.dumps({"json": out}).encode()

    def sent(self, proc):
        return [b["json"] for u, h, b in self.calls if u.endswith("/rpc/" + proc)]


def client(answers):
    fake = FakeServer(answers)
    return SticksClient("https://srv.example", token="t", transport=fake), fake


class ClientTests(unittest.TestCase):
    def test_wire_format_and_headers(self):
        c, fake = client({"bots/list": []})
        c.space_id = "sp1"
        self.assertEqual(c.call("bots/list"), [])
        url, headers, body = fake.calls[0]
        self.assertEqual(url, "https://srv.example/rpc/bots/list")
        self.assertEqual(body, {"json": None})
        self.assertEqual(headers["authorization"], "Bearer t")
        self.assertEqual(headers["x-rakazo-space-id"], "sp1")

    def test_sign_in_from_env_and_errors(self):
        fake = FakeServer({})
        c = SticksClient.from_env({"STICKS_SERVER_URL": "https://srv.example/", "STICKS_SERVER_EMAIL": "a@b.c",
                                   "STICKS_SERVER_PASSWORD": "pw"}, transport=fake)
        self.assertEqual(c.token, "tok")
        with self.assertRaises(SticksError):
            SticksClient.from_env({"STICKS_SERVER_URL": "x"}, transport=fake)
        c2, _ = client({"bots/update": Exception("Instructions changed")})
        with self.assertRaises(SticksError) as ctx:
            c2.call("bots/update", {})
        self.assertEqual(ctx.exception.message, "Instructions changed")


class DefaultsTests(unittest.TestCase):
    def test_only_changed_active_sticks_are_written(self):
        done = d.apply_block("A").strip()
        bots = [
            {"id": "b1", "name": "One", "instructions": "A", "archivedAt": None},
            {"id": "b2", "name": "Two", "instructions": done, "archivedAt": None},
            {"id": "b3", "name": "Old", "instructions": "", "archivedAt": "2026-01-01"},
        ]
        c, fake = client({"bots/list": bots, "bots/update": {}})
        changed, problems = asd.apply(c, write=False)
        self.assertEqual((changed, problems), (["One"], []))
        self.assertEqual(fake.sent("bots/update"), [])
        changed, _ = asd.apply(c, write=True)
        upd = fake.sent("bots/update")[0]
        self.assertEqual(upd["botId"], "b1")
        self.assertEqual(upd["expectedInstructions"], "A")
        self.assertIn("ticket_create", upd["instructions"])

    def test_conflict_is_reported_not_raised(self):
        c, _ = client({"bots/list": [{"id": "b1", "name": "One", "instructions": "A"}],
                       "bots/update": Exception("Instructions changed")})
        changed, problems = asd.apply(c, write=True)
        self.assertEqual(changed, [])
        self.assertIn("Instructions changed", problems[0])


class SetupTests(unittest.TestCase):
    def test_renames_current_space_once(self):
        nav = {"current": {"id": "s1", "name": "Personal"}, "spaces": [{"id": "s1"}]}
        c, fake = client({"spaces/list": nav, "spaces/rename": {}, "bots/list": []})
        log = st.setup(c, "  Example   Holdings ", write=True)
        self.assertEqual(fake.sent("spaces/rename"), [{"spaceId": "s1", "name": "Example Holdings"}])
        self.assertIn("renamed", log[0])
        self.assertEqual(st.space_name("x" * 80), "x" * 60)
        with self.assertRaises(ValueError):
            st.space_name("  ")


def _server(run_status="completed", tickets=None, last_text="Saved 40 of 500.", owner_last=False, usage=None):
    tickets = [{"id": "T1", "title": "Process the list", "status": "doing"}] if tickets is None else tickets
    msgs = [{"role": "user", "blocks": [{"kind": "text", "text": "go"}], "createdAt": "2026-11-11T09:00:00Z", "seq": 1},
            {"role": "bot", "blocks": [{"kind": "text", "text": last_text}], "createdAt": "2026-11-11T10:00:00Z", "seq": 2}]
    if owner_last:
        msgs.append({"role": "user", "blocks": [{"kind": "text", "text": "wait"}], "createdAt": "2026-11-11T10:30:00Z", "seq": 3})
    return {
        "bots/list": [{"id": "b1", "name": "One"}, {"id": "b2", "name": "Two"}],
        "runs/list": {"runs": [{"runId": "r1", "botId": "b1", "groupId": None, "status": run_status,
                                "updatedAt": "2026-11-11T10:00:05Z"}]},
        "threads/messages": {"messages": msgs},
        "tickets/list": {"tickets": tickets},
        "scratchpad/list": [],
        "usage/list": usage if usage is not None else [{"botId": "b1", "costUsd": 0.4, "createdAt": "2026-11-11T09:30:00Z"}],
        "threads/send": {},
    }


CONFIG = {"default": {"enabled": False}, "sticks": {"b1": {"enabled": True, "max_spend_per_day": 5}}}


class RunnerTests(unittest.TestCase):
    def test_sends_continue_for_enabled_stick_only(self):
        c, fake = client(_server())
        state = {}
        log = r.tick(c, CONFIG, state, batch_size=5, now=NOW)
        self.assertEqual(log, ["b1: continue (open work and not blocked)"])
        sent = fake.sent("threads/send")
        self.assertEqual(sent[0]["botId"], "b1")
        self.assertIn("Process the list", sent[0]["text"])
        self.assertEqual(state["sticks"]["b1"]["continues_today"], 1)
        # b2 is off: never read
        self.assertFalse(any(b["json"] and b["json"].get("botId") == "b2" for _, _, b in fake.calls))

    def test_complete_and_blocked_end_the_loop(self):
        c, fake = client(_server(tickets=[]))
        self.assertIn("b1: complete", r.tick(c, CONFIG, {}, 5, NOW)[0])
        c, fake = client(_server(tickets=[{"id": "T2", "title": "Need the price list", "status": "blocked"}]))
        line = r.tick(c, CONFIG, {}, 5, NOW)[0]
        self.assertIn("blocked: Need the price list", line)
        c, fake = client(_server(run_status="waiting_input"))
        self.assertIn("b1: blocked", r.tick(c, CONFIG, {}, 5, NOW)[0])
        c, fake = client(_server(last_text="Which file should I use?"))
        self.assertIn("asks the owner: Which file", r.tick(c, CONFIG, {}, 5, NOW)[0])
        self.assertEqual(fake.sent("threads/send"), [])

    def test_done_claim_is_checked_against_the_board(self):
        c, fake = client(_server(last_text="All done!"))
        r.tick(c, CONFIG, {}, 5, NOW)
        self.assertIn("You said this is done, but these are still open: Process the list", fake.sent("threads/send")[0]["text"])

    def test_owner_spoke_last_and_spend(self):
        c, fake = client(_server(owner_last=True))
        self.assertIn("waiting", r.tick(c, CONFIG, {}, 5, NOW)[0])
        c, fake = client(_server(usage=[{"botId": "b1", "costUsd": 6, "createdAt": "2026-11-11T08:00:00Z"}]))
        self.assertIn("spend cap", r.tick(c, CONFIG, {}, 5, NOW)[0])

    def test_helpers(self):
        self.assertEqual(r.next_batch(["c", "a", "b"], "", 2), (["a", "b"], "b"))
        self.assertEqual(r.next_batch(["c", "a", "b"], "b", 2), (["c", "a"], "a"))
        self.assertEqual(r.next_batch([], "x", 2), ([], ""))
        full = [{"botId": "x", "costUsd": 0, "createdAt": TODAY + "T01:00:00Z"}] * r.USAGE_PAGE
        self.assertTrue(math.isinf(r.spend_today(full, "b1", TODAY)))
        self.assertEqual(r.spend_today([{"botId": "b1", "costUsd": 1, "createdAt": "2026-11-10T23:00:00Z"}], "b1", TODAY), 0)
        self.assertFalse(r.policy_for({"default": {}}, "b1").enabled)
        self.assertTrue(r.policy_for(CONFIG, "b1").enabled)
        self.assertEqual(k.Decision(False, "x").outcome, "")


if __name__ == "__main__":
    unittest.main()
