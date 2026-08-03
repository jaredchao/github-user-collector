import { GetAliasCommand } from "@aws-sdk/client-lambda";
import { lambda } from "../aws.js";
import type { AliasPayload } from "../restore/types.js";

/**
 * 抓取别名当前的完整配置。
 *
 * 别名类操作的可撤销性全靠它：只要拿到了版本号和权重表，把这两样
 * 原样写回去就等于什么都没发生过。
 */
export const snapshotAlias = async (
  functionName: string,
  aliasName: string,
): Promise<AliasPayload> => {
  const alias = await lambda().send(
    new GetAliasCommand({ FunctionName: functionName, Name: aliasName }),
  );

  return Object.freeze({
    functionName,
    aliasName,
    functionVersion: alias.FunctionVersion ?? "",
    additionalVersionWeights: Object.freeze({
      ...(alias.RoutingConfig?.AdditionalVersionWeights ?? {}),
    }),
  });
};

/** 把快照描述成一句人话，写进还原点的 description。 */
export const describeAlias = (snapshot: AliasPayload): string => {
  const entries = Object.entries(snapshot.additionalVersionWeights);
  if (entries.length === 0) {
    return `别名 ${snapshot.aliasName} 全量指向版本 ${snapshot.functionVersion}`;
  }
  const split = entries
    .map(([version, weight]) => `版本 ${version} 占 ${Math.round(weight * 100)}%`)
    .join("，");
  return `别名 ${snapshot.aliasName} 主版本 ${snapshot.functionVersion}，另有 ${split}`;
};
