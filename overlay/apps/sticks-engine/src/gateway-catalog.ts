// Points one provider's catalogue at the model gateway (spec 4.4, brief task 13). Every model the provider
// lists gets baseUrl `${STICKS_GATEWAY_URL}/<provider>`; the provider itself gets the same base URL.
// The wrapper inherits everything else from the original provider (its methods stay on its prototype), and
// the original is not changed. Used by the catalogue patch (see docs/gateway-protocol.md, "Not in this contract").
import { gatewayUrlFor, throughGateway } from "./gateway.js";

type GatewayEntry = { provider: string; baseUrl: string };

/** The part of a pi-ai provider this helper reads. */
export type CatalogSource = {
  id: string;
  baseUrl?: string;
  getModels(): readonly GatewayEntry[];
  getAllModels?(): readonly GatewayEntry[];
};

export function pointProviderAtGateway<P extends CatalogSource>(provider: P, gatewayUrl: string): P {
  const reroute = (models: readonly GatewayEntry[]) => models.map((model) => throughGateway(model, gatewayUrl));
  const pointed: Record<string, unknown> = {
    baseUrl: provider.baseUrl === undefined ? undefined : gatewayUrlFor(gatewayUrl, provider.id),
    getModels: () => reroute(provider.getModels()),
  };
  if (provider.getAllModels) {
    const all = provider.getAllModels.bind(provider);
    pointed.getAllModels = () => reroute(all());
  }
  return Object.assign(Object.create(provider) as P, pointed);
}
