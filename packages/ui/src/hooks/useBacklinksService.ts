import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BacklinksSettingsPatch, BacklinksSettingsSnapshot } from "@zcode/services";
import { useWorkspaceServicesResolution } from "@/hooks/useWorkspaceServices.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { createBacklinksConsoleStore } from "@/store/backlinksConsoleStore.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  createBacklinksPublisher,
  createBacklinksPublishRunRegistry,
  createBacklinksStopper,
} from "@/lib/backlinksPublish.js";

const REFRESH_INTERVAL_MS = 30_000;
const BACKLINKS_PLUGIN_ID = "backlinks@zcode-plugins-official";

export function useBacklinksService(options: {
  workspacePath: string | null;
  workspaceIdentity?: string;
  isDesktop: boolean;
  onPublished?: () => void;
  /** 设置页只读取配置，不创建后台批次轮询。 */
  pollBatches?: boolean;
}) {
  const target = useWorkspaceServicesResolution(
    options.workspacePath,
    undefined,
    options.workspaceIdentity,
  );
  const service = target.rpcReady ? target.services.backlinksService : undefined;
  const modelSelection = useModelSelectionServiceView(
    target.services.modelSelectionService,
    target.rpcReady,
  );
  const preferredModelSelection =
    modelSelection.state.status === "ready"
      ? modelSelection.state.view.preferredSelection
      : undefined;
  const [settings, setSettings] = useState<BacklinksSettingsSnapshot | null>(null);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const published = useRef(options.onPublished);
  published.current = options.onPublished;
  const scope = `${options.workspaceIdentity?.trim() || options.workspacePath || ""}:${target.remoteSessionId ?? ""}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const currentService = useRef(service);
  currentService.current = service;
  const currentTaskService = useRef(target.services.zcodeTaskService);
  currentTaskService.current = target.services.zcodeTaskService;

  const store = useMemo(() => {
    if (!service) return null;
    const registry = createBacklinksPublishRunRegistry(scope);
    return createBacklinksConsoleStore(
      service,
      createBacklinksPublisher({
        workspacePath: options.workspacePath ?? "",
        workspaceIdentity: options.workspaceIdentity,
        remoteSessionId: target.remoteSessionId ?? undefined,
        clientMode: options.isDesktop ? "desktop-continuous" : "web-remote-replayable",
        taskService: target.services.zcodeTaskService,
        modelSelection: preferredModelSelection,
        async prepare() {
          const result = await target.services.pluginManagementService.setPluginEnabled({
            workspacePath: options.workspacePath ?? "",
            workspaceIdentity: options.workspaceIdentity,
            remoteSessionId: target.remoteSessionId ?? undefined,
            pluginId: BACKLINKS_PLUGIN_ID,
            enabled: true,
            scope: "workspace",
          });
          if (!result.enabled) throw new Error("The Backlinks plugin could not be enabled.");
        },
        onAccepted(taskId, batchIds) {
          registry.bind(taskId, batchIds);
          // 同路径重连可能更换服务实例；旧宿主的 ACK 不能导航到新宿主的任务视图。
          if (
            !mounted.current ||
            currentScope.current !== scope ||
            currentService.current !== service ||
            currentTaskService.current !== target.services.zcodeTaskService ||
            !options.workspacePath
          )
            return;
          useZCodeSessionStore
            .getState()
            .setActiveTaskId(options.workspacePath, taskId, options.workspaceIdentity);
          published.current?.();
        },
      }),
      createBacklinksStopper({
        workspacePath: options.workspacePath ?? "",
        workspaceIdentity: options.workspaceIdentity,
        registry,
        taskService: target.services.zcodeTaskService,
      }),
    );
  }, [
    service,
    options.workspacePath,
    options.workspaceIdentity,
    options.isDesktop,
    target.remoteSessionId,
    target.services.zcodeTaskService,
    target.services.pluginManagementService,
    preferredModelSelection,
    scope,
  ]);

  useEffect(() => {
    mounted.current = true;
    const version = ++generation.current;
    setSettings(null);
    setSettingsError(null);
    setSaving(false);
    if (service) {
      void service.getSettings().then(
        (snapshot) => {
          if (generation.current === version) setSettings(snapshot);
        },
        (error: unknown) => {
          if (generation.current === version)
            setSettingsError(error instanceof Error ? error.message : String(error));
        },
      );
    }
    if (options.pollBatches !== false) void store?.getState().refresh();
    const timer =
      store && options.pollBatches !== false
        ? setInterval(() => {
            void store.getState().refresh();
          }, REFRESH_INTERVAL_MS)
        : undefined;
    return () => {
      mounted.current = false;
      generation.current += 1;
      if (timer) clearInterval(timer);
    };
  }, [service, store, options.pollBatches]);

  const saveSettings = useCallback(
    async (patch: BacklinksSettingsPatch): Promise<void> => {
      if (!service) return;
      const version = generation.current;
      setSaving(true);
      setSettingsError(null);
      try {
        const snapshot = await service.updateSettings(patch);
        if (version !== generation.current) return;
        setSettings(snapshot);
        if (options.pollBatches !== false) await store?.getState().refresh();
      } catch (error) {
        if (version === generation.current)
          setSettingsError(error instanceof Error ? error.message : String(error));
        throw error;
      } finally {
        if (version === generation.current) setSaving(false);
      }
    },
    [service, store, options.pollBatches],
  );

  return { store, settings, settingsError, saving, saveSettings, connecting: !target.rpcReady };
}
