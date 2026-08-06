/**
 * 把一段文本里的敏感值抹掉。
 *
 * 两个容易漏的地方，都不在"日志行"这个显而易见的入口上：
 *
 *   1. AWS 的失败报文。AccessDenied 会带上完整的 IAM ARN、账号 ID 和资源名，
 *      而错误处理路径通常绕开了只作用于日志的脱敏。
 *   2. 队列里的消息体。死信消息是用户数据的原样副本，里面什么都可能有。
 *
 * 规则顺序有讲究：先抹结构明确的（连接串、JWT、键值对），再抹通用模式
 * （账号 ID、邮箱）。反过来会让通用规则先把结构打碎，具体规则就匹配不上了。
 */

type Rule = Readonly<{ pattern: RegExp; replace: string }>;

const RULES: readonly Rule[] = [
  // 连接串里的用户名和密码。保留协议名——它对诊断有用，且不敏感。
  {
    pattern: /\b(postgres|postgresql|mysql|mongodb|redis|amqp|amqps):\/\/[^@\s"']+@/gi,
    replace: "$1://[REDACTED]@",
  },
  // JWT。三段式结构很独特，先于通用的 token 规则匹配。
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    replace: "[REDACTED_JWT]",
  },
  // AWS 长期/临时访问密钥
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: "[REDACTED_AWS_KEY]" },
  // Authorization 头的两种常见形式
  {
    pattern: /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: "$1 [REDACTED]",
  },
  { pattern: /\b(authorization|cookie|set-cookie)\s*[:=]\s*[^\n\r]+/gi, replace: "$1: [REDACTED]" },
  // 各种"密钥字段 = 值"。值一直吃到分隔符为止。
  {
    pattern:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|secret[_-]?key|private[_-]?key|credential|session[_-]?id)(["']?\s*[:=]\s*["']?)([^\s"',;&}\]]+)/gi,
    replace: "$1$2[REDACTED]",
  },
  // URL 查询串里的敏感参数
  {
    pattern: /([?&](?:token|key|signature|sig|password|secret|credential)=)[^&\s"']+/gi,
    replace: "$1[REDACTED]",
  },
  // 邮箱。顶级域名必须是字母，否则 perf-sdk@1.0.0 这类 name@version 会被
  // 当成邮箱抹掉——而 SDK 版本正是排查"哪个客户端版本出的问题"的关键线索。
  // 过度脱敏不比泄露安全，它只是把代价从隐私换成了诊断能力。
  {
    pattern: /\b[\w.+-]+@(?:[\w-]+\.)+[a-zA-Z]{2,}\b/g,
    replace: "[REDACTED_EMAIL]",
  },
  // AWS 账号 ID。放在最后：ARN 里的账号段也由这条规则抹掉，而 ARN 的其余
  // 部分（服务、区域、资源名）对诊断有用且不敏感，故保留。
  { pattern: /\b\d{12}\b/g, replace: "[REDACTED_ACCOUNT]" },
];

export const redact = (text: string): string =>
  RULES.reduce((acc, rule) => acc.replace(rule.pattern, rule.replace), text);

/** 把任意异常转成一句已脱敏的说明。 */
export const redactError = (error: unknown): string =>
  redact(error instanceof Error ? error.message : String(error));
