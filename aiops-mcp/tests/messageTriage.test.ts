import { describe, expect, it } from "vitest";
import { triageMessage } from "../src/tools/messageTriage.js";

const valid = JSON.stringify({
  eventType: "profile.saved",
  eventId: "evt-1",
  username: "torvalds",
  profileId: 42,
});

describe("triageMessage", () => {
  it("判定格式合法的事件可以重放", () => {
    const result = triageMessage(valid);

    expect(result.replayable).toBe(true);
    expect(result.reason).toContain("重放有意义");
  });

  it("非 JSON 的毒丸消息不可重放", () => {
    // 这正是当前死信队列里那条消息的真实内容
    const result = triageMessage("not-a-json-event");

    expect(result.replayable).toBe(false);
    expect(result.reason).toContain("不是合法 JSON");
  });

  it("事件类型不对的不可重放", () => {
    const result = triageMessage(JSON.stringify({ eventType: "profile.deleted" }));

    expect(result.replayable).toBe(false);
    expect(result.reason).toContain("profile.saved");
  });

  it("用户名非法的不可重放", () => {
    const body = JSON.stringify({
      eventType: "profile.saved",
      eventId: "evt-1",
      username: "-bad-name-",
      profileId: 1,
    });

    expect(triageMessage(body).replayable).toBe(false);
  });

  it("profileId 不是正整数的不可重放", () => {
    for (const profileId of [0, -1, 1.5, "3", null]) {
      const body = JSON.stringify({
        eventType: "profile.saved",
        eventId: "evt-1",
        username: "torvalds",
        profileId,
      });
      expect(triageMessage(body).replayable, `profileId=${String(profileId)}`).toBe(false);
    }
  });

  it("JSON 数组不算合法事件", () => {
    expect(triageMessage("[]").replayable).toBe(false);
  });
});
