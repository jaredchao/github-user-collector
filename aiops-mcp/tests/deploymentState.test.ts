import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();

vi.mock("../src/aws.js", () => ({ lambda: () => ({ send }) }));
vi.mock("../src/config.js", () => ({
  topology: async () => ({ functionName: "collector-fn" }),
}));

const { deploymentState } = await import("../src/tools/deploymentState.js");

const configFor = (version: string) => ({
  Version: version,
  CodeSha256: `sha-${version}`,
  LastModified: `2026-08-0${version}T00:00:00.000+0000`,
});

const versionList = (versions: string[]) => ({
  Versions: [{ Version: "$LATEST" }, ...versions.map((v) => ({ Version: v }))],
});

describe("deploymentState", () => {
  beforeEach(() => send.mockReset());

  it("非灰度时全量流量归属单一版本", async () => {
    send.mockResolvedValueOnce({ FunctionVersion: "3", RoutingConfig: undefined });
    send.mockResolvedValueOnce(configFor("3"));
    send.mockResolvedValueOnce(versionList(["1", "2", "3"]));

    const result = await deploymentState("live");

    expect(result.canaryInProgress).toBe(false);
    expect(result.versions).toHaveLength(1);
    expect(result.versions[0]?.trafficShare).toBe(1);
    expect(result.summary).toBe("别名 live 全量指向版本 3");
  });

  it("灰度中时按权重拆分流量，并把两个版本都列出来", async () => {
    send.mockResolvedValueOnce({
      FunctionVersion: "3",
      RoutingConfig: { AdditionalVersionWeights: { "4": 0.1 } },
    });
    send.mockResolvedValueOnce(configFor("3"));
    send.mockResolvedValueOnce(configFor("4"));
    send.mockResolvedValueOnce(versionList(["1", "2", "3", "4"]));

    const result = await deploymentState("live");
    const stable = result.versions.find((v) => v.version === "3");
    const candidate = result.versions.find((v) => v.version === "4");

    expect(result.canaryInProgress).toBe(true);
    expect(stable?.trafficShare).toBeCloseTo(0.9);
    expect(candidate?.trafficShare).toBeCloseTo(0.1);
    expect(result.summary).toContain("承接 90%");
    expect(result.summary).toContain("承接 10%");
  });

  it("发布了新版本却没接流量时主动点出来", async () => {
    send.mockResolvedValueOnce({ FunctionVersion: "3", RoutingConfig: undefined });
    send.mockResolvedValueOnce(configFor("3"));
    send.mockResolvedValueOnce(versionList(["1", "2", "3", "7"]));

    const result = await deploymentState("live");

    expect(result.latestPublishedVersion).toBe("7");
    expect(result.summary).toContain("有版本发布了却没接流量");
  });

  it("版本号按数值比较，不按字典序", async () => {
    send.mockResolvedValueOnce({ FunctionVersion: "10", RoutingConfig: undefined });
    send.mockResolvedValueOnce(configFor("10"));
    send.mockResolvedValueOnce(versionList(["9", "10"]));

    const result = await deploymentState("live");

    // 字典序会把 "9" 判成最大版本
    expect(result.latestPublishedVersion).toBe("10");
  });
});
