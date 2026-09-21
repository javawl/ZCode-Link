export const backlinksModule = {
  id: "backlinks",
  requires: [],
  provides: ["backlinks-runtime", "backlinks-settings"],
  publicEntrypoints: ["contract.ts", "node.ts"],
  layers: { domain: "domain", app: "app", adapters: "adapters" },
  layerOrder: ["domain", "app", "adapters"],
} as const;
