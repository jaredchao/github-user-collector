import {
  DescribeServicesCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListServicesCommand,
} from "@aws-sdk/client-ecs";

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
  const client = new ECSClient({ region });

  const serviceArn =
    process.env.AIOPS_ECS_SERVICE ??
    (await client.send(new ListServicesCommand({ cluster }))).serviceArns?.[0];
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
