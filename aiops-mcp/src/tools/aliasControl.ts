import { UpdateAliasCommand } from "@aws-sdk/client-lambda";
import { lambda } from "../aws.js";
import { topology } from "../config.js";
import { createRestorePoint } from "../restore/store.js";
import { describeAlias, snapshotAlias } from "./aliasSnapshot.js";
import { dryRunResult, executedResult, type WriteResult } from "./writeResult.js";

export const applyAlias = async (input: {
  functionName: string;
  aliasName: string;
  functionVersion: string;
  weights: Record<string, number>;
}): Promise<void> => {
  await lambda().send(
    new UpdateAliasCommand({
      FunctionName: input.functionName,
      Name: input.aliasName,
      FunctionVersion: input.functionVersion,
      RoutingConfig: { AdditionalVersionWeights: input.weights },
    }),
  );
};

/**
 * 把候选版本按权重接入流量。
 *
 * 备份的是别名的完整配置。别名类操作天然可逆——只要记住改之前
 * 长什么样，撤销就是把同样的两个字段写回去。
 */
export const setAliasWeight = async (
  candidateVersion: string,
  weight: number,
  dryRun = true,
  aliasName = "live",
): Promise<WriteResult> => {
  if (weight <= 0 || weight >= 1) {
    throw new Error(`权重必须在 0 到 1 之间（不含两端），收到 ${weight}`);
  }

  const topo = await topology();
  const before = await snapshotAlias(topo.functionName, aliasName);

  if (before.functionVersion === candidateVersion) {
    throw new Error(
      `别名 ${aliasName} 的主版本已经是 ${candidateVersion}，给它再加权重没有意义`,
    );
  }

  const plan =
    `把版本 ${candidateVersion} 的流量权重设为 ${Math.round(weight * 100)}%，` +
    `其余 ${Math.round((1 - weight) * 100)}% 留在版本 ${before.functionVersion}`;

  if (dryRun) return dryRunResult(plan, { before });

  const point = await createRestorePoint({
    operation: "set_alias_weight",
    target: `${topo.functionName}:${aliasName}`,
    description: `还原为：${describeAlias(before)}`,
    payload: before,
  });

  await applyAlias({
    functionName: topo.functionName,
    aliasName,
    functionVersion: before.functionVersion,
    weights: { [candidateVersion]: weight },
  });

  return executedResult({
    plan,
    restorePointId: point.id,
    summary: `已${plan}。改动前的配置已存入还原点 ${point.id}`,
    details: { before },
  });
};

/**
 * 取消灰度，把全部流量收回到稳定版本。
 *
 * 不传 targetVersion 时收回到别名当前的主版本，也就是"把候选版本
 * 摘掉"。传了则连主版本一起改，用于回滚一个已经全量上线的坏版本。
 */
export const rollbackCanary = async (
  targetVersion?: string,
  dryRun = true,
  aliasName = "live",
): Promise<WriteResult> => {
  const topo = await topology();
  const before = await snapshotAlias(topo.functionName, aliasName);
  const candidates = Object.keys(before.additionalVersionWeights);
  const stable = targetVersion ?? before.functionVersion;

  if (candidates.length === 0 && stable === before.functionVersion) {
    throw new Error(
      `别名 ${aliasName} 当前没有在灰度，且目标版本就是现在的版本——没有可回滚的内容`,
    );
  }

  const plan =
    candidates.length > 0
      ? `摘掉候选版本 ${candidates.join("、")}，把 100% 流量收回版本 ${stable}`
      : `把别名 ${aliasName} 从版本 ${before.functionVersion} 全量切回版本 ${stable}`;

  if (dryRun) return dryRunResult(plan, { before });

  const point = await createRestorePoint({
    operation: "rollback_canary",
    target: `${topo.functionName}:${aliasName}`,
    description: `还原为：${describeAlias(before)}`,
    payload: before,
  });

  await applyAlias({
    functionName: topo.functionName,
    aliasName,
    functionVersion: stable,
    weights: {},
  });

  return executedResult({
    plan,
    restorePointId: point.id,
    summary: `已${plan}。改动前的配置已存入还原点 ${point.id}`,
    details: { before },
  });
};
