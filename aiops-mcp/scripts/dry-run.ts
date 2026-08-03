import { discardDlqMessages, redriveDlq } from "../src/tools/dlqControl.js";

/**
 * 演练两个死信写工具，供演示脚本调用。
 *
 * 全程 dryRun=true：只算计划，不投递、不删除、不写还原点。
 */
const redrive = await redriveDlq(10, true);
console.log(`    redrive 演练 : ${redrive.plan}`);

const discard = await discardDlqMessages(10, true);
console.log(`    discard 演练 : ${discard.plan}`);
