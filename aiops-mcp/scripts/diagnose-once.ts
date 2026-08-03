import { diagnose } from "../src/tools/diagnose.js";

/** 跑一轮诊断并打印结论，供演示脚本调用。 */
const minutes = Number(process.argv[2] ?? "120");
const result = await diagnose(minutes);

console.log(`    ${result.summary}`);
for (const correlation of result.correlations) {
  console.log(`      - ${correlation}`);
}
