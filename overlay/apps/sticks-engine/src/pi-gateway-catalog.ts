// Points the model catalogue at the model gateway (spec 4.4, brief task 13). When STICKS_GATEWAY_URL is set,
// every provider's models get baseUrl `${gateway}/<provider>`, and the provider itself gets the same base URL.
// The wrapper inherits everything else from the original provider (its methods stay on its prototype).
// The gateway key is NOT set here: passing it as the request key is a separate step (docs/gateway-protocol.md).
// Types are structural, so this file needs no import from the pi-ai package (it lives in apps/, see the patch).

type RoutedEntry = { provider: string; baseUrl: string };

type RoutedProvider = {
  id: string;
  baseUrl?: string;
  getModels(): readonly RoutedEntry[];
  getAllModels?(): readonly RoutedEntry[];
};

/** The part of pi-ai's MutableModels this helper uses. */
export type RoutableCollection = {
  getProviders(): readonly RoutedProvider[];
  setProvider(provider: RoutedProvider): void;
};

const PROVIDER_ID = /^[a-z][a-z0-9-]*$/;

function prefixFor(gateway: string, provider: string): string {
  if (!PROVIDER_ID.test(provider)) throw new Error(`not a provider id: ${provider}`);
  return `${gateway}/${provider}`;
}

function routed<T extends RoutedEntry>(gateway: string, model: T): T {
  return { ...model, baseUrl: prefixFor(gateway, model.provider) };
}

function pointProvider<P extends RoutedProvider>(provider: P, gateway: string): P {
  const pointed: Record<string, unknown> = {
    baseUrl: provider.baseUrl === undefined ? undefined : prefixFor(gateway, provider.id),
    getModels: () => provider.getModels().map((model) => routed(gateway, model)),
  };
  if (provider.getAllModels) {
    const all = provider.getAllModels.bind(provider);
    pointed.getAllModels = () => all().map((model) => routed(gateway, model));
  }
  return Object.assign(Object.create(provider) as P, pointed);
}

/** Routes every provider in the collection through the gateway. No change when STICKS_GATEWAY_URL is unset. */
export function pointCatalogAtGateway<C extends RoutableCollection>(models: C): C {
  const gateway = (process.env.STICKS_GATEWAY_URL ?? "").trim().replace(/\/+$/, "");
  if (!gateway) return models;
  if (!/^https?:\/\//.test(gateway)) throw new Error("STICKS_GATEWAY_URL must be an http(s) URL");
  for (const provider of models.getProviders()) {
    models.setProvider(pointProvider(provider, gateway));
  }
  return models;
}
