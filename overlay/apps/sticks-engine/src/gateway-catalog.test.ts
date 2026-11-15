import { describe, expect, it } from "vitest";
import { pointProviderAtGateway, type CatalogSource } from "./gateway-catalog.js";

/** A provider shaped like a pi-ai class instance: its stream method lives on the prototype. */
class FakeProvider {
  readonly id = "anthropic";
  readonly baseUrl = "https://api.anthropic.com";
  private readonly models = [
    { id: "claude", provider: "anthropic", baseUrl: "https://api.anthropic.com", api: "anthropic-messages" },
  ];
  getModels() {
    return this.models;
  }
  getAllModels() {
    return this.models;
  }
  stream(): string {
    return "streamed";
  }
}

describe("a provider pointed at the gateway (brief task 13)", () => {
  it("every listed model and the provider get the gateway prefix for their provider", () => {
    const pointed = pointProviderAtGateway(new FakeProvider() as CatalogSource & FakeProvider, "https://gw.example");
    expect(pointed.baseUrl).toBe("https://gw.example/anthropic");
    expect(pointed.getModels()[0]?.baseUrl).toBe("https://gw.example/anthropic");
    expect(pointed.getAllModels?.()[0]?.baseUrl).toBe("https://gw.example/anthropic");
    expect(pointed.getModels()[0]?.id).toBe("claude");
  });

  it("the prototype methods still work on the wrapper", () => {
    const pointed = pointProviderAtGateway(new FakeProvider() as CatalogSource & FakeProvider, "https://gw.example");
    expect(pointed.stream()).toBe("streamed");
  });

  it("the original provider is not changed", () => {
    const original = new FakeProvider() as CatalogSource & FakeProvider;
    pointProviderAtGateway(original, "https://gw.example");
    expect(original.baseUrl).toBe("https://api.anthropic.com");
    expect(original.getModels()[0]?.baseUrl).toBe("https://api.anthropic.com");
  });

  it("a provider without getAllModels is wrapped too", () => {
    const source = {
      id: "openai",
      baseUrl: "https://api.openai.com/v1",
      getModels: () => [{ provider: "openai", baseUrl: "https://api.openai.com/v1" }],
    };
    const pointed = pointProviderAtGateway(source, "https://gw.example/");
    expect(pointed.getModels()[0]?.baseUrl).toBe("https://gw.example/openai");
    expect((pointed as CatalogSource).getAllModels).toBeUndefined();
  });

  it("a provider id that is not a plain name is refused", () => {
    const source = { id: "Bad Name", baseUrl: "x", getModels: () => [] };
    expect(() => pointProviderAtGateway(source, "https://gw.example")).toThrow("not a provider id");
  });
});
