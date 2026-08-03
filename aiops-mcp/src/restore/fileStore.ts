import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RestorePoint, RestoreStore } from "./types.js";

/**
 * 把还原点落成本地 JSON 文件。
 *
 * 刻意选了最笨的存储：写操作的备份必须在最坏情况下也能读出来。
 * 如果备份本身依赖一个可能同时出故障的云服务，那它在最需要的时刻
 * 恰好不可用。文件就在本地磁盘上，出事时 cat 一下就能看见。
 */
export class FileRestoreStore implements RestoreStore {
  private readonly directory: string;

  constructor(directory?: string) {
    this.directory = resolve(
      directory ??
        process.env.AIOPS_RESTORE_DIR ??
        join(process.cwd(), "aiops-mcp", "restore-points"),
    );
  }

  private pathOf(id: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(id)) {
      throw new Error(`还原点 ID 含非法字符: ${id}`);
    }
    return join(this.directory, `${id}.json`);
  }

  async save(point: RestorePoint): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    await writeFile(this.pathOf(point.id), JSON.stringify(point, null, 2), "utf8");
  }

  async load(id: string): Promise<RestorePoint | null> {
    try {
      const raw = await readFile(this.pathOf(id), "utf8");
      return JSON.parse(raw) as RestorePoint;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(limit: number): Promise<readonly RestorePoint[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    const points: RestorePoint[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const point = await this.load(name.replace(/\.json$/, ""));
      if (point) points.push(point);
    }

    return points
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }

  async markRestored(id: string, at: string): Promise<void> {
    const point = await this.load(id);
    if (!point) throw new Error(`还原点 ${id} 不存在`);
    await this.save({ ...point, restoredAt: at });
  }

  /** 备份落在哪里——出事时要能直接告诉人去哪个目录找。 */
  get location(): string {
    return this.directory;
  }
}
