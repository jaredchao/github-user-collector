import {
  CloudFormationClient,
  DescribeStacksCommand,
  ListStackResourcesCommand,
  type StackResourceSummary,
} from "@aws-sdk/client-cloudformation";
import { discoverGoServiceLogGroup } from "./ecsDiscovery.js";

/**
 * 被运维系统的资源坐标。
 *
 * 一律从 CloudFormation 栈里发现，不写死任何 ARN——栈重建、换区域、
 * 或者指向某个 pr-N 环境时，改一个环境变量就够了，代码不用动。
 */
export type Topology = Readonly<{
  region: string;
  stackName: string;
  functionName: string;
  workerFunctionName: string;
  apiUrl: string;
  readinessUrl: string;
  introductionQueueUrl: string;
  deadLetterQueueUrl: string;
  alertsTopicArn: string;
  alarmNames: readonly string[];
  /** goService 可能为空——Go 服务不在本栈里，发现失败时优雅降级。 */
  logGroups: Readonly<{ collector: string; worker: string; goService: string }>;
}>;

export const region = (): string =>
  process.env.AIOPS_REGION ?? process.env.AWS_REGION ?? "us-east-2";

export const stackName = (): string =>
  process.env.AIOPS_STACK_NAME ?? "zuoye-collector";

const outputsOf = (stack: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }) =>
  Object.fromEntries(
    (stack.Outputs ?? [])
      .filter((o) => o.OutputKey && o.OutputValue)
      .map((o) => [o.OutputKey as string, o.OutputValue as string]),
  );

const require_ = (outputs: Record<string, string>, key: string): string => {
  const value = outputs[key];
  if (!value) {
    throw new Error(
      `栈 ${stackName()} 缺少输出 ${key}——请确认 AIOPS_STACK_NAME 指向的是采集器栈`,
    );
  }
  return value;
};

const discover = async (): Promise<Topology> => {
  const cfn = new CloudFormationClient({ region: region() });
  const name = stackName();

  const described = await cfn.send(new DescribeStacksCommand({ StackName: name }));
  const stack = described.Stacks?.[0];
  if (!stack) throw new Error(`找不到 CloudFormation 栈 ${name}`);
  const outputs = outputsOf(stack);

  const resources: StackResourceSummary[] = [];
  let token: string | undefined;
  do {
    const page = await cfn.send(
      new ListStackResourcesCommand({ StackName: name, NextToken: token }),
    );
    resources.push(...(page.StackResourceSummaries ?? []));
    token = page.NextToken;
  } while (token);

  const physicalId = (logicalId: string): string =>
    resources.find((r) => r.LogicalResourceId === logicalId)?.PhysicalResourceId ?? "";

  const alarmNames = resources
    .filter((r) => r.ResourceType === "AWS::CloudWatch::Alarm")
    .map((r) => r.PhysicalResourceId)
    .filter((id): id is string => Boolean(id));

  const functionName = require_(outputs, "FunctionName");
  const workerFunctionName = physicalId("IntroductionWorkerFunction");

  // Go 服务是独立于本栈的资源，发现不了不该让整个拓扑失败——
  // 少一个日志组只是少一处取证，而拓扑拿不到就什么都做不了。
  let goServiceLogGroup = "";
  try {
    goServiceLogGroup = await discoverGoServiceLogGroup(region());
  } catch {
    goServiceLogGroup = "";
  }

  return Object.freeze({
    region: region(),
    stackName: name,
    functionName,
    workerFunctionName,
    apiUrl: require_(outputs, "ApiUrl"),
    readinessUrl: require_(outputs, "ReadinessUrl"),
    introductionQueueUrl: require_(outputs, "IntroductionQueueUrl"),
    deadLetterQueueUrl: require_(outputs, "DeadLetterQueueUrl"),
    alertsTopicArn: require_(outputs, "AlertsTopicArn"),
    alarmNames: Object.freeze(alarmNames),
    logGroups: Object.freeze({
      collector: `/aws/lambda/${functionName}`,
      worker: workerFunctionName ? `/aws/lambda/${workerFunctionName}` : "",
      goService: goServiceLogGroup,
    }),
  });
};

let cached: Promise<Topology> | undefined;

/** 进程内缓存：一次会话里发现一次就够，省掉每个工具调用的两次 CFN 往返。 */
export const topology = (): Promise<Topology> => (cached ??= discover());

/** 仅供测试重置缓存。 */
export const resetTopology = (): void => {
  cached = undefined;
};
