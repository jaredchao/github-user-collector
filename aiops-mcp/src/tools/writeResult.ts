/** 所有写工具的统一返回形状。 */
export type WriteResult = Readonly<{
  /** true 表示这次只是演练，什么都没改。 */
  dryRun: boolean;
  executed: boolean;
  /** 会做什么/做了什么。 */
  plan: string;
  /** 还原点 ID，演练时为 null。 */
  restorePointId: string | null;
  /** 怎么撤销这次操作——写在返回值里，出事时不用翻文档。 */
  undoHint: string;
  summary: string;
  details?: unknown;
}>;

/**
 * 演练结果。
 *
 * 措辞刻意写得不容误解：Agent 必须清楚地知道什么都还没发生，
 * 否则它会拿着演练结果去向人汇报“已处置完成”。
 */
export const dryRunResult = (plan: string, details?: unknown): WriteResult => ({
  dryRun: true,
  executed: false,
  plan,
  restorePointId: null,
  undoHint: "本次是演练，无需撤销",
  summary: `演练，未实际执行。计划: ${plan}。确认无误后带 dryRun=false 重新调用。`,
  details,
});

export const executedResult = (input: {
  plan: string;
  restorePointId: string;
  summary: string;
  details?: unknown;
}): WriteResult => ({
  dryRun: false,
  executed: true,
  plan: input.plan,
  restorePointId: input.restorePointId,
  undoHint: `调用 restore 工具并传入 restorePointId="${input.restorePointId}" 即可撤销`,
  summary: input.summary,
  details: input.details,
});
