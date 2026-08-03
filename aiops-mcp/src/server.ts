import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerReadOnlyTools } from "./register/readOnly.js";
import { registerWriteTools } from "./register/write.js";

export type ServerMode = "full" | "read-only";

const instructionsFor = (mode: ServerMode): string =>
  [
    "这个服务器把一套真实运行的 AWS 系统（API Gateway + Lambda + SNS/SQS + ECS 上的 Go 服务 + RDS）",
    "的运维能力暴露为工具。诊断故障时的推荐顺序：",
    "1. list_alarms 看哪些告警在响",
    "2. alarm_timeline 确定故障起点",
    "3. deployment_state 看那个时刻附近有没有发过版本",
    "4. queue_depth / tail_logs 收集具体证据",
    "5. check_ready 确认当前链路是否通",
    "或者直接调 diagnose，它把上面这套流程编排好了。",
    "先形成证据链再下结论，不要凭单一指标判断根因。",
    ...(mode === "read-only"
      ? [
          "",
          "本实例是只读的，不提供任何处置能力。判断出需要回滚或清理死信时，",
          "如实说明该做什么，并告诉用户处置要在本地那套带写工具的实例上执行。",
        ]
      : []),
  ].join("\n");

/**
 * 按模式装配服务器。
 *
 * full 给本地 stdio：调用方已经持有本机 AWS 凭证，读写都有。
 * read-only 给公网上的 Lambda：端点只靠一个 token 保护，能力上限必须止于"看"。
 * token 泄露的后果因此是"别人能看你的告警"，而不是"别人能回滚你的线上版本"。
 */
export const createServer = (mode: ServerMode = "full"): McpServer => {
  const server = new McpServer(
    { name: "aiops-mcp", version: "1.0.0" },
    { instructions: instructionsFor(mode) },
  );

  registerReadOnlyTools(server);
  if (mode === "full") registerWriteTools(server);

  return server;
};
