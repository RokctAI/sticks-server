import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pointCatalogAtGateway, type RoutableCollection } from "./pi-gateway-catalog.js";

const ORIGINAL = process.env.STICKS_GATEWAY_URL;

type FakeProvider = {
  id: string;
  baseUrl?: string;
  getModels(): readonly { provider: string; baseUrl: string; id: string }[];
  stream(): string;
};

/** A fake collection with two providers and one method on the first (kept on the routed copy). */
function fakeCollection(): { models: RoutableCollection; providers: Map<string, FakeProvider> } {
  const providers = new Map<string, FakeProvider>();
  const anthropic: FakeProvider = {
    id: "anthropic",
    baseUrl: "https://api.anthropic.com",
    getModels: () => [{ id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com" }],
    stream: () => "streamed",
  };
  const openai: FakeProvider = {
    id: "openai",
    baseUrl: "https://api.openai.com/v1",
    getModels: () => [{ id: "gpt", provider: "openai", baseUrl: "https://api.openai.com/v1" }],
    stream: () => "streamed",
  };
  providers.set("anthropic", anthropic);
  providers.set("openai", openai);
  const models: RoutableCollection = {
    getProviders: () => [...providers.values()],
    setProvider: (provider) => {
      providers.set(provider.id, provider as FakeProvider);
    },
  };
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
    expect(providers.get("anthropic")?.stream()).toBe("streamed");
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
