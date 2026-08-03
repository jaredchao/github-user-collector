import { createHash } from "node:crypto";
import type { Diagnosis } from "../tools/diagnose.js";

/**
 * 同一个故障的稳定标识。
 *
 * 用来判断"这是不是同一件事"，决定要不要重复开单、重复通知。所以它必须
 * 对无关的变化免疫：时间戳、消息条数、具体耗时都不能进指纹，否则同一个
 * 故障每分钟都会算出一个新指纹，去重就形同虚设。
 *
 * 进指纹的只有三样：哪个告警、判断出的根因、当前是否还在故障中。根因变了
 * 就是另一件事，值得再开一单。
 */
export const fingerprintOf = (alarmName: string, diagnosis: Diagnosis): string => {
  const material = [
    alarmName,
    [...diagnosis.assessment.likelyCauses].sort().join("|"),
    diagnosis.assessment.healthyNow ? "healthy" : "unhealthy",
  ].join("::");

  return createHash("sha256").update(material).digest("hex").slice(0, 12);
};
