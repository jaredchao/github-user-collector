import { CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { SQSClient } from "@aws-sdk/client-sqs";
import { region } from "./config.js";

const memo = <T>(create: () => T): (() => T) => {
  let instance: T | undefined;
  return () => (instance ??= create());
};

export const cloudwatch = memo(() => new CloudWatchClient({ region: region() }));
export const logs = memo(() => new CloudWatchLogsClient({ region: region() }));
export const lambda = memo(() => new LambdaClient({ region: region() }));
export const sqs = memo(() => new SQSClient({ region: region() }));
