import assert from "node:assert/strict";
import test from "node:test";
import type { ModelSelection, ModelSelectionView } from "@zcode/provider";
import { createModelSelectionService } from "../src/model-provider/providerFacadeServices.js";

const fallback: ModelSelection = {
  providerId: "newapi",
  modelId: "first",
  options: { reasoningLevel: "high" },
};

function view(selection: ModelSelection = fallback): ModelSelectionView {
  return {
    revision: 1,
    preferredSelection: selection,
    providers: [],
  };
}

test("configured default model is validated, persisted and returned from the same service", async () => {
  let saved: ModelSelection | undefined;
  const service = createModelSelectionService(
    {
      getView: (configured?: ModelSelection) => view(configured),
      onDidChange: () => () => {},
    } as never,
    async () => {},
    {
      read: async () => saved,
      saveConfiguredDefault: async (selection) => (saved = selection),
    },
  );
  const selected: ModelSelection = {
    providerId: "newapi",
    modelId: "second",
    options: { reasoningLevel: "medium" },
  };

  const result = await service.setConfiguredDefault(selected);
  assert.deepEqual(saved, selected);
  assert.deepEqual(result.preferredSelection, selected);
  service.dispose();
});

test("invalid default model never reaches persistence", async () => {
  let writes = 0;
  const service = createModelSelectionService(
    {
      getView: () => view(),
      onDidChange: () => () => {},
    } as never,
    async () => {},
    {
      read: async () => undefined,
      saveConfiguredDefault: async (selection) => {
        writes += 1;
        return selection;
      },
    },
  );
  await assert.rejects(
    service.setConfiguredDefault({
      providerId: "missing",
      modelId: "missing",
      options: { reasoningLevel: "high" },
    }),
    /不可用/u,
  );
  assert.equal(writes, 0);
  service.dispose();
});
