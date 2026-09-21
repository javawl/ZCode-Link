import assert from "node:assert/strict";
import test from "node:test";
import { ProxyChannel, type IChannel, type IChannelClient, type IServerChannel } from "@zcode/rpc";
import { IBacklinksService, ServiceCollection } from "@zcode/services";
import { RemoteServiceAccess } from "../src/remoteServiceAccess.js";

test("remote access uses the registered backlinks channel for all four methods", async () => {
  const calls: Array<{ command: string; args: unknown[] }> = [];
  const channels = new Map<string, IServerChannel>();
  const failure = new Error("remote batch is unavailable");
  const upstream = {
    getSettings() {
      calls.push({ command: "getSettings", args: [] });
      return { owner: "remote-host" };
    },
    updateSettings(patch: unknown) {
      calls.push({ command: "updateSettings", args: [patch] });
      return { owner: "remote-host", patch };
    },
    listBatches() {
      calls.push({ command: "listBatches", args: [] });
      return [{ id: 12 }];
    },
    getBatch(id: number) {
      calls.push({ command: "getBatch", args: [id] });
      return Promise.reject(failure);
    },
  };
  channels.set(IBacklinksService.channelName, ProxyChannel.fromService(upstream));
  const requested: string[] = [];
  const client: IChannelClient = {
    getChannel<T extends IChannel>(name: string): T {
      requested.push(name);
      return {
        call(command: string, args: unknown[]) {
          const channel = channels.get(name);
          assert.ok(channel, `unexpected call to ${name}`);
          return channel.call("remote-host", command, args);
        },
        listen() {
          throw new Error("this service has no events");
        },
      } as T;
    },
  };
  const remote = new RemoteServiceAccess(client).backlinksService;
  const patch = { supermanager: { baseUrl: "https://remote.example" } };
  assert.ok(requested.includes("backlinks"));
  assert.deepEqual(await remote.getSettings(), { owner: "remote-host" });
  assert.deepEqual(await remote.updateSettings(patch), { owner: "remote-host", patch });
  assert.deepEqual(await remote.listBatches(), [{ id: 12 }]);
  await assert.rejects(remote.getBatch(12), (error) => error === failure);
  assert.deepEqual(calls, [
    { command: "getSettings", args: [] },
    { command: "updateSettings", args: [patch] },
    { command: "listBatches", args: [] },
    { command: "getBatch", args: [12] },
  ]);
  const collection = new ServiceCollection().register(IBacklinksService, remote);
  assert.equal(collection.get(IBacklinksService), remote);
});
