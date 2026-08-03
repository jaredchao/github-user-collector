import { z } from "zod";

/** 只读工具的统一标注：可以放心重复调用，不会改变任何状态。 */
export const readOnly = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

/** 写工具的统一标注：会改变线上状态，客户端应当向人确认。 */
export const mutating = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
};

export const dryRunField = z
  .boolean()
  .default(true)
  .describe(
    "默认 true，只返回执行计划而不实际改动。确认计划无误后传 false 才会真正执行。",
  );
