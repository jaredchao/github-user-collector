import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * 本地入口：Claude Code / Codex 直接以子进程方式拉起，走 stdio 传输。
 *
 * stdout 是 MCP 协议通道，任何调试输出都必须走 stderr，否则会污染协议帧。
 */
const main = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("aiops-mcp 已就绪（stdio）\n");
};

main().catch((error: unknown) => {
  process.stderr.write(
    `aiops-mcp 启动失败: ${error instanceof Error ? error.stack : String(error)}\n`,
  );
  process.exit(1);
});
