import { topology } from "../config.js";
import { redact, redactError } from "../redact.js";

export type ReadinessResult = Readonly<{
  url: string;
  ok: boolean;
  status: number | null;
  latencyMs: number;
  body: string;
  summary: string;
}>;

const TIMEOUT_MS = 15_000;

/**
 * 打一次 /ready，一个请求走通 API Gateway → Lambda → Go 服务 → PostgreSQL。
 *
 * 和逐个查指标互补：指标告诉你哪个组件的数字不对，这个告诉你
 * 整条链路此刻到底通不通。处置之后用它确认"真的恢复了"。
 */
export const checkReady = async (): Promise<ReadinessResult> => {
  const topo = await topology();
  const startedAt = Date.now();

  try {
    const response = await fetch(topo.readinessUrl, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = redact(await response.text()).slice(0, 2000);
    const latencyMs = Date.now() - startedAt;

    return {
      url: topo.readinessUrl,
      ok: response.ok,
      status: response.status,
      latencyMs,
      body,
      summary: response.ok
        ? `整条链路通畅，耗时 ${latencyMs}ms`
        : `就绪检查返回 ${response.status}，耗时 ${latencyMs}ms——链路中有组件不可用`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startedAt;
    const reason = redactError(error);
    return {
      url: topo.readinessUrl,
      ok: false,
      status: null,
      latencyMs,
      body: "",
      summary: `就绪检查未能完成（${latencyMs}ms 后 ${reason}）——网关或函数本身可能就不可达`,
    };
  }
};
