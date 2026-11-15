// The browser for one run (spec 4.6; brief task 15). A headless browser starts only when "browser allowed"
// is on for the Stick, with its own profile folder, and it stops when the run ends. The launcher is passed
// in: the real Chromium comes from the image (task 17), and tests use a fake.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stickHome } from "./policy.js";

export type BrowserHandle = { close(): Promise<void> };
export type BrowserLauncher = (profileDir: string) => Promise<BrowserHandle>;

/** The profile folder for one Stick: /data/home/sticks/<stick id>/.browser. */
export function browserProfileDir(root: string, stickId: string): string {
  return join(stickHome(root, stickId), ".browser");
}

/**
 * Runs `work` for one run. The browser is started before it and closed after it, even if it throws.
 * With browserAllowed false, no browser is started at all.
 */
export async function withRunBrowser<T>(options: {
  root: string;
  stickId: string;
  browserAllowed: boolean;
  launch: BrowserLauncher;
  work: () => Promise<T>;
}): Promise<T> {
  if (!options.browserAllowed) return options.work();
  const profile = browserProfileDir(options.root, options.stickId);
  await mkdir(profile, { recursive: true });
  const browser = await options.launch(profile);
  try {
    return await options.work();
  } finally {
    await browser.close();
  }
}
