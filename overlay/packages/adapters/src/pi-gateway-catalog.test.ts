import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MutableModels, Provider } from "@earendil-works/pi-ai";
import { pointCatalogAtGateway } from "./pi-gateway-catalog.js";

const ORIGINAL = process.env.STICKS_GATEWAY_URL;

/** A fake collection: enough of MutableModels for the helper, with the two providers it routes. */
function fakeCollection(): { models: MutableModels; providers: Map<string, Provider> } {
  const providers = new Map<string, Provider>();
  const anthropic = {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    getModels: () => [{ id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" }],
    stream: () => "streamed",
  } as unknown as Provider;
  const openai = {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    getModels: () => [{ id: "gpt", provider: "openai", baseUrl: "https://api.openai.com/v1" }],
  } as unknown as Provider;
  providers.set("anthropic", anthropic);
  providers.set("openai", openai);
  const models = {
    getProviders: () => [...providers.values()],
    setProvider: (provider: Provider) => providers.set(provider.id, provider),
  } as unknown as MutableModels;
  return { models, providers };
}

describe("the catalogue through the gateway (brief task 13)", () => {
  beforeEach(() => {
    process.env.STICKS_GATEWAY_URL = "https://gw.example/";
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.STICKS_GATEWAY_URL;
    else process.env.STICKS_GATEWAY_URL = ORIGINAL;
  });

  it("every provider's models get the gateway prefix for their own provider", () => {
    const { models, providers } = fakeCollection();
    pointCatalogAtGateway(models);
    expect(providers.get("anthropic")?.baseUrl).toBe("https://gw.example/anthropic");
    expect(providers.get("anthropic")?.getModels()[0]?.baseUrl).toBe("https://gw.example/anthropic");
    expect(providers.get("openai")?.getModels()[0]?.baseUrl).toBe("https://gw.example/openai");
  });

  it("a provider's own methods still work on the routed copy", () => {
    const { models, providers } = fakeCollection();
    pointCatalogAtGateway(models);
    expect((providers.get("anthropic") as unknown as { stream(): string }).stream()).toBe("streamed");
  });

  it("with STICKS_GATEWAY_URL unset, the collection is not changed", () => {
    delete process.env.STICKS_GATEWAY_URL;
    const { models, providers } = fakeCollection();
    pointCatalogAtGateway(models);
    expect(providers.get("anthropic")?.getModels()[0]?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("a gateway that is not an http(s) URL is refused", () => {
    process.env.STICKS_GATEWAY_URL = "ftp://gw.example";
    const { models } = fakeCollection();
    expect(() => pointCatalogAtGateway(models)).toThrow("http(s)");
  });
});
