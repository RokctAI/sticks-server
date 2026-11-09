import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))

import sync_upstream as s  # noqa: E402
import render_env  # noqa: E402
import extract_used_procedures as x  # noqa: E402
import stick_defaults as d  # noqa: E402
import keep_going as k  # noqa: E402

LS = """\
aaa\trefs/tags/v0.8.0
bbb\trefs/tags/v0.10.0
ccc\trefs/tags/v0.9.1
ddd\trefs/tags/android
eee\trefs/tags/v0.9.0-rc1
"""

RPC = """\
export const router = {
  bots: {
    list: oc.output(x),
    create: oc
      .input(y),
  },
  threads: {
    subscribe: oc.output(eventIterator(z)),
  },
};
"""

CHANGELOG = """\
# Changelog

## [Unreleased]

### Changed

- unreleased thing

## [0.9.0] - 2026-11-06

### Added

- shiny

### Changed

- group messages go to every bot

## [0.8.0] - 2026-11-04

### Changed

- old thing
"""


class SyncTests(unittest.TestCase):
    def test_newest_tag_ignores_non_release_and_sorts_numerically(self):
        self.assertEqual(s.newest_tag(LS), "v0.10.0")
        self.assertIsNone(s.newest_tag("x\trefs/tags/android\n"))

    def test_series_skips_comments(self):
        self.assertEqual(s.parse_series("# c\n\na.patch\n  b.patch \n"), ["a.patch", "b.patch"])

    def test_contract_procedures(self):
        self.assertEqual(s.contract_procedures(RPC), {"bots/list", "bots/create", "threads/subscribe"})

    def test_changelog_since_only_between_pin_and_new(self):
        out = s.changelog_since(CHANGELOG, "v0.8.0", "v0.9.0")
        self.assertIn("group messages go to every bot", out)
        self.assertNotIn("old thing", out)
        self.assertNotIn("unreleased thing", out)
        self.assertNotIn("shiny", out)  # Added is not in the kept headings

    def test_area_grouping_and_watch_flag(self):
        numstat = "3\t1\tapps/mobile/app/chat.tsx\n10\t0\tapps/web/src/a.tsx\n2\t2\tapps/api/src/x.ts\n-\t-\tapps/www/img.png\n1\t1\tsomething.txt\n"
        summary = s.summarize_diff(numstat)
        self.assertEqual(summary["Mobile app"]["added"], 3)
        self.assertEqual(summary["Web app"]["files"], ["apps/web/src/a.tsx"])
        self.assertIn("Other", summary)
        self.assertEqual(summary["Website"]["added"], 0)  # binary file counts as 0
        text = s.format_changes(summary)
        self.assertIn("CHECK BY HAND", text)
        self.assertIn("Mobile app", text)
        self.assertNotIn("Desktop app", text.split("CHECK BY HAND")[1].split("Changed files")[0])

    def test_no_client_change_message(self):
        text = s.format_changes(s.summarize_diff("1\t1\tapps/api/src/x.ts\n"))
        self.assertIn("No change in the mobile, web or desktop apps.", text)
        self.assertNotIn("CHECK BY HAND", text)

    def test_pin_file_and_render(self):
        pin = s.read_pin(Path(__file__).resolve().parent.parent / "upstream.pin")
        self.assertTrue(s.tag_key(pin["TAG"]))
        out = render_env.render(pin)
        self.assertIn(f"RAKAZO_IMAGE_TAG={pin['TAG']}@sha256:", out)

    def test_used_procedures_file_parses(self):
        text = (Path(__file__).resolve().parent.parent / "contracts" / "used-procedures.txt").read_text()
        used = s.used_procedures(text)
        self.assertIn("threads/subscribe", used)
        self.assertTrue(all("/" in u for u in used))

    def test_extractor_reads_literals_and_skips_media_types(self):
        dart = "post('threads/send'); h = 'application/json'; c = 'image/png'; x('bots/list'); y = \"a/b\";"
        self.assertEqual(x.extract(dart), {"threads/send", "bots/list"})

    def test_checked_in_list_matches_format(self):
        text = (Path(__file__).resolve().parent.parent / "contracts" / "used-procedures.txt").read_text()
        listed = x.read_list(text)
        self.assertEqual(listed, sorted(listed))
        self.assertGreater(len(listed), 100)

    def test_render_refuses_missing_digest(self):
        pin = {"TAG": "v0.9.0", "APP_IMAGE": "a", "COMPUTER_IMAGE": "c", "APP_IMAGE_DIGEST": "sha256:1"}
        with self.assertRaises(ValueError):
            render_env.render(pin)
        self.assertIn("RAKAZO_COMPUTER_IMAGE_TAG=v0.9.0\n", render_env.render(pin, allow_unpinned=True))

    def test_defaults_block_is_added_once_and_replaced(self):
        once = d.apply_block("You are Example Stick.")
        self.assertTrue(once.startswith("You are Example Stick."))
        self.assertIn("ticket_create", once)
        self.assertEqual(d.apply_block(once), once)  # idempotent
        edited = once.replace("ticket_create", "XX")
        self.assertEqual(d.apply_block(edited), once)  # edited-away text is restored
        self.assertEqual(d.apply_block(""), d.default_block() + "\n")
        self.assertEqual(d.remove_block(once).strip(), "You are Example Stick.")

    def test_defaults_block_handles_a_broken_marker(self):
        broken = "Mine.\n" + d.START + "\nhalf"
        out = d.apply_block(broken)
        self.assertEqual(out.count(d.START), 1)
        self.assertEqual(out.count(d.END), 1)
        self.assertIn("Mine.", out)


def _snap(**kw):
    base = dict(run_status="completed", run_ended_at=100.0, last_message_text="Done with batch 1.",
                last_message_from_owner=False, last_message_at=100.0,
                pending_tickets=[{"id": "T1", "title": "Process the list", "status": "doing"}],
                open_scratchpad=[], spend_today=0.0)
    base.update(kw)
    return k.Snapshot(**base)


class KeepGoingTests(unittest.TestCase):
    pol = k.Policy(enabled=True, max_spend_per_day=100)

    def dec(self, snap=None, pol=None, state=None, now=1000.0):
        return k.decide(snap or _snap(), pol or self.pol, state or k.StickState(), now, "2026-11-09")

    def test_off_by_default(self):
        self.assertFalse(k.Policy().enabled)
        self.assertFalse(self.dec(pol=k.Policy()).send)

    def test_continues_with_open_ticket(self):
        self.assertTrue(self.dec().send)

    def test_scratchpad_counts_and_can_be_turned_off(self):
        s = _snap(pending_tickets=[], open_scratchpad=[{"id": "S1", "title": "list"}])
        self.assertTrue(self.dec(s).send)
        self.assertFalse(self.dec(s, k.Policy(enabled=True, max_spend_per_day=1, include_scratchpad=False)).send)

    def test_no_pending_work(self):
        self.assertFalse(self.dec(_snap(pending_tickets=[])).send)

    def test_blocker_by_paused_run_or_question(self):
        self.assertFalse(self.dec(_snap(run_status="waiting_input")).send)
        self.assertFalse(self.dec(_snap(run_status="waiting_takeover")).send)
        self.assertFalse(self.dec(_snap(last_message_text="Which list should I use?")).send)
        self.assertFalse(self.dec(_snap(last_message_text="Let me know when to go on.")).send)
        self.assertTrue(self.dec(_snap(last_message_text="Saved 40 of 591. Next batch.")).send)

    def test_failed_cancelled_or_owner_spoke_last(self):
        self.assertFalse(self.dec(_snap(run_status="failed")).send)
        self.assertFalse(self.dec(_snap(run_status="cancelled")).send)
        self.assertFalse(self.dec(_snap(run_status="running")).send)
        self.assertFalse(self.dec(_snap(last_message_from_owner=True, last_message_at=101.0)).send)

    def test_caps(self):
        sig = k.signature_of(_snap(), self.pol)
        st = k.StickState(day="2026-11-09", continues_today=20)
        self.assertIn("daily", self.dec(state=st).reason)
        st = k.StickState(last_continue_at=990.0)
        self.assertIn("too soon", self.dec(state=st).reason)
        self.assertIn("spend", self.dec(_snap(spend_today=100.0)).reason)
        self.assertIn("spend", self.dec(pol=k.Policy(enabled=True)).reason)  # no spend allowed by default
        st = k.StickState(last_signature=sig, tries_on_signature=3)
        self.assertIn("stalled", self.dec(state=st).reason)
        # progress (pending work changed) resets the try count
        st = k.StickState(last_signature="old", tries_on_signature=3)
        self.assertTrue(self.dec(state=st).send)

    def test_check_stick_sends_once_and_updates_state(self):
        sent = []

        class C:
            def snapshot(self, bot_id):
                return _snap()

            def send(self, bot_id, text, nonce):
                sent.append((bot_id, text, nonce))

        d1, st = k.check_stick(C(), "b1", self.pol, k.StickState(), now=1000.0, today="2026-11-09")
        self.assertTrue(d1.send)
        self.assertEqual(len(sent), 1)
        self.assertIn("auto-continue 1/3", sent[0][1])
        self.assertIn("Process the list", sent[0][1])
        d2, st = k.check_stick(C(), "b1", self.pol, st, now=1010.0, today="2026-11-09")
        self.assertFalse(d2.send)  # within the minimum gap
        self.assertEqual(len(sent), 1)
        off = k.check_stick(C(), "b1", k.Policy(), k.StickState(), now=2000.0)[0]
        self.assertFalse(off.send)
        self.assertEqual(len(sent), 1)


if __name__ == "__main__":
    unittest.main()


import reporting_lines as r  # noqa: E402


def _org():
    return {"sticks": {
        "hr": {"role": "hr", "reports_to": None, "created_by": None, "active": True},
        "cos": {"role": "chief_of_staff", "reports_to": None, "created_by": "hr", "active": True},
        "a": {"role": "x", "reports_to": "cos", "created_by": "hr", "active": True},
        "b": {"role": "x", "reports_to": "cos", "created_by": "a", "active": True},
    }}


class ReportingLines(unittest.TestCase):
    def test_ping_goes_to_reports_to_not_creator(self):
        st = _org()
        self.assertEqual(r.route_ping(st, "b", "done")["to"], "cos")  # creator is a
        self.assertEqual(r.route_ping(st, "cos", "x")["to"], "owner")

    def test_stick_cannot_change_own_line(self):
        st = _org()
        with self.assertRaises(r.ReportingError):
            r.set_reports_to(st, "a", "a", None, "promote me")
        with self.assertRaises(r.ReportingError):
            r.set_reports_to(st, "hr", "hr", "cos", "self")  # not even HR for itself

    def test_manager_must_go_through_hr(self):
        st = _org()
        with self.assertRaises(r.ReportingError):
            r.set_reports_to(st, "cos", "b", "a", "reshuffle")
        r.set_reports_to(st, "hr", "b", "a", "b now reports to a")
        self.assertEqual(r.route_ping(st, "b", "hi")["to"], "a")  # follows at once
        self.assertEqual(st["log"][-1]["from"], "cos")

    def test_owner_may_and_loops_refused(self):
        st = _org()
        r.set_reports_to(st, "owner", "a", None, "promoted")
        self.assertIsNone(st["sticks"]["a"]["reports_to"])
        with self.assertRaises(r.ReportingError):
            r.set_reports_to(st, "owner", "cos", "b", "loop")  # b -> cos already
        with self.assertRaises(r.ReportingError):
            r.set_reports_to(st, "owner", "a", "b", " ")

    def test_ping_short_dedupe_inactive_manager(self):
        st = _org()
        long = r.route_ping(st, "a", "x" * 400)
        self.assertEqual(len(long["text"]), r.PING_MAX)
        self.assertIsNone(r.route_ping(st, "a", "x" * 400, pending=[long]))
        st["sticks"]["cos"]["active"] = False
        self.assertEqual(r.route_ping(st, "a", "hi")["to"], "owner")

    def test_create_through_hr_only(self):
        st = _org()
        with self.assertRaises(r.ReportingError):
            r.create_stick(st, "cos", "c", "x", "cos")
        r.create_stick(st, "hr", "c", "x", "cos")
        self.assertEqual(st["sticks"]["c"]["reports_to"], "cos")
        self.assertEqual(st["sticks"]["c"]["created_by"], "hr")
