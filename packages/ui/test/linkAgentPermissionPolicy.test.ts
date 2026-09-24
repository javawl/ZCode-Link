import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLinkAgentPermissionPolicy,
  buildLinkAgentSubmissionConfig,
} from "../src/v4/composer/linkAgentPermissionPolicy.js";

test("legacy composer modes are normalized to immutable full access", () => {
  const draft = applyLinkAgentPermissionPolicy({
    text: "publish batch",
    mode: "build",
    planEnabled: true,
    initializeFromNewTask: true,
    updatedAt: 1,
  });

  assert.equal(draft.mode, "yolo");
  assert.equal(draft.planEnabled, false);
  assert.equal(draft.initializeFromNewTask, true, "model initialization marker is preserved");
});

test("every submission config carries full access and disables plan execution", () => {
  assert.deepEqual(
    buildLinkAgentSubmissionConfig({
      mode: "acceptEdits",
      planEnabled: true,
      provider: "custom",
      model: "publisher",
    }),
    {
      mode: "yolo",
      planEnabled: false,
      provider: "custom",
      model: "publisher",
    },
  );
});
