import type { MetricDataQuery } from "@aws-sdk/client-cloudwatch";
import type { Topology } from "../config.js";

export type MetricScope = "lambda" | "api" | "queue" | "ecs";

export type MetricSpec = Readonly<{
  id: string;
  label: string;
  namespace: string;
  metricName: string;
  stat: string;
  dimensions: Readonly<Record<string, string>>;
}>;

/** 从 API 地址里取出 API ID：https://kp6eccqn9h.execute-api... -> kp6eccqn9h */
export const apiIdOf = (apiUrl: string): string => {
  try {
    return new URL(apiUrl).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
};

/** 队列名是队列地址的最后一段。 */
export const queueNameOf = (queueUrl: string): string =>
  queueUrl.split("/").filter(Boolean).pop() ?? "";

const lambdaSpecs = (topo: Topology): MetricSpec[] =>
  (
    [
      ["collector", topo.functionName],
      ["worker", topo.workerFunctionName],
    ] as const
  )
    .filter(([, name]) => Boolean(name))
    .flatMap(([role, name]) => [
      {
        id: `${role}_errors`,
        label: `${role} 错误数`,
        namespace: "AWS/Lambda",
        metricName: "Errors",
        stat: "Sum",
        dimensions: { FunctionName: name },
      },
      {
        id: `${role}_invocations`,
        label: `${role} 调用次数`,
        namespace: "AWS/Lambda",
        metricName: "Invocations",
        stat: "Sum",
        dimensions: { FunctionName: name },
      },
      {
        id: `${role}_duration`,
        label: `${role} 耗时 p95(ms)`,
        namespace: "AWS/Lambda",
        metricName: "Duration",
        stat: "p95",
        dimensions: { FunctionName: name },
      },
      {
        id: `${role}_throttles`,
        label: `${role} 被限流次数`,
        namespace: "AWS/Lambda",
        metricName: "Throttles",
        stat: "Sum",
        dimensions: { FunctionName: name },
      },
    ]);

const apiSpecs = (topo: Topology): MetricSpec[] => {
  const apiId = apiIdOf(topo.apiUrl);
  if (!apiId) return [];
  const dimensions = { ApiId: apiId };
  return [
    {
      id: "api_count",
      label: "API 请求数",
      namespace: "AWS/ApiGateway",
      metricName: "Count",
      stat: "Sum",
      dimensions,
    },
    {
      id: "api_5xx",
      label: "API 5xx 数",
      namespace: "AWS/ApiGateway",
      metricName: "5xx",
      stat: "Sum",
      dimensions,
    },
    {
      id: "api_4xx",
      label: "API 4xx 数",
      namespace: "AWS/ApiGateway",
      metricName: "4xx",
      stat: "Sum",
      dimensions,
    },
    {
      id: "api_latency",
      label: "API 延迟 p95(ms)",
      namespace: "AWS/ApiGateway",
      metricName: "Latency",
      stat: "p95",
      dimensions,
    },
  ];
};

const queueSpecs = (topo: Topology): MetricSpec[] =>
  (
    [
      ["main", queueNameOf(topo.introductionQueueUrl)],
      ["dlq", queueNameOf(topo.deadLetterQueueUrl)],
    ] as const
  )
    .filter(([, name]) => Boolean(name))
    .flatMap(([role, name]) => [
      {
        // 这个指标只有 CloudWatch 有，GetQueueAttributes 根本不返回它。
        // 但要当心它的语义：度量的是消息**当前可见**的时长，消息每次被接收后
        // 重新可见就重置。想知道消息真正卡了多久，得看它的 SentTimestamp。
        id: `${role}_age`,
        label: `${role} 最老消息可见时长(秒)`,
        namespace: "AWS/SQS",
        metricName: "ApproximateAgeOfOldestMessage",
        stat: "Maximum",
        dimensions: { QueueName: name },
      },
      {
        id: `${role}_visible`,
        label: `${role} 可见消息数`,
        namespace: "AWS/SQS",
        metricName: "ApproximateNumberOfMessagesVisible",
        stat: "Maximum",
        dimensions: { QueueName: name },
      },
    ]);

const ecsSpecs = (): MetricSpec[] => {
  const cluster = process.env.AIOPS_ECS_CLUSTER ?? "zuoye-cluster";
  const service = process.env.AIOPS_ECS_SERVICE_NAME ?? "zuoye-go-service-service";
  const dimensions = { ClusterName: cluster, ServiceName: service };
  return [
    {
      id: "ecs_cpu",
      label: "Go 服务 CPU(%)",
      namespace: "AWS/ECS",
      metricName: "CPUUtilization",
      stat: "Average",
      dimensions,
    },
    {
      id: "ecs_memory",
      label: "Go 服务内存(%)",
      namespace: "AWS/ECS",
      metricName: "MemoryUtilization",
      stat: "Average",
      dimensions,
    },
  ];
};

export const specsFor = (topo: Topology, scopes: readonly MetricScope[]): MetricSpec[] =>
  scopes.flatMap((scope) => {
    switch (scope) {
      case "lambda":
        return lambdaSpecs(topo);
      case "api":
        return apiSpecs(topo);
      case "queue":
        return queueSpecs(topo);
      case "ecs":
        return ecsSpecs();
    }
  });

export const toQuery = (spec: MetricSpec, period: number): MetricDataQuery => ({
  Id: spec.id,
  MetricStat: {
    Metric: {
      Namespace: spec.namespace,
      MetricName: spec.metricName,
      Dimensions: Object.entries(spec.dimensions).map(([Name, Value]) => ({
        Name,
        Value,
      })),
    },
    Period: period,
    Stat: spec.stat,
  },
  ReturnData: true,
});

/**
 * 按窗口长度选采样周期，目标是二十来个数据点。
 *
 * 点太少看不出趋势，点太多既费上下文又没有额外信息。CloudWatch 要求
 * 周期是 60 的倍数。
 */
export const periodFor = (minutes: number): number => {
  const raw = Math.round((minutes * 60) / 20 / 60) * 60;
  return Math.min(Math.max(raw, 60), 3600);
};
