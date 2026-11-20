// Seeds the built-in plugins (follow-up to #41; brief task 22). A built-in plugin is the engine's own description,
// stored in plugin_draft as approved, so it is callable from the start. Seeding is a system act for a built-in
// plugin, not an admin approval: an admin approval is still needed for any plugin a tenant adds.
// It writes only when the plugin is missing, so a restart never overwrites a stored plugin.
//
// Not done here (BLOCKED, see the PR): upstream's installed-connector record. The PR for #41 found no upstream
// seeding hook for installed connectors, so this seeds the engine's own table only. The boot call is in engine.ts,
// with the description embedded in github-plugin-document.ts (the bundle cannot read files).
import { draftFromOpenApi, type DraftPlugin } from "./plugin-builder.js";
import type { DraftRepository } from "./plugin-draft-store.js";

/** Stores the built-in plugin as approved if it is missing. Returns what happened. */
export async function seedBuiltinPlugin(
  repo: DraftRepository,
  name: string,
  document: unknown,
): Promise<"seeded" | "present"> {
  if (await repo.get(name)) return "present";
  const draft = draftFromOpenApi(name, document);
  const approved: DraftPlugin = { ...draft, status: "approved" };
  await repo.put(approved);
  return "seeded";
}
