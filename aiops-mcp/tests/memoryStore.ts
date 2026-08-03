import type { RestorePoint, RestoreStore } from "../src/restore/types.js";

/** 测试用的还原点存储，顺便记录写入顺序以便断言"备份先于变更"。 */
export class MemoryRestoreStore implements RestoreStore {
  readonly saved: RestorePoint[] = [];

  async save(point: RestorePoint): Promise<void> {
    const index = this.saved.findIndex((p) => p.id === point.id);
    if (index >= 0) this.saved[index] = point;
    else this.saved.push(point);
  }

  async load(id: string): Promise<RestorePoint | null> {
    return this.saved.find((p) => p.id === id) ?? null;
  }

  async list(limit: number): Promise<readonly RestorePoint[]> {
    return [...this.saved].reverse().slice(0, limit);
  }

  async markRestored(id: string, at: string): Promise<void> {
    const point = await this.load(id);
    if (!point) throw new Error(`还原点 ${id} 不存在`);
    await this.save({ ...point, restoredAt: at });
  }
}
