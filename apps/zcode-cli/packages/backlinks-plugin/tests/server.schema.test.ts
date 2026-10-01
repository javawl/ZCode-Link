import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKLINKS_MCP_TOOLS } from "../src/server.js";

function inputSchema(name: string): Record<string, unknown> {
  const tool = BACKLINKS_MCP_TOOLS.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected MCP tool ${name}`);
  return tool.inputSchema as Record<string, unknown>;
}

function propertiesOf(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = schema.properties;
  assert.equal(typeof properties, "object");
  assert.notEqual(properties, null);
  assert.equal(Array.isArray(properties), false);
  return properties as Record<string, unknown>;
}

test("backlink command tools publish flat action schemas with operation fields", () => {
  for (const name of ["backlinks", "backlinks_worker", "backlinks_browser"]) {
    const schema = inputSchema(name);
    assert.equal(schema.type, "object");
    assert.equal("anyOf" in schema, false);
    assert.equal("oneOf" in schema, false);
    assert.deepEqual(schema.required, ["action"]);

    const properties = propertiesOf(schema);
    const action = properties.action as Record<string, unknown>;
    assert.equal(action.type, "string");
    assert.ok(Array.isArray(action.enum));
    assert.match(String(action.description), /Required fields per action/u);
  }
});

test("flat schemas preserve publishing and browser operation inputs", () => {
  const publishing = propertiesOf(inputSchema("backlinks"));
  const publishingAction = publishing.action as Record<string, unknown>;
  assert.ok((publishingAction.enum as string[]).includes("batch_get"));
  assert.ok((publishingAction.enum as string[]).includes("item_result"));
  assert.equal((publishing.batchId as Record<string, unknown>).type, "integer");
  assert.equal((publishing.itemId as Record<string, unknown>).type, "integer");
  assert.match(String(publishingAction.description), /batch_get: batchId/u);
  assert.match(String(publishingAction.description), /status=live requires publicUrl, anchorText, targetUrl, itemId/u);
  assert.match(String(publishingAction.description), /status=failed requires failureMode, failureReason, itemId/u);

  const browser = propertiesOf(inputSchema("backlinks_browser"));
  const browserAction = browser.action as Record<string, unknown>;
  assert.ok((browserAction.enum as string[]).includes("status"));
  assert.ok((browserAction.enum as string[]).includes("navigate"));
  assert.equal((browser.page as Record<string, unknown>).type, "string");
  assert.equal((browser.url as Record<string, unknown>).type, "string");
  assert.match(String(browserAction.description), /status: no additional fields/u);
  assert.match(String(browserAction.description), /navigate: page, url/u);
});
