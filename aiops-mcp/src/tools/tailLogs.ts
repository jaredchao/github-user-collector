import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type QueryStatus,
} from "@aws-sdk/client-cloudwatch-logs";
import { logs } from "../aws.js";
import { topology } from "../config.js";

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

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 30;
const MAX_MESSAGE_CHARS = 600;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_PATTERN = "ERROR|Error|error|Exception|Task timed out|failed";

const isTerminal = (status?: QueryStatus | string): boolean =>
  status === "Complete" || status === "Failed" || status === "Cancelled";

/**
 * 用 Logs Insights 捞最近的错误日志。
 *
 * 刻意不做"把原始日志全量倒给 Agent"这件事：那会瞬间撑爆上下文，
 * 而且大部分是噪音。这里只回最近若干条匹配错误模式的记录，每条
 * 还做了截断——Agent 需要的是线索，不是日志转储。
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

  const started = await logs().send(
    new StartQueryCommand({
      logGroupNames: [logGroup],
      startTime,
      endTime,
      limit: Math.min(limit, 100),
      queryString: [
        "fields @timestamp, @message, @requestId",
        `| filter @message like /${pattern}/`,
        "| sort @timestamp desc",
        `| limit ${Math.min(limit, 100)}`,
      ].join("\n"),
    }),
  );

  const queryId = started.queryId;
  if (!queryId) throw new Error("Logs Insights 没有返回查询 ID");

  let results;
  for (let attempt = 0; attempt < MAX_POLLS; attempt += 1) {
    await sleep(POLL_INTERVAL_MS);
    results = await logs().send(new GetQueryResultsCommand({ queryId }));
    if (isTerminal(results.status)) break;
  }

  if (!results || !isTerminal(results.status)) {
    throw new Error(`日志查询在 ${MAX_POLLS} 秒内没有完成，当前状态 ${results?.status}`);
  }
  if (results.status !== "Complete") {
    throw new Error(`日志查询以状态 ${results.status} 结束`);
  }

  const entries: LogEntry[] = (results.results ?? []).map((row) => {
    const field = (name: string) => row.find((f) => f.field === name)?.value ?? "";
    const message = field("@message").trim();
    return {
      timestamp: field("@timestamp"),
      message:
        message.length > MAX_MESSAGE_CHARS
          ? `${message.slice(0, MAX_MESSAGE_CHARS)}...(已截断)`
          : message,
      requestId: field("@requestId") || null,
    };
  });

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
