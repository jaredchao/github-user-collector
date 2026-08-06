import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListServicesCommand,
} from "@aws-sdk/client-ecs";

const serviceNameOf = (arn: string): string => arn.split("/").pop() ?? "";

/**
 * 从集群里挑出 Go 服务。
 *
 * 集群是共享的——性能日志清洗服务也跑在同一个 zuoye-cluster 里。
 * ListServices 的返回顺序没有任何保证，取第一个会随机指向别的服务，
 * 于是诊断 go-service 时读到的是另一个服务的日志。这种错不会抛异常，
 * 只会让结论悄悄变错，比直接失败危险得多。
 *
 * 匹配不到就返回 undefined，让调用方以"发现失败"收场，而不是猜一个。
 */
export const pickGoService = (
  serviceArns: readonly string[],
  wanted: string,
): string | undefined =>
  serviceArns.find((arn) => serviceNameOf(arn) === wanted) ??
  serviceArns.find((arn) => serviceNameOf(arn).includes(wanted));

/**
 * 从 ECS 任务定义里发现 Go 服务的日志组。
 *
 * Go 服务不在采集器的 CloudFormation 栈里，所以拿不到栈输出。但也不能
 * 按约定猜日志组名：账号里同时存在 /ecs/zuoye-go-service 和
 * /ecs/zuoye-go-service-service-xxxx，后者是 Service Connect 的边车日志，
 * 猜错就会捞到一堆代理日志却看不见应用错误。
 *
 * 任务定义里的 awslogs-group 是唯一权威来源——容器实际往哪写，这里就写着。
 */
export const discoverGoServiceLogGroup = async (
  region: string,
): Promise<string> => {
  const cluster = process.env.AIOPS_ECS_CLUSTER ?? "zuoye-cluster";
  // 与 metricQueries.ts 的 ecsSpecs 用同一个环境变量和默认值，两边指的
  // 必须是同一个服务，否则日志和指标会来自不同的东西。
  const wanted =
    process.env.AIOPS_ECS_SERVICE_NAME ?? "zuoye-go-service-service";
  const client = new ECSClient({ region });

  const serviceArn =
    process.env.AIOPS_ECS_SERVICE ??
    pickGoService(
      (await client.send(new ListServicesCommand({ cluster }))).serviceArns ?? [],
      wanted,
    );
  if (!serviceArn) return "";

  const described = await client.send(
    new DescribeServicesCommand({ cluster, services: [serviceArn] }),
  );
  const taskDefinition = described.services?.[0]?.taskDefinition;
  if (!taskDefinition) return "";

  const definition = await client.send(
    new DescribeTaskDefinitionCommand({ taskDefinition }),
  );

  // 取第一个把日志写到 awslogs 的容器。边车（如 Service Connect 代理）
  // 要么没有 logConfiguration，要么写到另一个日志组。
  for (const container of definition.taskDefinition?.containerDefinitions ?? []) {
    if (container.logConfiguration?.logDriver !== "awslogs") continue;
    const group = container.logConfiguration.options?.["awslogs-group"];
    if (group) return group;
  }

  return "";
};
