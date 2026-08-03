/** 一次写操作发生前，被它覆盖的那部分状态。 */
export type RestorePoint = Readonly<{
  id: string;
  createdAt: string;
  /** 哪个工具创建的，还原时据此分派还原逻辑。 */
  operation: RestorableOperation;
  /** 操作对象，函数名或队列地址。 */
  target: string;
  /** 人类可读的一句话，说明还原会把什么改回什么。 */
  description: string;
  /** 还原所需的完整状态，形状由 operation 决定。 */
  payload: unknown;
  /** 已经还原过的话记下时间，避免重复还原造成困惑。 */
  restoredAt?: string;
}>;

export type RestorableOperation =
  | "set_alias_weight"
  | "rollback_canary"
  | "redrive_dlq"
  | "discard_dlq_messages";

/** 别名类操作的还原载荷：把别名改回这个样子就行。 */
export type AliasPayload = Readonly<{
  functionName: string;
  aliasName: string;
  functionVersion: string;
  additionalVersionWeights: Readonly<Record<string, number>>;
}>;

/** 消息类操作的还原载荷：这些消息可以被重新投递回去。 */
export type MessagesPayload = Readonly<{
  sourceQueueUrl: string;
  messages: readonly Readonly<{
    messageId: string;
    body: string;
    receiveCount: number;
    sentAt: string | null;
  }>[];
}>;

export interface RestoreStore {
  save(point: RestorePoint): Promise<void>;
  load(id: string): Promise<RestorePoint | null>;
  list(limit: number): Promise<readonly RestorePoint[]>;
  markRestored(id: string, at: string): Promise<void>;
}
