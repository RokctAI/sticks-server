// Record cards (Ray 11-21, "Approved as long as ai is not calculating totals"). Before a Stick creates, changes or
// submits a Pulsar record, it asks the person in chat. The card shows the record exactly as Pulsar returned it
// (amounts are Pulsar's formatted strings; neither the Stick nor the app adds anything up). The person answers
// allow or decline; a repeat answer is a no-op. Caller: the Sticks app record cards (agent#686) and the
// built-in "record-confirm" plugin a Stick uses to ask and then read the answer.
import type { SqlQuery } from "./plugin-draft-store.js";

export const RECORD_REQUESTS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS sticks_record_requests (
  request_id text PRIMARY KEY,
  thread_id text NOT NULL,
  message_id text,
  module text NOT NULL,
  action text NOT NULL,
  record jsonb NOT NULL,
  decision text,
  answered_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
)`;

export const MODULES = ["crm", "selling", "accounts", "stock", "hr", "projects"] as const;
export const ASKING_ACTIONS = ["create", "update", "submit"] as const;

export class RecordRequestError extends Error {
  constructor(message: string, readonly status: 400 | 404) {
    super(message);
  }
}

type Field = { label: string; value: string; old?: string };
type Line = { item: string; qty: string; amount: string };
export type CardRecord = { type: string; id: string; title: string; url?: string; fields: Field[]; lines?: Line[]; total?: string; tax?: string };
export type RecordRequest = {
  requestId: string; threadId: string; messageId: string | null; module: string; action: string;
  record: CardRecord; decision: "allow" | "decline" | null; at: string; answeredAt: string | null;
};

const str = (v: unknown): v is string => typeof v === "string";

/** Amounts must already be strings from Pulsar; a number means someone computed or reshaped it, so it is refused. */
export function validRecord(r: unknown): r is CardRecord {
  if (!r || typeof r !== "object") return false;
  const x = r as Record<string, unknown>;
  if (!str(x.type) || !str(x.id) || !str(x.title) || !Array.isArray(x.fields)) return false;
  if (x.url !== undefined && !(str(x.url) && /^https:\/\//.test(x.url))) return false;
  if (x.total !== undefined && !str(x.total)) return false;
  if (x.tax !== undefined && !str(x.tax)) return false;
  if (!x.fields.every((f) => f && str(f.label) && str(f.value) && (f.old === undefined || str(f.old)))) return false;
  if (x.lines !== undefined && !(Array.isArray(x.lines) && x.lines.every((l) => l && str(l.item) && str(l.qty) && str(l.amount)))) return false;
  return true;
}

function toRequest(r: Record<string, unknown>): RecordRequest {
  return {
    requestId: r.request_id as string, threadId: r.thread_id as string, messageId: (r.message_id as string) ?? null,
    module: r.module as string, action: r.action as string, record: r.record as CardRecord,
    decision: (r.decision as "allow" | "decline") ?? null,
    at: new Date(r.created_at as string).toISOString(),
    answeredAt: r.answered_at ? new Date(r.answered_at as string).toISOString() : null,
  };
}

export async function createRecordRequest(query: SqlQuery, input: Record<string, unknown>, newId: () => string = () => crypto.randomUUID()): Promise<RecordRequest> {
  const { thread_id, message_id, module, action, record } = input;
  if (!str(thread_id) || !thread_id) throw new RecordRequestError("thread_id is required", 400);
  if (message_id !== undefined && !str(message_id)) throw new RecordRequestError("message_id must be text", 400);
  if (!str(module) || !(MODULES as readonly string[]).includes(module)) throw new RecordRequestError("unknown module", 400);
  if (!str(action) || !(ASKING_ACTIONS as readonly string[]).includes(action)) throw new RecordRequestError("only create, update and submit ask", 400);
  if (!validRecord(record)) throw new RecordRequestError("record must be Pulsar's record with amounts as text", 400);
  await query(RECORD_REQUESTS_TABLE_SQL, []);
  const rows = (await query(
    `INSERT INTO sticks_record_requests (request_id, thread_id, message_id, module, action, record) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [newId(), thread_id, message_id ?? null, module, action, JSON.stringify(record)],
  )) as Array<Record<string, unknown>>;
  return toRequest(rows[0]!);
}

/** Records the first answer only. A repeat answer returns the stored request unchanged. */
export async function answerRecordRequest(query: SqlQuery, requestId: unknown, decision: unknown, by: string): Promise<RecordRequest> {
  if (!str(requestId) || !requestId) throw new RecordRequestError("requestId is required", 400);
  if (decision !== "allow" && decision !== "decline") throw new RecordRequestError("decision must be allow or decline", 400);
  await query(RECORD_REQUESTS_TABLE_SQL, []);
  await query(
    `UPDATE sticks_record_requests SET decision = $2, answered_by = $3, answered_at = now() WHERE request_id = $1 AND decision IS NULL`,
    [requestId, decision, by],
  );
  return getRecordRequest(query, requestId);
}

export async function getRecordRequest(query: SqlQuery, requestId: string): Promise<RecordRequest> {
  await query(RECORD_REQUESTS_TABLE_SQL, []);
  const rows = (await query(`SELECT * FROM sticks_record_requests WHERE request_id = $1`, [requestId])) as Array<Record<string, unknown>>;
  if (!rows[0]) throw new RecordRequestError("no such request", 404);
  return toRequest(rows[0]);
}

/** Requests in a thread, oldest first, answered ones included so a reload shows the answer, not the buttons. */
export async function listRecordRequests(query: SqlQuery, threadId: string, since?: string): Promise<RecordRequest[]> {
  await query(RECORD_REQUESTS_TABLE_SQL, []);
  const rows = (await query(
    `SELECT * FROM sticks_record_requests WHERE thread_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2::timestamptz OR answered_at > $2::timestamptz) ORDER BY created_at`,
    [threadId, since ?? null],
  )) as Array<Record<string, unknown>>;
  return rows.map(toRequest);
}

/** Built-in plugin: the Stick asks (POST) and later reads the answer (GET). Reading never asks for approval. */
export function recordConfirmPluginDocument(engineUrl: string): unknown {
  return {
    openapi: "3.0.3",
    info: { title: "Record confirm", version: "1.0.0" },
    servers: [{ url: engineUrl }],
    paths: {
      "/internal/record-requests": {
        post: {
          operationId: "ask_to_confirm_record",
          summary: "Show the person the Pulsar record you are about to create, update or submit, and ask them to allow it. Pass the record exactly as Pulsar returned it; never calculate totals.",
          requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["thread_id", "module", "action", "record"] } } } },
          responses: { "200": { description: "The request, with its requestId" } },
        },
      },
      "/internal/record-requests/{requestId}": {
        get: {
          operationId: "get_record_answer",
          summary: "Read whether the person allowed or declined. decision is null while they have not answered.",
          parameters: [{ name: "requestId", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "The request with its decision" } },
        },
      },
    },
  };
}
