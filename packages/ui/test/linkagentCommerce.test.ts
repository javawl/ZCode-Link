import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  isLinkAgentApiProvider,
  isLinkAgentApiTemplate,
} from "../src/lib/linkagentModelSettings.js";
import { CodingPlanEntryButton } from "../src/settings/CodingPlanEntryButton.js";
import {
  CodingPlanUpgradeDialogProvider,
  useCodingPlanUpgradeDialog,
} from "../src/settings/CodingPlanUpgradeDialogProvider.js";
import { useStartPlanRecommendation } from "../src/hooks/useStartPlanRecommendation.js";

test("API settings exclude account plans without hiding user API configurations", () => {
  assert.equal(isLinkAgentApiProvider({ config: { group: "standard-personal" } }), true);
  assert.equal(isLinkAgentApiProvider({ config: { group: "zai-family" } }), false);
  assert.equal(isLinkAgentApiProvider({ config: { group: "bigmodel-family" } }), false);
});

test("retired purchase buttons render nothing, including bypass requests", () => {
  let clicked = false;
  const html = renderToStaticMarkup(
    createElement(
      CodingPlanEntryButton,
      {
        bypassGate: true,
        onClick: () => {
          clicked = true;
        },
      },
      "Upgrade / Pay",
    ),
  );
  assert.equal(html, "");
  assert.equal(clicked, false);
});

test("template chooser removes subscription-specific endpoints while retaining ordinary APIs", () => {
  assert.equal(isLinkAgentApiTemplate({ templateId: "bigmodel-api" }), false);
  assert.equal(isLinkAgentApiTemplate({ templateId: "zai-api" }), false);
  for (const templateId of ["bigmodel-standard-api", "zai-standard-api", "openai", "custom"]) {
    assert.equal(isLinkAgentApiTemplate({ templateId }), true);
  }
});

test("legacy purchase requests resolve as not opened and never mount a payment view", () => {
  const observed: boolean[] = [];
  function Probe() {
    const commerce = useCodingPlanUpgradeDialog();
    assert.equal(
      commerce.openCodingPlanUpgrade(
        { providerId: "zai" },
        {
          signal: new AbortController().signal,
          onResult: (opened) => observed.push(opened),
        },
      ),
      false,
    );
    return createElement("main", null, "Workspace");
  }
  const html = renderToStaticMarkup(
    createElement(CodingPlanUpgradeDialogProvider, null, createElement(Probe)),
  );
  assert.deepEqual(observed, [false]);
  assert.equal(html, "<main>Workspace</main>");
  assert.doesNotMatch(html, /webview|iframe|payment|checkout/i);
});

test("task and subagent recommendations preserve the user's chosen model", async () => {
  const selection = { providerId: "personal", modelId: "custom-model" };
  for (const surface of [undefined, "subagent"] as const) {
    assert.equal(await useStartPlanRecommendation(null, surface)(selection), selection);
  }
});
