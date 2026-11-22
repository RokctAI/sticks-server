// Pulsar plugins (Ray 11-21: every part of Pulsar reachable from Rakazo, one plugin per area). Each area becomes
// one plugin with five general tools (find, get, create, update, submit) over that area's record types. The
// plugins are seeded as drafts: a tenant admin approves each area, which switches it on (plugins are
// admin-approved). Reads run freely; create, update and submit ask the owner each time (upstream's approval
// for write calls). The engine proxy only touches the area's own record types, and calls Pulsar's
// /api/resource with the Sticks service user's token, so Pulsar's role permissions for that user apply.
import { draftFromOpenApi, type DraftPlugin } from "./plugin-builder.js";
import type { DraftRepository } from "./plugin-draft-store.js";
import { areaPluginDocument, pluginName, TESTED_AREAS } from "./pulsar-plugin-docs.js";

export * from "./pulsar-plugin-docs.js";


/** Seeds every tested area as a draft (not callable until an admin approves it). Leaves existing plugins alone. */
export async function seedPulsarPlugins(repo: DraftRepository, engineUrl: string): Promise<string[]> {
  const seeded: string[] = [];
  for (const area of TESTED_AREAS) {
    const name = pluginName(area);
    if (await repo.get(name)) continue;
    const draft: DraftPlugin = draftFromOpenApi(name, areaPluginDocument(area, engineUrl));
    await repo.put(draft);
    seeded.push(name);
  }
  return seeded;
}

