import assert from "node:assert/strict";
import test from "node:test";
import { LINK_AGENT_PRODUCT_PROFILE } from "@zcode/shared";
import { createSettingsPageConfig } from "../src/settings/settingsPageConfig.js";

test("LinkAgent exposes only backlink operations and the minimal settings surface", () => {
  assert.deepEqual(LINK_AGENT_PRODUCT_PROFILE.primaryNavigation, ["runs", "backlinks"]);
  assert.deepEqual(LINK_AGENT_PRODUCT_PROFILE.settingsSections, [
    "general",
    "appearance",
    "modelProvider",
    "backlinks",
  ]);
  assert.deepEqual(LINK_AGENT_PRODUCT_PROFILE.officialPlugins, ["backlinks"]);
  assert.deepEqual(LINK_AGENT_PRODUCT_PROFILE.agentPermission, {
    mode: "yolo",
    mutable: false,
  });
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.genericTaskCreation, false);
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.commandCenter, false);
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.automations, false);
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.pluginStore, false);
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.offPeak, false);
  assert.equal(LINK_AGENT_PRODUCT_PROFILE.features.feedback, false);

  const { settingsSections } = createSettingsPageConfig({
    isDesktop: true,
    isMacDesktop: true,
  });
  assert.deepEqual(
    settingsSections.map((section) => section.id),
    LINK_AGENT_PRODUCT_PROFILE.settingsSections,
  );
});
