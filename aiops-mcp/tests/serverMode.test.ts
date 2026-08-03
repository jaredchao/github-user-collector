import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

/**
 * McpServer 没有公开的"列出已注册工具"接口，但注册表就挂在实例上。
 * 这里读它是为了断言装配结果，比起协议层往返，这种断言更直接也更快。
 */
const toolNamesOf = (server: ReturnType<typeof createServer>): string[] => {
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })
    ._registeredTools;
  return Object.keys(registered ?? {}).sort();
};

const WRITE_TOOLS = [
  "discard_dlq_messages",
  "redrive_dlq",
  "restore",
  "rollback_canary",
  "set_alias_weight",
];

describe("createServer", () => {
  it("full 模式装配全部 14 个工具", () => {
    const names = toolNamesOf(createServer("full"));

    expect(names).toHaveLength(14);
    for (const tool of WRITE_TOOLS) {
      expect(names, `full 模式应当有 ${tool}`).toContain(tool);
    }
  });

  it("read-only 模式一个写工具都不能有——这是公网端点的安全前提", () => {
    const names = toolNamesOf(createServer("read-only"));

    expect(names).toHaveLength(9);
    for (const tool of WRITE_TOOLS) {
      expect(names, `read-only 模式绝不能暴露 ${tool}`).not.toContain(tool);
    }
  });

  it("read-only 模式保留全部诊断能力，不是阉割版", () => {
    const names = toolNamesOf(createServer("read-only"));

    for (const tool of [
      "list_alarms",
      "alarm_timeline",
      "queue_depth",
      "deployment_state",
      "tail_logs",
      "diagnose",
      "get_metrics",
      "check_ready",
      "list_restore_points",
    ]) {
      expect(names, `read-only 模式应当保留 ${tool}`).toContain(tool);
    }
  });

  it("默认是 full——本地用得最多，不该每次都传参", () => {
    expect(toolNamesOf(createServer())).toHaveLength(14);
  });
});
