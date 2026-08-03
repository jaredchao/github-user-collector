import {
  GetAliasCommand,
  GetFunctionConfigurationCommand,
  ListVersionsByFunctionCommand,
} from "@aws-sdk/client-lambda";
import { lambda } from "../aws.js";
import { topology } from "../config.js";
import { collectPages } from "../paginate.js";

export type VersionInfo = Readonly<{
  version: string;
  codeSha256: string;
  lastModified: string;
  /** 这个版本当前承接的流量比例，0 到 1。 */
  trafficShare: number;
}>;

export type DeploymentStateResult = Readonly<{
  functionName: string;
  alias: string;
  /** 灰度中时为 true——此时有两个版本同时在线。 */
  canaryInProgress: boolean;
  versions: readonly VersionInfo[];
  latestPublishedVersion: string | null;
  summary: string;
}>;

/**
 * 别名当前指向哪个版本、有没有在灰度、各版本的代码指纹和发布时间。
 *
 * 这是"最近改过什么"的权威答案。告警时间线一旦和某个版本的
 * LastModified 对上，根因基本就锁定了。
 */
export const deploymentState = async (
  aliasName = "live",
): Promise<DeploymentStateResult> => {
  const topo = await topology();
  const client = lambda();

  const alias = await client.send(
    new GetAliasCommand({ FunctionName: topo.functionName, Name: aliasName }),
  );

  const primary = alias.FunctionVersion ?? "";
  const routing = alias.RoutingConfig?.AdditionalVersionWeights ?? {};
  const candidateEntry = Object.entries(routing)[0];
  const candidateWeight = candidateEntry?.[1] ?? 0;

  const shares: Record<string, number> = candidateEntry
    ? { [primary]: 1 - candidateWeight, [candidateEntry[0]]: candidateWeight }
    : { [primary]: 1 };

  const configs = await Promise.all(
    Object.keys(shares).map((version) =>
      client.send(
        new GetFunctionConfigurationCommand({
          FunctionName: topo.functionName,
          Qualifier: version,
        }),
      ),
    ),
  );

  const versions: VersionInfo[] = configs.map((config) => {
    const version = config.Version ?? "";
    return {
      version,
      codeSha256: config.CodeSha256 ?? "",
      lastModified: config.LastModified ?? "",
      trafficShare: shares[version] ?? 0,
    };
  });

  // 版本列表必须翻完。只取第一页会把"最新发布的版本"算错，而这个数字
  // 正是用来判断"有版本发布了却没接流量"的依据。
  const published = await collectPages<string>(async (marker) => {
    const page = await client.send(
      new ListVersionsByFunctionCommand({
        FunctionName: topo.functionName,
        Marker: marker,
      }),
    );
    return {
      items: (page.Versions ?? [])
        .map((v) => v.Version)
        .filter((v): v is string => Boolean(v)),
      nextToken: page.NextMarker,
    };
  });

  const numeric = published.items
    .filter((v) => v !== "$LATEST")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const latestPublishedVersion =
    numeric.length > 0 ? String(Math.max(...numeric)) : null;

  const canaryInProgress = Boolean(candidateEntry);
  const summary = candidateEntry
    ? `别名 ${aliasName} 正在灰度：版本 ${primary} 承接 ${Math.round((1 - candidateWeight) * 100)}%，` +
      `候选版本 ${candidateEntry[0]} 承接 ${Math.round(candidateWeight * 100)}%`
    : `别名 ${aliasName} 全量指向版本 ${primary}` +
      (latestPublishedVersion && latestPublishedVersion !== primary
        ? `，但已发布到版本 ${latestPublishedVersion}——有版本发布了却没接流量`
        : "");

  return {
    functionName: topo.functionName,
    alias: aliasName,
    canaryInProgress,
    versions: Object.freeze(versions),
    latestPublishedVersion,
    summary,
  };
};
