import { DescribeLogGroupsCommand } from "@aws-sdk/client-cloudwatch-logs";
import { logs } from "../aws.js";

export type LogGroupInfo = Readonly<{
  name: string;
  /** null 表示永久保留——对被高频调用的组件是笔慢慢累积的账。 */
  retentionDays: number | null;
  storedBytes: number;
}>;

export type ListLogGroupsResult = Readonly<{
  groups: readonly LogGroupInfo[];
  summary: string;
}>;

const MAX_PAGES = 10;

/**
 * 列出账号里的日志组。
 *
 * 存在的理由是让 Agent 能自己发现有什么可查，而不是只能问预先定义好的
 * 那几个 target。系统长出新组件时——比如性能监控那三个日志组——不用改
 * 代码，它们自然会出现在这里。
 */
export const listLogGroups = async (
  prefix?: string,
): Promise<ListLogGroupsResult> => {
  const collected: LogGroupInfo[] = [];
  let token: string | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const response = await logs().send(
      new DescribeLogGroupsCommand({
        logGroupNamePrefix: prefix,
        nextToken: token,
        limit: 50,
      }),
    );

    for (const group of response.logGroups ?? []) {
      if (!group.logGroupName) continue;
      collected.push({
        name: group.logGroupName,
        retentionDays: group.retentionInDays ?? null,
        storedBytes: group.storedBytes ?? 0,
      });
    }

    token = response.nextToken;
    if (!token) break;
  }

  const groups = [...collected].sort((a, b) => a.name.localeCompare(b.name));
  const forever = groups.filter((g) => g.retentionDays === null).length;

  const summary =
    groups.length === 0
      ? prefix
        ? `没有前缀为 ${prefix} 的日志组`
        : "账号里没有日志组"
      : `共 ${groups.length} 个日志组` +
        (forever > 0 ? `，其中 ${forever} 个未设保留期（永久累积）` : "");

  return { groups: Object.freeze(groups), summary };
};
