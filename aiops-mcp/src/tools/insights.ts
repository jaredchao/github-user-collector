import {
  GetQueryResultsCommand,
  StartQueryCommand,
  type QueryStatus,
} from "@aws-sdk/client-cloudwatch-logs";
import { logs } from "../aws.js";

/** 一行查询结果，字段名到值的映射。 */
export type InsightsRow = Readonly<Record<string, string>>;

const POLL_INTERVAL_MS = 1000;
const MAX_POLLS = 30;

/** Logs Insights 单次查询能覆盖的日志组上限。 */
export const MAX_LOG_GROUPS = 50;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const isTerminal = (status?: QueryStatus | string): boolean =>
  status === "Complete" || status === "Failed" || status === "Cancelled";

/**
 * 跑一次 Logs Insights 查询并等它结束。
 *
 * Insights 是异步的：StartQuery 只拿到一个 ID，结果要轮询。这段逻辑被
 * tail_logs 和 search_logs 共用，抽出来是为了让两者的超时、错误处理和
 * 轮询节奏保持一致——查询语义可以不同，等待方式没有理由不同。
 */
export const runInsightsQuery = async (params: {
  readonly logGroupNames: readonly string[];
  readonly queryString: string;
  readonly startTime: number;
  readonly endTime: number;
  readonly limit: number;
}): Promise<readonly InsightsRow[]> => {
  if (params.logGroupNames.length === 0) return [];

  const started = await logs().send(
    new StartQueryCommand({
      logGroupNames: [...params.logGroupNames],
      startTime: params.startTime,
      endTime: params.endTime,
      limit: params.limit,
      queryString: params.queryString,
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
    throw new Error(
      `日志查询在 ${MAX_POLLS} 秒内没有完成，当前状态 ${results?.status}`,
    );
  }
  if (results.status !== "Complete") {
    throw new Error(`日志查询以状态 ${results.status} 结束`);
  }

  return (results.results ?? []).map((row) =>
    Object.freeze(
      Object.fromEntries(
        row.flatMap((f) => (f.field ? [[f.field, f.value ?? ""]] : [])),
      ),
    ),
  );
};

/**
 * 从 Insights 的 @log 字段里取出日志组名。
 *
 * 它的值是 "账号ID:日志组名"，跨日志组查询时这是唯一能分辨每条记录来自
 * 哪里的线索。日志组名本身可能含冒号，所以按第一个冒号切。
 */
export const logGroupFromLogField = (value: string): string => {
  const separator = value.indexOf(":");
  return separator === -1 ? value : value.slice(separator + 1);
};
