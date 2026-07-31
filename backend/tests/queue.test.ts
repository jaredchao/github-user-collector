import { beforeEach, describe, expect, it, vi } from "vitest";

const send = vi.fn();
vi.mock("@aws-sdk/client-sns", () => ({
  SNSClient: class {
    send = send;
  },
  PublishCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

const { publishCollectRequest } = await import("../src/queue.js");

beforeEach(() => {
  send.mockReset();
  send.mockResolvedValue({ MessageId: "msg-1" });
  process.env.COLLECT_TOPIC_ARN = "arn:aws:sns:us-east-2:1:zuoye-collect-requests";
});

describe("publishCollectRequest", () => {
  it("publishes the username and returns the message id", async () => {
    const id = await publishCollectRequest("torvalds");

    expect(id).toBe("msg-1");
    const { input } = send.mock.calls[0]![0] as { input: { TopicArn: string; Message: string } };
    expect(input.TopicArn).toBe("arn:aws:sns:us-east-2:1:zuoye-collect-requests");
    expect(JSON.parse(input.Message)).toMatchObject({ username: "torvalds" });
  });

  it("stamps each request so consumers can trace it end to end", async () => {
    await publishCollectRequest("torvalds");

    const { input } = send.mock.calls[0]![0] as { input: { TopicArn: string; Message: string } };
    const message = JSON.parse(input.Message) as { requestedAt?: string };
    expect(message.requestedAt).toBeTypeOf("string");
    expect(Number.isNaN(Date.parse(message.requestedAt!))).toBe(false);
  });

  it("fails loudly when the topic is not configured", async () => {
    delete process.env.COLLECT_TOPIC_ARN;

    await expect(publishCollectRequest("torvalds")).rejects.toThrow("COLLECT_TOPIC_ARN");
    expect(send).not.toHaveBeenCalled();
  });
});
