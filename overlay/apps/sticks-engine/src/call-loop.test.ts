import { describe, expect, it } from "vitest";
import { runCall, type CallMedia, type StickTurn } from "./call-loop.js";
import { CreditsRefused } from "./pulsar-credits.js";

function media(heard: Array<string | null | "hangup">) {
  const said: string[] = [];
  let hung = false;
  const m: CallMedia = { listen: async () => (heard.length ? heard.shift()! : "hangup"), say: async (t) => void said.push(t), hangup: async () => void (hung = true) };
  return { m, said, hung: () => hung };
}
const thandi = { id: "s1", name: "Thandi", role: "accounts assistant", company: "South River" };
const sipho = { id: "s2", name: "Sipho", role: "service desk", company: "South River" };
const base = { stick: thandi, contact: "Mr Dube", objective: "Book a service", isCompany: false, callSticks: ["s1", "s2"] };

describe("call loop", () => {
  it("opens, talks, and ends when the objective is met", async () => {
    const x = media(["Hi", "Tuesday works"]);
    const turns: StickTurn[] = [{ kind: "say", text: "Can we book Tuesday?" }, { kind: "end", text: "Booked, goodbye.", outcome: "met" }];
    const r = await runCall({ ...base, media: x.m, turn: async () => turns.shift()! });
    expect(x.said[0]).toBe("Hello Mr Dube, this is Thandi, accounts assistant at South River.");
    expect(r.outcome).toBe("met");
    expect(x.hung()).toBe(true);
  });

  it("answers truthfully when asked if it is a bot, without asking the model", async () => {
    const x = media(["Are you a bot?", "hangup"]);
    let asked = 0;
    await runCall({ ...base, media: x.m, turn: async () => (asked++, { kind: "say", text: "x" }) });
    expect(x.said[1]).toContain("AI assistant");
    expect(asked).toBe(0);
  });

  it("asks why before do not call, then records it", async () => {
    const x = media(["Stop calling me", "I don't talk to bots"]);
    const turns: StickTurn[] = [{ kind: "do_not_call", text: "May I ask why?" }, { kind: "do_not_call", reason: "I don't talk to bots", text: "Understood, goodbye." }];
    const r = await runCall({ ...base, media: x.m, turn: async () => turns.shift()! });
    expect(r.outcome).toBe("do_not_call");
    expect(r.doNotCall).toMatchObject({ humansOnly: true });
  });

  it("hands over to another Stick, who introduces itself", async () => {
    const x = media(["It's about my bill", "thanks", "hangup"]);
    const turns: StickTurn[] = [{ kind: "transfer", to: sipho, text: "I'll pass you to Sipho.", summary: "bill question" }, { kind: "say", text: "Happy to help." }];
    const seen: string[] = [];
    const r = await runCall({ ...base, media: x.m, turn: async (i) => (seen.push(`${i.stick.id}:${i.handover ?? ""}`), turns.shift()!) });
    expect(x.said).toContain("Hello, this is Sipho, service desk at South River.");
    expect(seen[1]).toBe("s2:bill question");
    expect(r.transfers).toBe(1);
  });

  it("ends politely when credits run out, and after long silence", async () => {
    const x = media(["hello"]);
    const r = await runCall({ ...base, media: x.m, turn: async () => { throw new CreditsRefused("tenant_credits_exhausted"); } });
    expect(r.outcome).toBe("credits");
    const y = media([null, null, null]);
    expect((await runCall({ ...base, media: y.m, turn: async () => ({ kind: "say", text: "x" }) })).outcome).toBe("silence");
  });
});
