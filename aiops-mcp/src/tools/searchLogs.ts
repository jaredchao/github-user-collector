import { listLogGroups } from "./logGroups.js";
import { logGroupFromLogField, MAX_LOG_GROUPS, runInsightsQuery } from "./insights.js";
import { cleanMessage } from "./tailLogs.js";

export type SearchEntry = Readonly<{
  timestamp: string;
  logGroup: string;
  message: string;
}>;

export type SearchLogsResult = Readonly<{
  logGroups: readonly string[];
  windowMinutes: number;
  pattern: string | null;
  entries: readonly SearchEntry[];
  /** 命中的日志组超过 Insights 单次上限时为 true，summary 会说明。 */
  truncatedGroups: boolean;
  summary: string;
}>;

/**
 * 跨任意日志组查日志。
 *
 * tail_logs 只认三个预设 target，够用于核心链路，但账号里还有别的东西——
 * 性能监控的摄取函数、清洗服务、原始上报组，还有 AIOps 自己的函数。它们
 * 出问题时，"没有对应的 target"不该等于"查不到"。
 *
 * logGroups 留空表示查全部：Insights 原生支持一次跨多个日志组，@log 字段
 * 会带回每条记录的来源，所以"全都查一遍"不是 N 次查询而是一次。
 *
 * pattern 留空则不过滤，返回窗口内最近的若干条——排查时经常需要先看看
 * "到底有没有东西在写"，而不是先假设错误长什么样。
 */
export const searchLogs = async (params: {
  readonly logGroups?: readonly string[];
  readonly pattern?: string;
  readonly minutes?: number;
  readonly limit?: number;
} = {}): Promise<SearchLogsResult> => {
  const minutes = params.minutes ?? 30;
  const limit = Math.min(params.limit ?? 20, 100);
  const pattern = params.pattern?.trim() || null;

  let targets = params.logGroups?.filter((g) => g.trim().length > 0) ?? [];
  if (targets.length === 0) {
    targets = (await listLogGroups()).groups.map((g) => g.name);
  }
  if (targets.length === 0) {
    return {
      logGroups: [],
      windowMinutes: minutes,
      pattern,
      entries: [],
      truncatedGroups: false,
      summary: "没有可查的日志组",
    };
  }

  // Insights 一次最多覆盖 50 个日志组。超出时截断而不是静默丢弃——被丢掉
  // 的那些恰恰可能是问题所在，Agent 必须知道自己没看全。
  const truncatedGroups = targets.length > MAX_LOG_GROUPS;
  const queried = targets.slice(0, MAX_LOG_GROUPS);

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - minutes * 60;

  const rows = await runInsightsQuery({
    logGroupNames: queried,
    startTime,
    endTime,
    limit,
    queryString: [
      "fields @timestamp, @message, @log",
      ...(pattern ? [`| filter @message like /${pattern}/`] : []),
      "| sort @timestamp desc",
      `| limit ${limit}`,
    ].join("\n"),
  });

  const entries: SearchEntry[] = rows.map((row) => ({
    timestamp: row["@timestamp"] ?? "",
    logGroup: logGroupFromLogField(row["@log"] ?? ""),
    message: cleanMessage(row["@message"] ?? ""),
  }));

  const scope =
    params.logGroups?.length ? `${queried.length} 个指定日志组` : `全部 ${queried.length} 个日志组`;
  const filter = pattern ? `匹配 /${pattern}/ 的` : "";
  const base =
    entries.length === 0
      ? `${scope}在过去 ${minutes} 分钟内没有${filter || "任何"}日志`
      : `${scope}在过去 ${minutes} 分钟内有 ${entries.length} 条${filter}记录，` +
        `最近一条在 ${entries[0]?.timestamp}（来自 ${entries[0]?.logGroup}）`;

  return {
    logGroups: Object.freeze(queried),
    windowMinutes: minutes,
    pattern,
    entries: Object.freeze(entries),
    truncatedGroups,
    summary: truncatedGroups
      ? `${base}。注意：日志组超过 ${MAX_LOG_GROUPS} 个，本次只查了前 ${MAX_LOG_GROUPS} 个`
      : base,
  };
};
