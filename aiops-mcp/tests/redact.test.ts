import { describe, expect, it } from "vitest";
import { redact, redactError } from "../src/redact.js";

describe("redact", () => {
  it("抹掉连接串里的用户名和密码，保留协议", () => {
    const result = redact("postgres://admin:hunter2@db.internal:5432/collector");

    expect(result).not.toContain("hunter2");
    expect(result).not.toContain("admin");
    expect(result).toContain("postgres://");
    expect(result).toContain("db.internal");
  });

  it("抹掉 JWT", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27u";

    expect(redact(`token=${jwt}`)).not.toContain("eyJhbGciOiJIUzI1NiJ9");
  });

  it("抹掉 AWS 访问密钥", () => {
    expect(redact("AKIAIOSFODNN7EXAMPLE")).toBe("[REDACTED_AWS_KEY]");
    expect(redact("ASIAIOSFODNN7EXAMPLE")).toBe("[REDACTED_AWS_KEY]");
  });

  it("抹掉 Authorization 与 Cookie 头", () => {
    expect(redact("Authorization: Bearer abcdef1234567890")).not.toContain("abcdef");
    expect(redact("cookie: session=abc123; theme=dark")).not.toContain("abc123");
  });

  it("抹掉键值对形式的密钥", () => {
    const result = redact('{"password":"s3cr3t","apiKey":"k-9988","host":"db.internal"}');

    expect(result).not.toContain("s3cr3t");
    expect(result).not.toContain("k-9988");
    // 非敏感字段要留着，否则诊断信息也一起没了
    expect(result).toContain("db.internal");
  });

  it("抹掉查询串里的敏感参数", () => {
    const result = redact("GET /callback?code=ok&token=abc123def&page=2");

    expect(result).not.toContain("abc123def");
    expect(result).toContain("page=2");
  });

  // 版本号长得像邮箱，但抹掉它就看不出是哪个客户端版本在出问题——
  // 过度脱敏不比泄露安全，只是把代价从隐私换成了诊断能力。
  it("不把 name@version 当成邮箱", () => {
    for (const sample of [
      '{"sdk":"perf-sdk@1.0.0"}',
      "@zuoye/perf-sdk@1.0.0",
      "node@22.11.0",
      "react@18.3.1",
    ]) {
      expect(redact(sample), sample).toBe(sample);
    }
  });

  it("抹掉邮箱", () => {
    expect(redact("user oncall@example.com failed")).not.toContain("oncall@example.com");
  });

  it("抹掉 AWS 账号 ID，但保留 ARN 中对诊断有用的部分", () => {
    const result = redact(
      "arn:aws:lambda:us-east-2:089783390738:function:zuoye-collector-Fn",
    );

    expect(result).not.toContain("089783390738");
    // 服务、区域、函数名都不敏感，且是定位问题的关键
    expect(result).toContain("lambda");
    expect(result).toContain("us-east-2");
    expect(result).toContain("zuoye-collector-Fn");
  });

  it("不误伤 13 位毫秒时间戳", () => {
    expect(redact("SentTimestamp=1785489739868")).toContain("1785489739868");
  });

  it("普通日志原样返回", () => {
    const line = "introduction generated for torvalds (event evt-42)";

    expect(redact(line)).toBe(line);
  });
});

describe("redactError", () => {
  it("AWS 的 AccessDenied 报文会带出账号与角色，必须过脱敏", () => {
    const error = new Error(
      "User: arn:aws:iam::089783390738:user/ai_user is not authorized to perform: " +
        "lambda:UpdateAlias on resource: arn:aws:lambda:us-east-2:089783390738:function:fn",
    );

    const result = redactError(error);

    expect(result).not.toContain("089783390738");
    // 仍然要看得出是什么权限出了问题
    expect(result).toContain("lambda:UpdateAlias");
  });

  it("非 Error 的抛出物也能处理", () => {
    expect(redactError("account 089783390738 denied")).not.toContain("089783390738");
  });

  it("兜底：脱敏后的文本里不应再出现任何 12 位数字", () => {
    const samples = [
      "arn:aws:sqs:us-east-2:089783390738:queue",
      "account=089783390738 role=deploy",
      "089783390738",
    ];

    for (const sample of samples) {
      expect(redact(sample), sample).not.toMatch(/\b\d{12}\b/);
    }
  });
});
