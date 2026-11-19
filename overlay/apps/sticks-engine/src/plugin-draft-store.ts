// Stored plugin drafts (brief task 21, follow-up to #42). Drafts live in the engine's own table `plugin_draft`,
// created by this module with CREATE TABLE IF NOT EXISTS (no Prisma migration, as for sticks_keep_going).
// Approval needs the verified Pulsar role "Sticks Admin" (the settled rule, docs/pulsar-engine-interface.md).
// Saving a draft again resets it to draft: a changed description must be approved again.
import { callGate, PLUGIN_NAME, type DraftPlugin } from "./plugin-builder.js";

/** The role that may approve a plugin (settled 11-15). */
export const ADMIN_ROLE = "Sticks Admin";

export const PLUGIN_DRAFT_TABLE_SQL = `CREATE TABLE IF NOT EXISTS plugin_draft (
  name text PRIMARY KEY,
  status text NOT NULL CHECK (status IN ('draft', 'approved')),
  body jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

export interface DraftRepository {
  get(name: string): Promise<DraftPlugin | undefined>;
  put(draft: DraftPlugin): Promise<void>;
}

/** The one database call the repository needs: parameterized SQL in, rows out. */
export type SqlQuery = (text: string, values?: unknown[]) => Promise<unknown[]>;

/** Creates the table if it is missing. Safe to run on every start. */
export async function ensurePluginDraftTable(query: SqlQuery): Promise<void> {
  await query(PLUGIN_DRAFT_TABLE_SQL, []);
}

/** The repository over `plugin_draft`. Names are checked before any SQL runs. */
export function sqlDraftRepository(query: SqlQuery): DraftRepository {
  return {
    async get(name) {
      assertName(name);
      const rows = (await query("SELECT body FROM plugin_draft WHERE name = $1", [name])) as { body: DraftPlugin }[];
      return rows[0]?.body;
    },
    async put(draft) {
      assertName(draft.name);
      await query(
        `INSERT INTO plugin_draft (name, status, body, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (name) DO UPDATE SET status = EXCLUDED.status, body = EXCLUDED.body, updated_at = now()`,
        [draft.name, draft.status, JSON.stringify(draft)],
      );
    },
  };
}

/** Stores a draft as a draft. A stored draft with the same name is replaced and must be approved again. */
export async function saveDraft(repo: DraftRepository, draft: DraftPlugin): Promise<void> {
  await repo.put({ ...draft, status: "draft" });
}

/**
 * Approves a stored draft. Only the verified role "Sticks Admin" may; any other role is refused and the
 * draft stays as it was.
 */
export async function approveStoredDraft(
  repo: DraftRepository,
  name: string,
  verifiedRole: string,
): Promise<DraftPlugin> {
  if (verifiedRole !== ADMIN_ROLE) throw new Error("only a Sticks Admin can approve a plugin");
  const draft = await repo.get(name);
  if (!draft) throw new Error(`no draft named ${name}`);
  const approved: DraftPlugin = { ...draft, status: "approved" };
  await repo.put(approved);
  return approved;
}

/** Whether a stored plugin's operation may be called now: a draft refuses; an approved one runs, asks or refuses. */
export async function callGateForStored(
  repo: DraftRepository,
  name: string,
  operationId: string,
): Promise<"refuse" | "run" | "ask"> {
  const draft = await repo.get(name);
  if (!draft) return "refuse";
  return callGate(draft, operationId);
}

function assertName(name: string): void {
  if (!PLUGIN_NAME.test(name) || name.includes("--") || name.includes("..")) {
    throw new Error("not a plugin name");
  }
}
