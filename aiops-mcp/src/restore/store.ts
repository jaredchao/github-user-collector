import { randomBytes } from "node:crypto";
import { FileRestoreStore } from "./fileStore.js";
import type { RestorableOperation, RestorePoint, RestoreStore } from "./types.js";

let store: RestoreStore | undefined;

export const restoreStore = (): RestoreStore => (store ??= new FileRestoreStore());

/** 仅供测试注入内存实现。 */
export const setRestoreStore = (replacement: RestoreStore | undefined): void => {
  store = replacement;
};

const newId = (): string => {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
  return `rp-${stamp}-${randomBytes(3).toString("hex")}`;
};

/**
 * 先把要被覆盖的状态存下来，再返回还原点。
 *
 * 每个写工具的第一步都必须是它。备份失败就让整个操作失败——
 * 宁可什么都没做，也不要做了一件无法撤销的事。
 */
export const createRestorePoint = async (input: {
  operation: RestorableOperation;
  target: string;
  description: string;
  payload: unknown;
}): Promise<RestorePoint> => {
  const point: RestorePoint = {
    id: newId(),
    createdAt: new Date().toISOString(),
    operation: input.operation,
    target: input.target,
    description: input.description,
    payload: input.payload,
  };

  await restoreStore().save(point);
  return point;
};
