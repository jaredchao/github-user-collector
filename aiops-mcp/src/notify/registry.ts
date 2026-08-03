import { feishuNotifier } from "./feishu.js";
import type { Notifier } from "./types.js";

/**
 * 当前启用的通知渠道。
 *
 * 每个渠道自己判断是否配置齐全，没配就跳过而不是报错——本地跑诊断时不该
 * 因为没设 webhook 就失败。
 */
export const notifiers = (): readonly Notifier[] => [feishuNotifier];
