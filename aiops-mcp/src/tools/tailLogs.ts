import { topology } from "../config.js";
import { redact } from "../redact.js";
import { runInsightsQuery } from "./insights.js";

export type LogEntry = Readonly<{
  timestamp: string;
  message: string;
  requestId: string | null;
}>;

export type TailLogsResult = Readonly<{
  target: LogTarget;
  logGroup: string;
  windowMinutes: number;
  entries: readonly LogEntry[];
  summary: string;
}>;

export type LogTarget = "collector" | "worker" | "go-service";

const logGroupFor = (
  groups: Readonly<{ collector: string; worker: string; goService: string }>,
  target: LogTarget,
): string => (target === "go-service" ? groups.goService : groups[target]);

export const MAX_MESSAGE_CHARS = 600;

const DEFAULT_PATTERN = "ERROR|Error|error|Exception|Task timed out|failed";

/** 先脱敏再截断：反过来可能把一个密钥从中间切开，前半截照样泄露。 */
export const cleanMessage = (raw: string): string => {
  const message = redact(raw.trim());
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS)}...(已截断)`
    : message;
};

/**
 * 用 Logs Insights 捞最近的错误日志。
 *
 * 刻意不做"把原始日志全量倒给 Agent"这件事：那会瞬间撑爆上下文，
 * 而且大部分是噪音。这里只回最近若干条匹配错误模式的记录，每条
 * 还做了截断——Agent 需要的是线索，不是日志转储。
 *
 * 这是三个核心组件的快捷方式；要查任意日志组或跨日志组查，用 search_logs。
 */
export const tailLogs = async (
  target: LogTarget = "worker",
  minutes = 30,
  pattern: string = DEFAULT_PATTERN,
  limit = 20,
): Promise<TailLogsResult> => {
  const topo = await topology();
  const logGroup = logGroupFor(topo.logGroups, target);
  if (!logGroup) {
    throw new Error(
      target === "go-service"
        ? "没有发现 Go 服务的日志组——ECS 集群或服务不存在，或任务定义里没有配 awslogs"
        : `拓扑里没有 ${target} 的日志组——函数可能还没部署`,
    );
  }

  const endTime = Math.floor(Date.now() / 1000);
  const startTime = endTime - minutes * 60;
  const capped = Math.min(limit, 100);

  const rows = await runInsightsQuery({
    logGroupNames: [logGroup],
    startTime,
    endTime,
    limit: capped,
    queryString: [
      "fields @timestamp, @message, @requestId",
      `| filter @message like /${pattern}/`,
      "| sort @timestamp desc",
      `| limit ${capped}`,
    ].join("\n"),
  });

  const entries: LogEntry[] = rows.map((row) => ({
    timestamp: row["@timestamp"] ?? "",
    message: cleanMessage(row["@message"] ?? ""),
    requestId: row["@requestId"] || null,
  }));

  const summary =
    entries.length === 0
      ? `${logGroup} 在过去 ${minutes} 分钟内没有匹配 /${pattern}/ 的日志`
      : `${logGroup} 在过去 ${minutes} 分钟内有 ${entries.length} 条错误日志，` +
        `最近一条在 ${entries[0]?.timestamp}`;

  return {
    target,
    logGroup,
    windowMinutes: minutes,
    entries: Object.freeze(entries),
    summary,
  };
};
