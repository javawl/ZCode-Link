// 页面生命周期的唯一所有者：逻辑页名 → 物理页面、条目绑定、人工保留与空闲池。
// 只保存进程内状态；批次、条目与发布结果的事实仍以后台为准。
import type { Page } from "playwright-core";

export const IDLE_PAGE_MS = 10 * 60_000;
export const REVEALED_IDLE_MS = 30 * 60_000;
export const HELD_PAGE_TTL_MS = 24 * 60 * 60_000;
export const BROWSER_IDLE_CLOSE_MS = 30 * 60_000;
export const MAX_IDLE_POOL = 3;

const ITEM_PAGE = /^batch-(\d{1,15})-item-(\d{1,15})(?:[-_/].*)?$/u;

export interface PageRecord {
  readonly name: string;
  readonly page: Page;
  readonly batchId?: number;
  readonly itemId?: number;
  /** 站点弹窗记录其打开者的逻辑页名，随打开者所属条目一起回收。 */
  readonly openerName?: string;
  lastUsedAt: number;
  held?: { reason: string; since: number };
  revealed?: boolean;
}

export function parseItemPage(name: string): { batchId: number; itemId: number } | undefined {
  const match = ITEM_PAGE.exec(name);
  if (!match) return undefined;
  const batchId = Number(match[1]);
  const itemId = Number(match[2]);
  return Number.isSafeInteger(batchId) && Number.isSafeInteger(itemId) && batchId > 0 && itemId > 0
    ? { batchId, itemId }
    : undefined;
}

export class PageRegistry {
  readonly #records = new Map<string, PageRecord>();
  readonly #byPage = new WeakMap<Page, PageRecord>();
  readonly #idle: Page[] = [];

  get size(): number {
    return this.#records.size;
  }

  get heldCount(): number {
    let count = 0;
    for (const record of this.#records.values()) if (record.held) count += 1;
    return count;
  }

  get revealedCount(): number {
    let count = 0;
    for (const record of this.#records.values()) if (record.revealed) count += 1;
    return count;
  }

  get(name: string): PageRecord | undefined {
    const record = this.#records.get(name);
    if (record?.page.isClosed()) {
      this.forget(record.page);
      return undefined;
    }
    return record;
  }

  recordFor(page: Page): PageRecord | undefined {
    return this.#byPage.get(page);
  }

  names(): string[] {
    return [...this.#records.keys()];
  }

  bind(name: string, page: Page, now: number, openerName?: string): PageRecord {
    const opener = openerName ? this.#records.get(openerName) : undefined;
    const item = parseItemPage(name) ?? (opener?.itemId ? opener : undefined);
    const record: PageRecord = {
      name,
      page,
      lastUsedAt: now,
      ...(item?.batchId ? { batchId: item.batchId } : {}),
      ...(item?.itemId ? { itemId: item.itemId } : {}),
      ...(openerName ? { openerName } : {}),
    };
    // 不变量：一个物理页面只有一个逻辑名。并发 tabs() 可能在创建期间先收养为 tab-<uuid>，
    // 显式请求的页名优先；残留别名会在之后被清扫回收，清空正在被另一个条目使用的页面。
    const previous = this.#byPage.get(page);
    if (previous && previous.name !== name && this.#records.get(previous.name) === previous)
      this.#records.delete(previous.name);
    this.#records.set(name, record);
    this.#byPage.set(page, record);
    this.#removeIdle(page);
    return record;
  }

  touch(name: string, now: number): void {
    const record = this.#records.get(name);
    if (record) record.lastUsedAt = now;
  }

  /** 自动保留（条目 manual_required）不覆盖已有原因；显式 hold 用更具体的原因替换，保留最初的保留时间。 */
  hold(name: string, reason: string, now: number, explicit = false): boolean {
    const record = this.#records.get(name);
    if (!record) return false;
    if (!record.held) record.held = { reason, since: now };
    else if (explicit) record.held = { reason, since: record.held.since };
    record.lastUsedAt = now;
    return true;
  }

  /** 解除逻辑页名；物理页面由调用方决定回池或关闭。 */
  release(name: string): PageRecord | undefined {
    const record = this.#records.get(name);
    if (!record) return undefined;
    this.#records.delete(name);
    if (this.#byPage.get(record.page) === record) this.#byPage.delete(record.page);
    return record;
  }

  /** 弹窗排在主页面之前：先关闭条目弹窗，再回收主页面。 */
  itemPages(itemId: number): PageRecord[] {
    const records = [...this.#records.values()].filter((record) => record.itemId === itemId);
    return records.sort(
      (left, right) => Number(Boolean(right.openerName)) - Number(Boolean(left.openerName)),
    );
  }

  /** 已关闭的物理页面（包括用户手动关闭的标签）从记录与空闲池中移除。 */
  forget(page: Page): void {
    const record = this.#byPage.get(page);
    if (record && this.#records.get(record.name) === record) this.#records.delete(record.name);
    this.#byPage.delete(page);
    this.#removeIdle(page);
  }

  takeIdle(): Page | undefined {
    while (this.#idle.length) {
      const page = this.#idle.shift()!;
      if (!page.isClosed()) return page;
    }
    return undefined;
  }

  /** 返回 false 表示池已满或页面仍有逻辑名，调用方应关闭该页；空闲池中的页面绝不带有逻辑名。 */
  addIdle(page: Page): boolean {
    if (page.isClosed() || this.#byPage.has(page)) return false;
    if (this.#idle.includes(page)) return true;
    if (this.#idle.length >= MAX_IDLE_POOL) return false;
    this.#idle.push(page);
    return true;
  }

  isIdle(page: Page): boolean {
    return this.#idle.includes(page);
  }

  expired(now: number): { idle: string[]; expiredHolds: string[] } {
    const idle: string[] = [];
    const expiredHolds: string[] = [];
    for (const record of this.#records.values()) {
      if (record.held) {
        if (now - record.held.since >= HELD_PAGE_TTL_MS) expiredHolds.push(record.name);
        continue;
      }
      // 弹窗继承打开链的保护：祖先仍被保留时随保留页一起释放；祖先已显示给用户时按显示页的空闲时间。
      // 用户在人工页面上的操作不会刷新 lastUsedAt，不能按 10 分钟空闲关闭用户正在使用的弹窗。
      const lineage = this.lineage(record);
      if (lineage.held) continue;
      const limit = lineage.revealed ? REVEALED_IDLE_MS : IDLE_PAGE_MS;
      if (now - record.lastUsedAt >= limit) idle.push(record.name);
    }
    return { idle, expiredHolds };
  }

  /** 沿 opener 链汇总保留/显示状态（含自身）。 */
  lineage(record: PageRecord): { held: boolean; revealed: boolean } {
    let held = false;
    let revealed = false;
    const seen = new Set<string>();
    for (
      let current: PageRecord | undefined = record;
      current && !seen.has(current.name);
      current = current.openerName ? this.#records.get(current.openerName) : undefined
    ) {
      seen.add(current.name);
      held ||= Boolean(current.held);
      revealed ||= Boolean(current.revealed);
    }
    return { held, revealed };
  }

  clear(): void {
    this.#records.clear();
    this.#idle.length = 0;
  }

  #removeIdle(page: Page): void {
    const index = this.#idle.indexOf(page);
    if (index >= 0) this.#idle.splice(index, 1);
  }
}
