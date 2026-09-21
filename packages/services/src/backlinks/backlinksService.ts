import { createBacklinksRuntime } from "@zcode/backlinks/node";
import { getDataBaseDir } from "../paths.js";
import type { IBacklinksService } from "./contract.js";

export interface CreateBacklinksServiceOptions {
  /** 测试或宿主可注入相同公开接口；配置与批次仍只由核心持有。 */
  runtime?: IBacklinksService;
}

export function createBacklinksService(
  options: CreateBacklinksServiceOptions = {},
): IBacklinksService {
  const runtime = options.runtime ?? createBacklinksRuntime({ dataBaseDir: getDataBaseDir() });
  return {
    getSettings: () => runtime.getSettings(),
    updateSettings: (patch) => runtime.updateSettings(patch),
    listBatches: () => runtime.listBatches(),
    getBatch: (batchId) => runtime.getBatch(batchId),
  };
}
