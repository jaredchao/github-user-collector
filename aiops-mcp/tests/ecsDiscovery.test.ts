import { describe, expect, it } from "vitest";
import { pickGoService } from "../src/ecsDiscovery.js";

const arn = (name: string) =>
  `arn:aws:ecs:us-east-2:089783390738:service/zuoye-cluster/${name}`;

const GO = "zuoye-go-service-service";

describe("pickGoService", () => {
  it("按名字精确挑出 Go 服务", () => {
    expect(pickGoService([arn(GO)], GO)).toBe(arn(GO));
  });

  // 集群是共享的：性能日志清洗服务也跑在 zuoye-cluster 里。ListServices
  // 的顺序没有保证，原来取 serviceArns[0] 会随机指向清洗服务，于是诊断
  // Go 服务时读到的是另一个服务的日志——不报错，只是结论悄悄变错。
  it("集群里有别的服务排在前面时也不会挑错", () => {
    const arns = [arn("zuoye-perf-cleaner-service"), arn(GO)];
    expect(pickGoService(arns, GO)).toBe(arn(GO));
  });

  it("顺序颠倒也一样", () => {
    const arns = [arn(GO), arn("zuoye-perf-cleaner-service")];
    expect(pickGoService(arns, GO)).toBe(arn(GO));
  });

  it("PR 环境的同名前缀服务不会顶掉正主", () => {
    const arns = [
      arn("zuoye-go-service-pr-42"),
      arn("zuoye-perf-cleaner-service"),
      arn(GO),
    ];
    expect(pickGoService(arns, GO)).toBe(arn(GO));
  });

  // 精确匹配不到时退一步做包含匹配，覆盖服务改名带后缀的情况。
  it("没有完全同名时退回包含匹配", () => {
    const arns = [arn("zuoye-perf-cleaner-service"), arn("zuoye-go-service-service-blue")];
    expect(pickGoService(arns, GO)).toBe(arn("zuoye-go-service-service-blue"));
  });

  // 挑不到就明确失败，绝不退回"第一个"——那正是这个 bug 的来源。
  it("匹配不到时返回 undefined 而不是猜一个", () => {
    expect(pickGoService([arn("zuoye-perf-cleaner-service")], GO)).toBeUndefined();
    expect(pickGoService([], GO)).toBeUndefined();
  });
});
