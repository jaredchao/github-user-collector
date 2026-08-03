import { topology } from "../src/config.js";
import { alarmTimeline } from "../src/tools/alarmTimeline.js";
import { checkReady } from "../src/tools/checkReady.js";
import { deploymentState } from "../src/tools/deploymentState.js";
import { queueDepth } from "../src/tools/dlqDepth.js";
import { listAlarms } from "../src/tools/listAlarms.js";
import { tailLogs } from "../src/tools/tailLogs.js";

/**
 * 拿真实 AWS 资源冒烟每个只读工具。
 *
 * 单元测试能证明逻辑对，但证明不了 IAM 权限够、资源名对得上、
 * SDK 参数没写错。这个脚本补的就是这一段。全部只读，可随时重跑。
 */
const run = async (name: string, fn: () => Promise<{ summary: string }>) => {
  const startedAt = Date.now();
  try {
    const result = await fn();
    console.log(`[通过] ${name} (${Date.now() - startedAt}ms)`);
    console.log(`       ${result.summary}`);
  } catch (error) {
    console.log(`[失败] ${name} (${Date.now() - startedAt}ms)`);
    console.log(`       ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};

const main = async () => {
  const topo = await topology();
  console.log(`栈 ${topo.stackName} @ ${topo.region}`);
  console.log(`发现 ${topo.alarmNames.length} 个告警，主函数 ${topo.functionName}\n`);

  await run("list_alarms", listAlarms);
  await run("deployment_state", () => deploymentState("live"));
  await run("queue_depth(dead-letter, 样本 3)", () => queueDepth("dead-letter", 3));
  await run("queue_depth(main)", () => queueDepth("main"));
  await run("check_ready", checkReady);

  const firing = (await listAlarms()).firing[0] ?? topo.alarmNames[0];
  if (firing) await run(`alarm_timeline(${firing})`, () => alarmTimeline(firing, 168));

  await run("tail_logs(worker, 1440 分钟)", () => tailLogs("worker", 1440));
};

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
