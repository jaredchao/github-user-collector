import { GetMetricDataCommand } from "@aws-sdk/client-cloudwatch";
import { cloudwatch } from "../aws.js";
import { topology } from "../config.js";
import {
  isDegradationSignal,
  periodFor,
  specsFor,
  toQuery,
  type MetricKind,
  type MetricScope,
  type MetricSpec,
} from "./metricQueries.js";

export type Trend = "rising" | "falling" | "flat" | "unknown";

export type MetricSummary = Readonly<{
  label: string;
  /** 决定"上升"该怎么解读，见 MetricKind 的说明。 */
  kind: MetricKind;
  metricName: string;
  stat: string;
  latest: number | null;
  average: number | null;
  max: number | null;
  trend: Trend;
  /** 有数据点才有意义；为 0 说明这个指标在窗口内一个点都没有。 */
  dataPoints: number;
}>;

export type MetricsResult = Readonly<{
  windowMinutes: number;
  periodSeconds: number;
  metrics: readonly MetricSummary[];
  summary: string;
}>;

/** GetMetricData 单次请求最多 500 条查询，超限会整体拒绝。 */
const MAX_QUERIES_PER_CALL = 500;

const round = (value: number): number => Math.round(value * 100) / 100;

/**
 * 比较窗口前后两半的均值来判断趋势。
 *
 * 这是这个工具存在的理由：告警只告诉你"越没越过阈值"，是个二值信号。
 * 错误率从 0.1% 涨到 1.9%（阈值 2%）时告警全绿，但系统已经在恶化。
 */
const trendOf = (values: readonly number[]): Trend => {
  if (values.length < 4) return "unknown";
  const middle = Math.floor(values.length / 2);
  const mean = (slice: readonly number[]) =>
    slice.reduce((sum, v) => sum + v, 0) / slice.length;

  const earlier = mean(values.slice(0, middle));
  const later = mean(values.slice(middle));

  if (earlier === 0 && later === 0) return "flat";
  // 从零涨起来没法算比例，但它恰恰是最值得报告的情况
  if (earlier === 0) return later > 0 ? "rising" : "flat";

  const change = (later - earlier) / earlier;
  if (change > 0.2) return "rising";
  if (change < -0.2) return "falling";
  return "flat";
};

const chunk = <T>(items: readonly T[], size: number): T[][] => {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    batches.push(items.slice(i, i + size));
  }
  return batches;
};

const summarize = (spec: MetricSpec, values: readonly number[]): MetricSummary => ({
  label: spec.label,
  kind: spec.kind,
  metricName: spec.metricName,
  stat: spec.stat,
  // CloudWatch 按时间升序返回，最后一个才是最新的
  latest: values.length > 0 ? round(values[values.length - 1] as number) : null,
  average:
    values.length > 0
      ? round(values.reduce((sum, v) => sum + v, 0) / values.length)
      : null,
  max: values.length > 0 ? round(Math.max(...values)) : null,
  trend: trendOf(values),
  dataPoints: values.length,
});

const describe = (metrics: readonly MetricSummary[]): string => {
  const withData = metrics.filter((m) => m.dataPoints > 0);
  if (withData.length === 0) {
    return "窗口内所有指标都没有数据点——可能是没有流量，也可能是维度取值不对";
  }

  // 只有错误类和延迟类的上升才是恶化。流量上升是中性的，而积压类指标
  // 天然单调增长——队列非空时"最老消息可见时长"每秒都在涨，报它毫无意义。
  const rising = withData.filter(
    (m) => m.trend === "rising" && isDegradationSignal(m.kind) && (m.latest ?? 0) > 0,
  );
  const notable = withData.filter(
    (m) => (m.kind === "error" || m.kind === "backlog") && (m.max ?? 0) > 0,
  );

  const parts = [`${withData.length} 个指标有数据`];
  if (notable.length > 0) {
    parts.push(
      `值得注意: ${notable.map((m) => `${m.label} 峰值 ${m.max}`).join("，")}`,
    );
  }
  if (rising.length > 0) {
    parts.push(`正在上升: ${rising.map((m) => m.label).join("，")}`);
  }
  if (notable.length === 0 && rising.length === 0) {
    parts.push("没有异常指标，也没有明显上升趋势");
  }
  return parts.join("；");
};

/**
 * 取某个队列里最老消息的年龄。
 *
 * ApproximateAgeOfOldestMessage 不是 SQS 的队列属性，而是 CloudWatch 指标。
 * 只调 GetQueueAttributes 拿不到它，也就分不清"刚进来几条"和"卡了两小时"。
 *
 * 取不到时返回 null 而不是 0——0 会被读成"队列很新"，那是一句谎话。
 */
export const queueOldestMessageAge = async (
  queueUrl: string,
): Promise<number | null> => {
  const queueName = queueUrl.split("/").filter(Boolean).pop();
  if (!queueName) return null;

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 15 * 60_000);

  try {
    const page = await cloudwatch().send(
      new GetMetricDataCommand({
        MetricDataQueries: [
          {
            Id: "age",
            MetricStat: {
              Metric: {
                Namespace: "AWS/SQS",
                MetricName: "ApproximateAgeOfOldestMessage",
                Dimensions: [{ Name: "QueueName", Value: queueName }],
              },
              Period: 60,
              Stat: "Maximum",
            },
            ReturnData: true,
          },
        ],
        StartTime: startTime,
        EndTime: endTime,
      }),
    );

    // 按时间倒序返回，第一个就是最新的
    const latest = page.MetricDataResults?.[0]?.Values?.[0];
    return typeof latest === "number" ? Math.round(latest) : null;
  } catch {
    return null;
  }
};

/**
 * 取关键指标的趋势摘要。
 *
 * 刻意不回原始时间序列：二十个数据点乘以十几个指标就是几百个数字，
 * 对 Agent 是纯噪音。这里只回最新值、均值、峰值和趋势方向。
 */
export const getMetrics = async (
  scopes: readonly MetricScope[] = ["lambda", "api", "queue"],
  minutes = 60,
): Promise<MetricsResult> => {
  const topo = await topology();
  const specs = specsFor(topo, scopes);
  const period = periodFor(minutes);

  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - minutes * 60_000);

  const collected = new Map<string, number[]>();

  for (const batch of chunk(specs, MAX_QUERIES_PER_CALL)) {
    let token: string | undefined;
    do {
      const page = await cloudwatch().send(
        new GetMetricDataCommand({
          MetricDataQueries: batch.map((spec) => toQuery(spec, period)),
          StartTime: startTime,
          EndTime: endTime,
          NextToken: token,
        }),
      );

      for (const result of page.MetricDataResults ?? []) {
        if (!result.Id) continue;
        const existing = collected.get(result.Id) ?? [];
        collected.set(result.Id, [...existing, ...(result.Values ?? [])]);
      }
      token = page.NextToken;
    } while (token);
  }

  // CloudWatch 默认按时间倒序返回值，反转成升序才能算趋势
  const metrics = specs.map((spec) =>
    summarize(spec, [...(collected.get(spec.id) ?? [])].reverse()),
  );

  return {
    windowMinutes: minutes,
    periodSeconds: period,
    metrics: Object.freeze(metrics),
    summary: describe(metrics),
  };
};
