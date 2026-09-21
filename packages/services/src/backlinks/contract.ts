import type {
  BacklinkBatchDetail,
  BacklinkBatchSummary,
  BacklinksSettingsPatch,
  BacklinksSettingsSnapshot,
} from "@zcode/backlinks";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/** 外链设置与批次查询。发布和租约操作由正常 Agent 会话中的官方插件负责。 */
export interface IBacklinksService {
  getSettings(): Promise<BacklinksSettingsSnapshot>;
  updateSettings(patch: BacklinksSettingsPatch): Promise<BacklinksSettingsSnapshot>;
  listBatches(): Promise<readonly BacklinkBatchSummary[]>;
  getBatch(batchId: number): Promise<BacklinkBatchDetail>;
}

export const IBacklinksService = createServiceDescriptor<IBacklinksService>(
  ServiceChannels.Backlinks,
);

export type {
  BacklinkBatchDetail,
  BacklinkBatchSummary,
  BacklinksSettingsPatch,
  BacklinksSettingsSnapshot,
};
