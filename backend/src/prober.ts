/**
 * Scheduled probe of the whole collect chain.
 *
 * This is what CloudWatch Synthetics would do, written by hand because a
 * Synthetics canary needs at least 960 MB and this account caps Lambda memory
 * at 512 MB. It exercises the real endpoints and publishes the verdict as an
 * embedded metric, so an alarm can page on it without extra IAM or SDKs.
 */

interface ProbeStep {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}

export interface ProbeResult {
  ok: boolean;
  steps: ProbeStep[];
}

const METRIC_NAMESPACE = "ZuoyeProbe";

// A record that hasn't been touched in this long means the worker stopped
// writing, even if reads still succeed.
const FRESH_MS = 15 * 60 * 1000;

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

async function step(
  steps: ProbeStep[],
  name: string,
  run: () => Promise<string | undefined>,
): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await run();
    steps.push({ name, ok: true, ms: Date.now() - started, detail });
    return true;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    steps.push({ name, ok: false, ms: Date.now() - started, detail });
    console.error(`probe step ${name} failed: ${detail}`);
    return false;
  }
}

async function expectStatus(response: Response, ...codes: number[]): Promise<void> {
  if (!codes.includes(response.status)) {
    throw new Error(`expected ${codes.join("/")} got ${response.status}`);
  }
}

export async function handler(): Promise<ProbeResult> {
  const steps: ProbeStep[] = [];
  const started = Date.now();

  const ok = await runProbe(steps);

  // Embedded Metric Format: CloudWatch turns this log line into metrics, so
  // the probe needs no cloudwatch:PutMetricData permission at all.
  console.log(
    JSON.stringify({
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: [["Chain"]],
            Metrics: [
              { Name: "Success", Unit: "Count" },
              { Name: "DurationMs", Unit: "Milliseconds" },
            ],
          },
        ],
      },
      Chain: "collect",
      Success: ok ? 1 : 0,
      DurationMs: Date.now() - started,
      steps,
    }),
  );

  return { ok, steps };
}

async function runProbe(steps: ProbeStep[]): Promise<boolean> {
  let api: string;
  let go: string;
  let user: string;
  try {
    api = env("PROBE_API_URL");
    go = env("PROBE_GO_URL");
    user = env("PROBE_USER", "torvalds");
  } catch (err) {
    steps.push({ name: "config", ok: false, ms: 0, detail: String(err) });
    return false;
  }

  const settleMs = Number(process.env.PROBE_SETTLE_MS ?? 8000);
  const pollMs = Number(process.env.PROBE_POLL_MS ?? 2000);
  const attempts = Number(process.env.PROBE_ATTEMPTS ?? 8);

  let healthy = await step(steps, "api-health", async () => {
    await expectStatus(await fetch(`${api}/health`), 200);
    return undefined;
  });

  healthy =
    (await step(steps, "front-door-health", async () => {
      await expectStatus(await fetch(`${go}/health`), 200);
      return undefined;
    })) && healthy;

  healthy =
    (await step(steps, "queue-collect", async () => {
      await expectStatus(
        await fetch(`${go}/users`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ username: user }),
        }),
        202,
      );
      return undefined;
    })) && healthy;

  // Give SNS, SQS and the worker a moment before the first read.
  await sleep(settleMs);

  healthy =
    (await step(steps, "read-back", async () => {
      for (let i = 0; i < attempts; i++) {
        const response = await fetch(`${go}/users/${encodeURIComponent(user)}`);
        if (response.status === 404) {
          await sleep(pollMs);
          continue;
        }
        await expectStatus(response, 200);
        const stored = (await response.json()) as { updatedAt?: string };
        const age = Date.now() - Date.parse(stored.updatedAt ?? "");
        if (!Number.isFinite(age)) throw new Error("record has no updatedAt");
        if (age > FRESH_MS) {
          throw new Error(`stale record: written ${Math.round(age / 1000)}s ago`);
        }
        return `fresh by ${Math.round(age / 1000)}s`;
      }
      throw new Error("collection never landed");
    })) && healthy;

  healthy =
    (await step(steps, "intro", async () => {
      await expectStatus(await fetch(`${go}/intro?username=${encodeURIComponent(user)}`), 200);
      return undefined;
    })) && healthy;

  return healthy;
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}
