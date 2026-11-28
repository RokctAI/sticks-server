// Apps without a plugin (spec 4.7; brief task 20). These are the approval rules a connector's tools are
// judged by, tested against upstream's own functions in packages/core/src/runs/action-approval.ts.
//
// Read actions run freely; write actions ask for approval. A declared write always asks, even when its
// name looks like a read; a declared read does not relax the name check.
import { describe, expect, it } from "vitest";
import { connectorToolRequiresApproval, toolRequiresApproval } from "../../../packages/core/src/runs/action-approval.ts";

describe("connector tools: read runs freely, write asks (brief task 20)", () => {
  it("a declared read of a read-looking name runs without approval", () => {
    expect(connectorToolRequiresApproval("list_invoices", true)).toBe(false);
    expect(connectorToolRequiresApproval("get_customer", true)).toBe(false);
  });

  it("a declared write asks for approval, even when its name looks like a read", () => {
    expect(connectorToolRequiresApproval("list_invoices", false)).toBe(true);
  });

  it("a read declared as read does not override a write-looking name", () => {
    expect(connectorToolRequiresApproval("create_invoice", true)).toBe(true);
    expect(connectorToolRequiresApproval("send_email", true)).toBe(true);
  });

  it("a tool with no declared effect and a read-looking name is a read; any other name asks", () => {
    expect(connectorToolRequiresApproval("search_orders")).toBe(false);
    expect(connectorToolRequiresApproval("frobnicate")).toBe(true);
  });

  it("through the run's gate, a connector tool follows the same rule", () => {
    expect(toolRequiresApproval("list_invoices", true, true)).toBe(false);
    expect(toolRequiresApproval("create_invoice", true, true)).toBe(true);
  });
});

/*
 * BLOCKED (brief task 20), not built in this PR. Each needs a fixture or a run-level harness that is
 * not in this repository yet, so it is not guessed here:
 * - an admin approves a connector before any Stick can use it: upstream's gate is requireAdmin and
 *   approvedPluginEntries (apps/api/src/admins.ts, routes/capabilities.ts). A DB-backed test needs an
 *   admin and an unapproved connector seeded, then a Stick's call refused.
 * - credentials are never sent to the model: needs a run whose model request is captured (a spy
 *   runtime through createApp's runtime override) and a connector with a stored credential.
 * - the call leaves from the engine, never from the sandbox: needs a connector call traced to its
 *   network origin.
 * - OpenAPI/GraphQL connector and MCP plugin paths still work: needs the connector loader run on the
 *   trimmed engine, which is a CI run, not a local check.
 */
