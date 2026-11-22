import { describe, expect, it } from "vitest";
import { answerRecordRequest, createRecordRequest, listRecordRequests, validRecord } from "./record-requests.js";

function fakeDb() {
  const rows: Record<string, unknown>[] = [];
  const q = async (sql: string, p: unknown[]) => {
    if (sql.startsWith("CREATE")) return [];
    if (sql.startsWith("INSERT")) { const r = { request_id: p[0], thread_id: p[1], message_id: p[2], module: p[3], action: p[4], record: JSON.parse(p[5] as string), decision: null, created_at: new Date().toISOString(), answered_at: null }; rows.push(r); return [r]; }
    if (sql.startsWith("UPDATE")) { const r = rows.find((x) => x.request_id === p[0] && x.decision === null); if (r) { r.decision = p[1]; r.answered_at = new Date().toISOString(); } return []; }
    if (sql.includes("WHERE request_id")) return rows.filter((x) => x.request_id === p[0]);
    return rows.filter((x) => x.thread_id === p[0]);
  };
  return q;
}
const record = { type: "Sales Invoice", id: "SINV-1", title: "Invoice for Thabo", fields: [{ label: "Customer", value: "Thabo Dube" }], lines: [{ item: "Water", qty: "2", amount: "R 100.00" }], total: "R 115.00", tax: "R 15.00" };

describe("record requests", () => {
  it("refuses numeric amounts so totals are never computed outside Pulsar", () => {
    expect(validRecord({ ...record, total: 115 })).toBe(false);
    expect(validRecord(record)).toBe(true);
  });
  it("answers once; a repeat answer changes nothing", async () => {
    const q = fakeDb();
    const r = await createRecordRequest(q, { thread_id: "t1", module: "selling", action: "submit", record }, () => "req1");
    expect((await answerRecordRequest(q, r.requestId, "allow", "u1")).decision).toBe("allow");
    expect((await answerRecordRequest(q, r.requestId, "decline", "u1")).decision).toBe("allow");
    expect((await listRecordRequests(q, "t1"))[0]!.decision).toBe("allow");
  });
  it("reads never ask", async () => {
    await expect(createRecordRequest(fakeDb(), { thread_id: "t1", module: "crm", action: "find", record })).rejects.toThrow();
  });
});
