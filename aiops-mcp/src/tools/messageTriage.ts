export type Triage = Readonly<{
  replayable: boolean;
  reason: string;
}>;

// 与 backend/src/username.ts 保持一致。
const USERNAME_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

/**
 * 判断一条死信消息重放之后有没有可能成功。
 *
 * 这是死信处置里最关键的一步判断。死信队列里躺着两类东西：
 *
 *   1. 因为下游临时不可用而重试耗尽的消息——下游恢复后重放就能成功
 *   2. 格式本身就非法的毒丸消息——重放一万次也是同样的结果
 *
 * 把第二类重放回主队列，只会让它再消耗一轮重试、再回到死信队列，
 * 白白制造一轮告警。它们该走归档后丢弃，而不是重放。
 *
 * 校验规则刻意与 worker 的 parseProfileSavedEvent 对齐：worker 会拒绝的，
 * 这里就必须判定为不可重放，否则预检就失去了意义。
 */
export const triageMessage = (body: string): Triage => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { replayable: false, reason: "消息体不是合法 JSON，worker 永远无法解析" };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { replayable: false, reason: "消息体不是 JSON 对象" };
  }

  const event = parsed as Record<string, unknown>;

  if (event.eventType !== "profile.saved") {
    return {
      replayable: false,
      reason: `eventType 是 ${JSON.stringify(event.eventType)}，worker 只认 profile.saved`,
    };
  }
  if (typeof event.eventId !== "string" || !event.eventId) {
    return { replayable: false, reason: "缺少 eventId" };
  }
  if (typeof event.username !== "string" || !USERNAME_PATTERN.test(event.username)) {
    return { replayable: false, reason: "username 不是合法的 GitHub 用户名" };
  }
  if (!Number.isInteger(event.profileId) || (event.profileId as number) <= 0) {
    return { replayable: false, reason: "profileId 不是正整数" };
  }

  return {
    replayable: true,
    reason: "格式合法，之前失败多半是下游临时不可用，重放有意义",
  };
};
