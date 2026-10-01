/** 按键串行执行：同一页面的动作、回收与关闭严格按提交顺序进行，不同页面互不阻塞。 */
export class KeyedSerialQueues {
  readonly #tails = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.#tails.size;
  }

  has(key: string): boolean {
    return this.#tails.has(key);
  }

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const operation = (this.#tails.get(key) ?? Promise.resolve()).then(task);
    const tail = operation.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, tail);
    void tail.then(() => {
      if (this.#tails.get(key) === tail) this.#tails.delete(key);
    });
    return operation;
  }
}
