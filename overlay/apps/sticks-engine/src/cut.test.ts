import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

// The modules spec 11.2 cuts that sit directly under the app's composition (patch 0003 removes
// their imports and mounts from upstream's apps/api/src/app.ts).
const CUT_MODULES = [
  "account-export",
  "account-import",
  "email-inbound",
  "marketing-email",
  "plugin-submissions",
  "referral-email",
];

describe("spec 11.2 messaging cut (patch 0004)", () => {
  it("the app does not import the messaging runtime or the team-chat startup module, or build a messaging surface", async () => {
    const app = await readFile(new URL("../../api/src/app.ts", import.meta.url), "utf8");
    expect(app).not.toMatch(/from "\.\/messaging-runtime\.js"/);
    expect(app).not.toMatch(/from "\.\/team-chat-startup\.js"/);
    expect(app).not.toMatch(/ChatSdkMessagingSurface|installedMessaging|startMessagingRuntime/);
  });
});

describe("spec 11.2 cuts in the composition (patch 0003)", () => {
  it("the app no longer imports the cut modules", async () => {
    const app = await readFile(new URL("../../api/src/app.ts", import.meta.url), "utf8");
    for (const name of CUT_MODULES) {
      expect(app, `app.ts still imports ./${name}.js`).not.toMatch(
        new RegExp(`from "\\./${name}\\.js"`),
      );
    }
  });
});
