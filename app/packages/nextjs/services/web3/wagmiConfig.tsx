import { wagmiConnectors } from "./wagmiConnectors";
import { Chain, createClient, fallback, http } from "viem";
import { hardhat, mainnet } from "viem/chains";
import { createConfig } from "wagmi";
import scaffoldConfig, { DEFAULT_ALCHEMY_API_KEY, ScaffoldConfig } from "~~/scaffold.config";
import { getAlchemyHttpUrl } from "~~/utils/scaffold-eth";


const { targetNetworks } = scaffoldConfig;

// We always want to have mainnet enabled (ENS resolution, ETH price, etc). But only once.
export const enabledChains = targetNetworks.find((network: Chain) => network.id === 1)
  ? targetNetworks
  : ([...targetNetworks, mainnet] as const);

export const wagmiConfig = createConfig({
  chains: enabledChains,
  connectors: wagmiConnectors(),
  ssr: true,
  client: ({ chain }) => {
    // Only intentionally configured transports — no bare http() fallback that
    // silently degrades to rate-limited public RPCs. The chain's default RPC is
    // used only when nothing else is configured for it (e.g. local anvil).
    const rpcFallbacks = [];
    const rpcOverrideUrl = (scaffoldConfig.rpcOverrides as ScaffoldConfig["rpcOverrides"])?.[chain.id];
    if (rpcOverrideUrl) rpcFallbacks.push(http(rpcOverrideUrl));
    const alchemyHttpUrl = getAlchemyHttpUrl(chain.id);
    if (alchemyHttpUrl && scaffoldConfig.alchemyApiKey !== DEFAULT_ALCHEMY_API_KEY) {
      rpcFallbacks.push(http(alchemyHttpUrl));
    }
    if (chain.id === mainnet.id) rpcFallbacks.push(http("https://mainnet.rpc.buidlguidl.com"));
    if (rpcFallbacks.length === 0) rpcFallbacks.push(http());
    return createClient({
      chain,
      transport: fallback(rpcFallbacks),
      ...(chain.id !== (hardhat as Chain).id ? { pollingInterval: scaffoldConfig.pollingInterval } : {}),
    });
  }
});
