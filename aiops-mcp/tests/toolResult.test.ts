import { describe, expect, it } from "vitest";
import { failed, guard, ok } from "../src/toolResult.js";

const textOf = (result: { content: { text: string }[] }): string =>
  result.content[0]?.text ?? "";

describe("ok", () => {
  it("摘要在第一行，结构化数据跟在后面", () => {
    const text = textOf(ok("死信队列是空的", { visible: 0 }));

    expect(text.split("\n")[0]).toBe("死信队列是空的");
    expect(text).toContain('"visible": 0');
  });

  it("兜住结构化字段里的账号 ID——逐字段脱敏漏掉的正是这些", () => {
    const text = textOf(
      ok("死信队列积压 1 条", {
        queueUrl: "https://sqs.us-east-2.amazonaws.com/089783390738/zuoye-dlq",
        topicArn: "arn:aws:sns:us-east-2:089783390738:alerts",
      }),
    );

    expect(text).not.toMatch(/\b\d{12}\b/);
    // 队列名和服务名要留着，否则 Agent 分不清在说哪个队列
    expect(text).toContain("zuoye-dlq");
    expect(text).toContain("sns");
  });

  it("消息体里的密码不会随结构化数据漏出去", () => {
    const text = textOf(
      ok("样本", { body: "postgres://admin:hunter2@db.internal:5432/collector" }),
    );

    expect(text).not.toContain("hunter2");
  });
});

describe("failed", () => {
  it("标成错误并抹掉报文里的账号与 ARN", () => {
    const result = failed(
      new Error(
        "User: arn:aws:iam::089783390738:user/ai_user is not authorized to perform: lambda:UpdateAlias",
      ),
    );

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/\b\d{12}\b/);
    expect(textOf(result)).toContain("lambda:UpdateAlias");
  });
});

describe("guard", () => {
  it("正常路径原样返回", async () => {
    const result = await guard(async () => ok("好了", {}));

    expect(result.isError).toBeUndefined();
  });

  it("抛错时转成脱敏后的错误结果，而不是让异常穿透协议层", async () => {
    const result = await guard(async () => {
      throw new Error("account 089783390738 denied");
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/\b\d{12}\b/);
  });
});
