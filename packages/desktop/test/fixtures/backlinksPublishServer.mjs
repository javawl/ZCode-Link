import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const PUBLISH_MODEL_ID = "linkagent-publish-fixture";
export const PUBLISH_COMPLETION = "LINKAGENT_PUBLISH_ACCEPTED";

function respondModel(res, request, block) {
  const stop = block.type === "tool_use" ? "tool_use" : "end_turn";
  const message = {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model: PUBLISH_MODEL_ID,
    content: [block],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10 },
  };
  if (!request.stream) {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(message));
    return;
  }
  res.setHeader("content-type", "text/event-stream");
  const event = (type, value) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`);
  event("message_start", { message: { ...message, content: [], stop_reason: null } });
  event("content_block_start", {
    index: 0,
    content_block: block.type === "tool_use" ? { ...block, input: {} } : { type: "text", text: "" },
  });
  event("content_block_delta", {
    index: 0,
    delta:
      block.type === "tool_use"
        ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
        : { type: "text_delta", text: block.text },
  });
  event("content_block_stop", { index: 0 });
  event("message_delta", {
    delta: { stop_reason: stop, stop_sequence: null },
    usage: { output_tokens: 10 },
  });
  event("message_stop", {});
  res.end();
}

export async function createBacklinksPublishFixture(evidence) {
  const state = {
    modelRequests: [],
    steps: [],
    errors: [],
    claims: 0,
    heartbeats: 0,
    submissions: 0,
    publicReads: 0,
    reports: [],
    releases: 0,
    skillLoaded: false,
    anchorObserved: false,
    traces: [],
  };
  let baseUrl;
  let nextStep = 0;
  let pending;
  const item = () => ({
    id: 1001,
    sourceId: 51,
    sourceName: "Fixture Directory",
    sourceUrl: `${baseUrl}/directory/submit`,
    sourceHost: "127.0.0.1",
    submitUrl: `${baseUrl}/directory/submit`,
    sourceNotes: "Local integration test",
    category: "directory",
    tags: [],
    paymentType: "free",
    linkType: "dofollow",
    status: state.reports.length ? "executed" : "pending",
    failureMode: null,
    failureReason: null,
    publishedUrl: state.reports.length ? `${baseUrl}/directory/entry` : null,
    publishStatus: state.reports.length ? "live" : null,
    plannedAt: "2026-09-22",
  });
  const batch = () => ({
    id: 615,
    websiteId: 1,
    name: "Local publish test",
    websiteName: "Fixture Project",
    websiteHost: "fixture.example",
    plannedAt: "2026-09-22",
    executing: state.claims > state.releases,
    counts: {
      pending: state.reports.length ? 0 : 1,
      executed: state.reports.length,
      failed: 0,
      skipped: 0,
      total: 1,
    },
  });
  const steps = () => [
    ["Skill", { skill: "backlinks:backlink-publish" }],
    ["backlinks", { action: "batch_get", batchId: 615 }],
    ["backlinks", { action: "batch_claim", batchId: 615, itemIds: [1001] }],
    [
      "backlinks_browser",
      { action: "navigate", page: "fixture", url: `${baseUrl}/directory/submit` },
    ],
    ["backlinks", { action: "lease_heartbeat", leaseId: 900 }],
    [
      "backlinks_browser",
      { action: "fill", page: "fixture", selector: 'input[name="name"]', value: "Fixture Project" },
    ],
    [
      "backlinks_browser",
      {
        action: "fill",
        page: "fixture",
        selector: 'input[name="url"]',
        value: `${baseUrl}/promoted`,
      },
    ],
    ["backlinks_browser", { action: "click", page: "fixture", selector: 'button[type="submit"]' }],
    [
      "backlinks_browser",
      { action: "snapshot", page: "fixture", selector: `a[href="${baseUrl}/promoted"]` },
    ],
    [
      "backlinks",
      {
        action: "item_result",
        itemId: 1001,
        status: "live",
        publicUrl: `${baseUrl}/directory/entry`,
        anchorText: "Fixture Project",
        targetUrl: `${baseUrl}/promoted`,
        evidence: "本地测试站点的公开链接已核验",
      },
    ],
    ["backlinks", { action: "lease_release", leaseId: 900 }],
    ["backlinks_browser", { action: "close" }],
  ];
  const save = () => writeFile(join(evidence, "workflow.json"), JSON.stringify(state, null, 2));
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString();
      if (req.url?.includes("messages")) {
        const body = JSON.parse(raw);
        const offered = (body.tools ?? []).map((tool) => tool.name);
        state.modelRequests.push({
          tools: offered,
          hasPublishCommand: JSON.stringify(body.messages).includes("backlink-publish"),
        });
        // Title generation is a separate tool-free request; it must not advance the scripted turn.
        if (!offered.length) {
          respondModel(res, body, { type: "text", text: "Fixture publish" });
          return;
        }
        if (pending) {
          const results = body.messages.flatMap((message) =>
            Array.isArray(message.content) ? message.content : [],
          );
          const result = results.find(
            (entry) => entry.type === "tool_result" && entry.tool_use_id === pending.id,
          );
          assert.ok(result, `Missing result for ${pending.name}`);
          assert.equal(
            result.is_error === true,
            false,
            `Tool failed: ${JSON.stringify(result.content).slice(0, 500)}`,
          );
          const output = JSON.stringify(result.content);
          assert.doesNotMatch(
            output,
            /"isError"\s*:\s*true|BACKLINKS_UNAUTHORIZED|BACKLINKS_TRANSPORT/,
          );
          if (pending.name === "Skill") {
            assert.match(output, /batch_claim/);
            state.skillLoaded = true;
          }
          if (pending.input.action === "snapshot") {
            assert.match(output, /Fixture Project/);
            state.anchorObserved = true;
          }
          pending = undefined;
        }
        const step = steps()[nextStep++];
        if (!step) {
          await save();
          respondModel(res, body, { type: "text", text: PUBLISH_COMPLETION });
          return;
        }
        const [kind, input] = step;
        const name =
          kind === "Skill" ? "Skill" : offered.find((value) => value.endsWith(`__${kind}`));
        assert.ok(name && offered.includes(name), `Missing actual tool: ${kind}`);
        pending = { id: `call_fixture_${nextStep}`, name, input };
        state.steps.push({ name, action: input.action ?? "load-skill" });
        await save();
        respondModel(res, body, { type: "tool_use", ...pending });
        return;
      }
      if (req.url?.startsWith("/api/agent/")) {
        assert.equal(req.headers.authorization, "Bearer local-fixture-token");
        if (req.headers["x-zcode-trace-id"])
          state.traces.push(String(req.headers["x-zcode-trace-id"]));
        res.setHeader("content-type", "application/json");
        let value = {};
        if (req.url === "/api/agent/batches") value = { batches: [batch()] };
        else if (req.url === "/api/agent/batches/615")
          value = {
            batch: batch(),
            website: {
              id: 1,
              name: "Fixture Project",
              siteUrl: `${baseUrl}/promoted`,
              siteHost: "fixture.example",
              shortDescription: "Fixture description",
              longDescription: null,
              logoUrl: null,
              screenshotUrl: null,
              keyFeatures: null,
              pricingType: null,
            },
            anchors: [{ id: 1, anchorText: "Fixture Project", targetUrl: `${baseUrl}/promoted` }],
            items: [item()],
          };
        else if (req.url === "/api/agent/batches/615/claim") {
          assert.deepEqual(JSON.parse(raw).itemIds, [1001]);
          state.claims += 1;
          value = {
            leaseId: 900,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            items: [item()],
          };
        } else if (req.url === "/api/agent/leases/900/heartbeat") {
          state.heartbeats += 1;
          value = { leaseId: 900, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() };
        } else if (req.url === "/api/agent/items/1001/result") {
          assert.equal(state.submissions, 1);
          assert.ok(state.publicReads > 0);
          assert.ok(state.anchorObserved);
          const report = JSON.parse(raw);
          assert.equal(report.status, "live");
          assert.equal(report.publicUrl, `${baseUrl}/directory/entry`);
          assert.equal(report.targetUrl, `${baseUrl}/promoted`);
          state.reports.push(report);
          value = { itemStatus: "executed", publishRecordId: 701 };
        } else if (req.url === "/api/agent/leases/900/release") {
          state.releases += 1;
        } else throw Error(`Unexpected fixture endpoint: ${req.url}`);
        await save();
        res.end(JSON.stringify(value));
        return;
      }
      if (req.url === "/directory/submit" && req.method === "POST") {
        assert.equal(state.claims, 1);
        assert.equal(state.submissions, 0);
        const fields = new URLSearchParams(raw);
        assert.equal(fields.get("name"), "Fixture Project");
        assert.equal(fields.get("url"), `${baseUrl}/promoted`);
        state.submissions += 1;
        await save();
        res.writeHead(303, { location: "/directory/entry" }).end();
        return;
      }
      res.setHeader("content-type", "text/html; charset=utf-8");
      if (req.url === "/directory/submit")
        res.end(
          '<!doctype html><html><body><h1>Fixture Directory</h1><form method="post"><label>Name<input name="name" required></label><label>Website URL<input name="url" type="url" required></label><button type="submit">Submit</button></form></body></html>',
        );
      else if (req.url === "/directory/entry") {
        assert.equal(state.submissions, 1);
        state.publicReads += 1;
        res.end(
          `<html><body><h1>Published</h1><a href="${baseUrl}/promoted">Fixture Project</a></body></html>`,
        );
      } else if (req.url === "/promoted") res.end("<h1>Fixture Project</h1>");
      else res.writeHead(404).end();
    } catch (error) {
      state.errors.push(String(error));
      await save();
      res.writeHead(500).end(String(error));
    }
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, state, close: () => new Promise((done) => server.close(done)) };
}
