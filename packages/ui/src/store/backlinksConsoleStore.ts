// Adapted from link-harness 2.0.0 ui-backlinks-console (MIT; see THIRD-PARTY-NOTICES.md).
import { createStore } from "zustand/vanilla";
import type { BacklinkBatchDetail, BacklinkBatchSummary } from "@zcode/services";

export interface BacklinksConsoleReader {
  listBatches(): Promise<readonly BacklinkBatchSummary[]>;
  getBatch(batchId: number): Promise<BacklinkBatchDetail>;
}

export interface BacklinksConsoleState {
  batches: readonly BacklinkBatchSummary[];
  selectedIds: readonly number[];
  expandedIds: readonly number[];
  loadingDetailIds: readonly number[];
  details: Record<number, BacklinkBatchDetail>;
  loading: boolean;
  publishing: boolean;
  error: string | null;
  refresh(): Promise<void>;
  select(ids: readonly number[], selected: boolean): void;
  toggleDetail(id: number): Promise<void>;
  publishSelected(): Promise<void>;
  publish(ids: readonly number[]): Promise<void>;
}

export function filterBacklinkBatches(
  batches: readonly BacklinkBatchSummary[],
  query: string,
): readonly BacklinkBatchSummary[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return batches;
  return batches.filter((batch) =>
    `${batch.websiteHost}\n${batch.websiteName}\n${batch.id}`.toLowerCase().includes(needle),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A view projection scoped to one host. Only the backend owns accepted batches and leases. */
export function createBacklinksConsoleStore(
  reader: BacklinksConsoleReader,
  publish: (ids: readonly number[]) => Promise<void>,
) {
  let refreshVersion = 0;
  const detailVersions = new Map<number, number>();
  return createStore<BacklinksConsoleState>((set, get) => ({
    batches: [],
    selectedIds: [],
    expandedIds: [],
    loadingDetailIds: [],
    details: {},
    loading: false,
    publishing: false,
    error: null,
    async refresh() {
      const version = ++refreshVersion;
      set({ loading: true });
      try {
        const batches = [...(await reader.listBatches())].sort((a, b) => b.id - a.id);
        if (version !== refreshVersion) return;
        const known = new Set(batches.map((batch) => batch.id));
        set((state) => ({
          batches,
          loading: false,
          error: null,
          selectedIds: state.selectedIds.filter((id) => known.has(id)),
          expandedIds: state.expandedIds.filter((id) => known.has(id)),
        }));
        // Expanded rows refresh through the same read-only endpoint; late reads cannot reopen rows.
        await Promise.all(
          get().expandedIds.map(async (id) => {
            const detailVersion = (detailVersions.get(id) ?? 0) + 1;
            detailVersions.set(id, detailVersion);
            const detail = await reader.getBatch(id);
            if (
              version === refreshVersion &&
              detailVersions.get(id) === detailVersion &&
              get().expandedIds.includes(id)
            ) {
              set((state) => ({ details: { ...state.details, [id]: detail } }));
            }
          }),
        );
      } catch (error) {
        if (version === refreshVersion) set({ loading: false, error: errorMessage(error) });
      }
    },
    select(ids, selected) {
      if (get().publishing) return;
      const known = new Set(get().batches.map((batch) => batch.id));
      const next = new Set(get().selectedIds);
      for (const id of ids) {
        if (selected && known.has(id)) next.add(id);
        else next.delete(id);
      }
      set({ selectedIds: [...next].sort((a, b) => b - a) });
    },
    async toggleDetail(id) {
      const version = (detailVersions.get(id) ?? 0) + 1;
      detailVersions.set(id, version);
      if (get().expandedIds.includes(id)) {
        set((state) => ({
          expandedIds: state.expandedIds.filter((value) => value !== id),
          loadingDetailIds: state.loadingDetailIds.filter((value) => value !== id),
        }));
        return;
      }
      set((state) => ({
        expandedIds: [...state.expandedIds, id],
        loadingDetailIds: [...state.loadingDetailIds, id],
      }));
      try {
        const detail = await reader.getBatch(id);
        if (detailVersions.get(id) !== version || !get().expandedIds.includes(id)) return;
        set((state) => ({ details: { ...state.details, [id]: detail } }));
      } catch (error) {
        if (detailVersions.get(id) === version) set({ error: errorMessage(error) });
      } finally {
        if (detailVersions.get(id) === version) {
          set((state) => ({
            loadingDetailIds: state.loadingDetailIds.filter((value) => value !== id),
          }));
        }
      }
    },
    async publishSelected() {
      await get().publish(get().selectedIds);
    },
    async publish(ids) {
      if (get().publishing || ids.length === 0) return;
      const known = new Set(get().batches.map((batch) => batch.id));
      const selected = [...new Set(ids)].filter((id) => known.has(id)).sort((a, b) => b - a);
      if (selected.length === 0) return;
      set({ publishing: true, error: null });
      try {
        await publish(selected);
        set((state) => ({ selectedIds: state.selectedIds.filter((id) => !selected.includes(id)) }));
      } catch (error) {
        set({ error: errorMessage(error) });
      } finally {
        set({ publishing: false });
      }
    },
  }));
}
