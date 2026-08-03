import { alarmTimeline, type AlarmTimelineResult } from "./alarmTimeline.js";
import { checkReady, type ReadinessResult } from "./checkReady.js";
import { deploymentState, type DeploymentStateResult } from "./deploymentState.js";
import { queueDepth, type QueueDepthResult } from "./dlqDepth.js";
import { listAlarms, type AlarmSnapshot } from "./listAlarms.js";
import { isDegradationSignal } from "./metricQueries.js";
import { getMetrics, type MetricsResult } from "./metrics.js";
import { triageMessage } from "./messageTriage.js";
import { tailLogs, type TailLogsResult } from "./tailLogs.js";

export type Diagnosis = Readonly<{
  firingAlarms: readonly string[];
  timelines: readonly AlarmTimelineResult[];
  deployment: DeploymentStateResult;
  readiness: ReadinessResult;
  queues: readonly QueueDepthResult[];
  logs: readonly TailLogsResult[];
  metrics: MetricsResult;
  /** 把不同来源的事实对起来之后看到的东西。 */
  correlations: readonly string[];
  assessment: Readonly<{
    healthyNow: boolean;
    likelyCauses: readonly string[];
    suggestedActions: readonly string[];
  }>;
  summary: string;
}>;

/** 告警起点与部署时间相差多少分钟以内算得上"相关"。 */
const DEPLOY_CORRELATION_WINDOW_MINUTES = 15;

const minutesBetween = (a: string, b: string): number =>
  Math.abs(Date.parse(a) - Date.parse(b)) / 60_000;

const isQueueAlarm = (alarm: AlarmSnapshot): boolean =>
  alarm.metric.startsWith("ApproximateNumberOfMessages") ||
  alarm.metric === "ApproximateAgeOfOldestMessage";

const isErrorOrLatencyAlarm = (alarm: AlarmSnapshot): boolean =>
  alarm.metric === "Errors" || alarm.metric === "Duration" || alarm.metric === "5xx";

/**
 * 跑一轮完整的故障诊断。
 *
 * 这个工具存在的理由是把一套 runbook 固化下来：先看谁在响，再定位故障起点，
 * 然后去问那个时刻附近发生过什么，最后按告警类型取对应的证据。
 *
 * 让 Agent 每次在对话里临时编排这套流程，它可能漏掉某一步、也可能顺序颠倒；
 * 固化成工具之后，"多维度关联"就成了一种能力，而不是一次运气。
 *
 * 它刻意不下最终结论——只把证据和关联摆出来，判断留给 Agent。但那些纯靠
 * 时间算术就能得出的关联（告警比部署晚两分钟），必须由代码算，因为 Agent
 * 做时间算术并不可靠。
 */
export const diagnose = async (minutes = 60): Promise<Diagnosis> => {
  const alarms = await listAlarms();
  const firing = alarms.alarms.filter((a) => a.state === "ALARM");

  const [deployment, readiness, metrics] = await Promise.all([
    deploymentState("live"),
    checkReady(),
    getMetrics(["lambda", "api", "queue"], minutes),
  ]);

  const timelines = await Promise.all(
    firing.map((alarm) => alarmTimeline(alarm.name, Math.max(24, minutes / 60))),
  );

  // 按告警类型决定取哪些证据，不是无差别地把所有数据都捞一遍
  const needQueues = firing.some(isQueueAlarm);
  const needLogs = firing.length === 0 || firing.some(isErrorOrLatencyAlarm);

  const [queues, logs] = await Promise.all([
    needQueues
      ? Promise.all([queueDepth("dead-letter", 3), queueDepth("main")])
      : Promise.resolve([]),
    needLogs
      ? Promise.all([tailLogs("worker", minutes), tailLogs("collector", minutes)])
      : Promise.resolve([]),
  ]);

  const correlations: string[] = [];
  const likelyCauses: string[] = [];
  const suggestedActions: string[] = [];

  // 关联一：告警起点是否紧跟在某次发布之后
  const deployedAt = deployment.versions[0]?.lastModified;
  for (const timeline of timelines) {
    if (!timeline.enteredAlarmAt || !deployedAt) continue;
    const gap = minutesBetween(timeline.enteredAlarmAt, deployedAt);
    if (gap <= DEPLOY_CORRELATION_WINDOW_MINUTES) {
      correlations.push(
        `${timeline.alarmName} 进入 ALARM 的时刻与版本 ${deployment.versions[0]?.version} 的发布时间相差 ${Math.round(gap)} 分钟，高度相关`,
      );
      likelyCauses.push(`版本 ${deployment.versions[0]?.version} 引入的问题`);
      suggestedActions.push("用 rollback_canary 回滚到上一个稳定版本");
    } else {
      correlations.push(
        `${timeline.alarmName} 进入 ALARM 的时刻与最近一次发布相差 ${Math.round(gap / 60)} 小时，与发布无关`,
      );
    }
  }

  // 关联二：告警还在响，但系统此刻是好的——典型的陈旧告警
  const deadLetter = queues.find((q) => q.queue === "dead-letter");
  const noFreshErrors = logs.every((log) => log.entries.length === 0);
  if (firing.length > 0 && readiness.ok && noFreshErrors) {
    correlations.push(
      "告警仍在触发，但就绪检查通过且窗口内没有新的错误日志——故障可能已经过去，告警是陈旧的",
    );
  }

  // 关联三：死信队列里是什么货色，决定了处置方式完全不同
  if (deadLetter && deadLetter.visible > 0) {
    const triaged = deadLetter.sample.map((m) => triageMessage(m.body));
    const poison = triaged.filter((t) => !t.replayable).length;
    const age = deadLetter.oldestEnqueuedAgeSeconds;

    if (poison > 0 && poison === triaged.length) {
      correlations.push(
        `死信队列里的 ${poison} 条样本全部格式非法，重放必然再次失败——这是数据问题，不是系统故障`,
      );
      likelyCauses.push("上游投递了格式非法的消息（毒丸消息）");
      suggestedActions.push("用 discard_dlq_messages 归档后丢弃，不要重放");
    } else if (triaged.length > 0) {
      correlations.push(
        `死信队列里有 ${triaged.length - poison} 条格式合法的消息，多半是下游当时不可用导致重试耗尽`,
      );
      suggestedActions.push("确认下游已恢复后用 redrive_dlq 重放");
    }

    if (age !== null && age > 3600) {
      correlations.push(
        `最老的死信消息已入队 ${Math.floor(age / 3600)} 小时，说明没人处理过它`,
      );
    }
  }

  // 关联四：指标在恶化——告警还没响，但方向不对。
  // 只看错误类和延迟类：流量上升是中性的，积压类指标天然单调增长。
  const rising = metrics.metrics.filter(
    (m) => m.trend === "rising" && isDegradationSignal(m.kind) && (m.latest ?? 0) > 0,
  );
  if (rising.length > 0) {
    correlations.push(
      `以下指标正在上升，即使尚未触发告警也值得注意: ${rising.map((m) => m.label).join("，")}`,
    );
  }

  if (!readiness.ok) {
    likelyCauses.push("链路中有组件当前不可用");
    suggestedActions.push("先看 check_ready 的返回体判断断在哪一层");
  }

  const healthyNow = readiness.ok && noFreshErrors;
  const summary =
    firing.length === 0
      ? `没有告警在触发。${readiness.summary}`
      : `${firing.length} 个告警正在触发（${firing.map((a) => a.name).join("、")}）。` +
        (healthyNow
          ? "但系统此刻是健康的，重点看告警是否陈旧。"
          : "系统当前存在问题。") +
        (correlations.length > 0 ? `发现 ${correlations.length} 条关联。` : "");

  return {
    firingAlarms: Object.freeze(firing.map((a) => a.name)),
    timelines: Object.freeze(timelines),
    deployment,
    readiness,
    queues: Object.freeze(queues),
    logs: Object.freeze(logs),
    metrics,
    correlations: Object.freeze(correlations),
    assessment: Object.freeze({
      healthyNow,
      likelyCauses: Object.freeze([...new Set(likelyCauses)]),
      suggestedActions: Object.freeze([...new Set(suggestedActions)]),
    }),
    summary,
  };
};
