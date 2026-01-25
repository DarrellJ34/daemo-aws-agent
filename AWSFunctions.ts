import "reflect-metadata";
import { DaemoFunction } from "daemo-engine";
import { z } from "zod";

import {
  listS3Objects,
  createPresignedGetUrl,
  putTextObject,
  getTextObject,
  findOldObjects,
} from "./awsS3.js";

import {
  listRunningInstancesCapped,
  getIdleMetricsForInstances,
  classifyIdle,
  listEc2InstancesSimple,
  type ec2InstanceSummary,
  type idleCandidate,
} from "./awsEc2Idle.js";

const allowedBucketName = "daemo-agent-s3-darrell";

// ----------------------------
// S3 Schemas
// ----------------------------

const listFilesInputSchema = z.object({
  prefix: z.string().optional().default(""),
  limit: z.number().int().min(1).max(1000).optional().default(20),
});

const listFilesOutputSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  count: z.number().int().nonnegative(),
  keys: z.array(z.string()),
});

const readTextInputSchema = z.object({
  key: z.string().min(1),
});

const readTextOutputSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  content: z.string(),
  contentType: z.string().optional(),
});

const writeTextInputSchema = z.object({
  key: z.string().min(1),
  content: z.string().min(1),
  contentType: z.string().optional().default("text/plain"),
});

const writeTextOutputSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  etag: z.string().optional(),
});

const presignDownloadInputSchema = z.object({
  key: z.string().min(1),
  expiresInSeconds: z.number().int().min(60).max(3600).optional().default(900),
});

const presignDownloadOutputSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int(),
});

const findOldFilesInputSchema = z.object({
  prefix: z.string().optional().default(""),
  olderThanDays: z.number().int().min(1).max(3650).optional().default(180),
  minSizeBytes: z.number().int().min(0).optional().default(1024),
  maxResults: z.number().int().min(1).max(200).optional().default(50),
});

const oldObjectSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative(),
  lastModified: z.string().optional(),
  ageDays: z.number().int().optional(),
  storageClass: z.string().optional(),
});

const findOldFilesOutputSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  olderThanDays: z.number().int(),

  scanned: z.number().int().nonnegative(),
  truncated: z.boolean(),

  resultCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),

  objects: z.array(oldObjectSchema),
});

// ----------------------------
// EC2 Schemas
// ----------------------------

const listEc2InstancesInputSchema = z.object({
  maxInstances: z.number().int().min(1).max(200).optional().default(50),
  states: z.array(z.string().min(1)).optional().default(["running"]),
});

const ec2InstanceBasicSchema = z.object({
  instanceId: z.string(),
  name: z.string().optional(),
  instanceType: z.string().optional(),
  state: z.string().optional(),
  launchTime: z.string().optional(),
  availabilityZone: z.string().optional(),
});

const listEc2InstancesOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  states: z.array(z.string()),
  instances: z.array(ec2InstanceBasicSchema),
});

const detectIdleEc2InputSchema = z.object({
  lookbackDays: z.number().int().min(1).max(30).optional().default(7),
  maxInstances: z.number().int().min(1).max(200).optional().default(50),
});

const idleInstanceSchema = z.object({
  instanceId: z.string(),
  name: z.string().optional(),
  instanceType: z.string().optional(),
  state: z.string().optional(),
  launchTime: z.string().optional(),
  availabilityZone: z.string().optional(),

  cpuAvg: z.number().optional(),
  netInBytesTotal: z.number().optional(),
  netOutBytesTotal: z.number().optional(),

  dataPointsCpu: z.number().int().optional(),
  dataPointsNetIn: z.number().int().optional(),
  dataPointsNetOut: z.number().int().optional(),

  idle: z.boolean(),
  confidence: z.enum(["HIGH", "MEDIUM", "LOW"]),
  reason: z.array(z.string()),
});

const detectIdleEc2OutputSchema = z.object({
  scanned: z.number().int().nonnegative(),
  candidates: z.array(idleInstanceSchema),
});

// ----------------------------
// Friendly Error Messages
// ----------------------------

function formatAwsErrorMessage(error: any): string {
  const errorCode = error?.name || error?.Code || error?.code;
  const httpStatusCode = error?.$metadata?.httpStatusCode;

  if (errorCode === "AccessDenied" || httpStatusCode === 403) {
    return "AWS denied the request (AccessDenied). This usually means the IAM user is missing a required permission.";
  }

  if (errorCode === "NoSuchKey") {
    return "That file key does not exist. Tell me the folder/prefix and I can list files to help you find it.";
  }

  if (errorCode === "NoSuchBucket") {
    return `That bucket does not exist or is not accessible. This agent is hard-locked to the bucket '${allowedBucketName}'.`;
  }

  if (errorCode === "PermanentRedirect" || httpStatusCode === 301) {
    return "AWS says this bucket must be accessed using a different regional endpoint. Double-check the bucket region matches AWS_REGION.";
  }

  return `AWS error: ${errorCode ?? "UnknownError"}`;
}

// ----------------------------
// Daemo Tools
// ----------------------------

export class AwsFunctions {
  @DaemoFunction({
    description:
      "Lists file keys in the agent’s S3 bucket (daemo-agent-s3-darrell). Optionally provide a prefix like 'logs/' and a limit.",
    inputSchema: listFilesInputSchema,
    outputSchema: listFilesOutputSchema,
  })
  async listFiles(
    args: z.infer<typeof listFilesInputSchema>
  ): Promise<z.infer<typeof listFilesOutputSchema>> {
    const { prefix, limit } = args;

    try {
      const keys = await listS3Objects(allowedBucketName, prefix, limit);
      return { bucket: allowedBucketName, prefix, count: keys.length, keys };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Reads a small text file (<=1MB) from the agent’s S3 bucket by key.",
    inputSchema: readTextInputSchema,
    outputSchema: readTextOutputSchema,
  })
  async readTextFile(
    args: z.infer<typeof readTextInputSchema>
  ): Promise<z.infer<typeof readTextOutputSchema>> {
    const { key } = args;

    try {
      return await getTextObject(allowedBucketName, key);
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Writes a small text file (<=1MB) to the agent’s S3 bucket at the given key.",
    inputSchema: writeTextInputSchema,
    outputSchema: writeTextOutputSchema,
  })
  async writeTextFile(
    args: z.infer<typeof writeTextInputSchema>
  ): Promise<z.infer<typeof writeTextOutputSchema>> {
    const { key, content, contentType } = args;

    try {
      const etag = await putTextObject(allowedBucketName, key, content, contentType);
      return { bucket: allowedBucketName, key, etag };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Creates a temporary download link (presigned URL) for a file in the agent’s S3 bucket.",
    inputSchema: presignDownloadInputSchema,
    outputSchema: presignDownloadOutputSchema,
  })
  async presignDownload(
    args: z.infer<typeof presignDownloadInputSchema>
  ): Promise<z.infer<typeof presignDownloadOutputSchema>> {
    const { key, expiresInSeconds } = args;

    try {
      const url = await createPresignedGetUrl(allowedBucketName, key, expiresInSeconds);
      return { url, expiresInSeconds };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Finds older files in the agent’s S3 bucket using LastModified, with optional prefix, age, and size filters.",
    inputSchema: findOldFilesInputSchema,
    outputSchema: findOldFilesOutputSchema,
  })
  async findOldFiles(
    args: z.infer<typeof findOldFilesInputSchema>
  ): Promise<z.infer<typeof findOldFilesOutputSchema>> {
    const { prefix, olderThanDays, minSizeBytes, maxResults } = args;

    // Internal safety caps (keeps the tool conversational and fast).
    const pageSize = 250;
    const maxTotalObjects = 5000;

    try {
      const result = await findOldObjects(
        allowedBucketName,
        prefix,
        olderThanDays,
        minSizeBytes,
        pageSize,
        maxTotalObjects
      );

      const objects = result.objects.slice(0, maxResults);
      const totalBytes = objects.reduce((sum, item) => sum + item.size, 0);

      return {
        bucket: allowedBucketName,
        prefix,
        olderThanDays,
        scanned: result.scanned,
        truncated: result.truncated,
        resultCount: objects.length,
        totalBytes,
        objects,
      };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Lists EC2 instances (basic info only). Use this when the user asks what EC2s exist or what is running. This does NOT perform idle detection.",
    inputSchema: listEc2InstancesInputSchema,
    outputSchema: listEc2InstancesOutputSchema,
  })
  async listEc2Instances(
    args: z.infer<typeof listEc2InstancesInputSchema>
  ): Promise<z.infer<typeof listEc2InstancesOutputSchema>> {
    const { maxInstances, states } = args;

    try {
      const instances = await listEc2InstancesSimple(maxInstances, states);
      return { count: instances.length, states, instances };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Detects likely-idle running EC2 instances over a lookback window. Returns stop candidates with evidence.",
    inputSchema: detectIdleEc2InputSchema,
    outputSchema: detectIdleEc2OutputSchema,
  })
  async detectIdleEc2(
    args: z.infer<typeof detectIdleEc2InputSchema>
  ): Promise<z.infer<typeof detectIdleEc2OutputSchema>> {
    const { lookbackDays, maxInstances } = args;

    // Keep these internal to reduce LLM confusion during conversation.
    const periodSeconds = 3600;
    const cpuThresholdPct = 2;
    const netTotalThresholdBytes = 50 * 1024 * 1024;
    const minDataPoints = 24;
    const excludeTagKeys = ["DoNotStop", "Critical"];

    try {
      const instances: ec2InstanceSummary[] = await listRunningInstancesCapped(maxInstances);
      const instanceIds = instances.map((instance) => instance.instanceId);

      const metricsByInstanceId = await getIdleMetricsForInstances(
        instanceIds,
        lookbackDays,
        periodSeconds
      );

      const candidates: idleCandidate[] = instances.map((instance) =>
        classifyIdle(
          instance,
          metricsByInstanceId[instance.instanceId] ?? {},
          cpuThresholdPct,
          netTotalThresholdBytes,
          minDataPoints,
          excludeTagKeys
        )
      );

      // Sort: idle first, then higher confidence, then lower CPU, then lower network.
      candidates.sort((a, b) => {
        if (a.idle !== b.idle) return a.idle ? -1 : 1;

        const confidenceRank = (value: string) =>
          value === "HIGH" ? 0 : value === "MEDIUM" ? 1 : 2;

        const rankDiff = confidenceRank(a.confidence) - confidenceRank(b.confidence);
        if (rankDiff !== 0) return rankDiff;

        const aCpu = a.cpuAvg ?? Number.POSITIVE_INFINITY;
        const bCpu = b.cpuAvg ?? Number.POSITIVE_INFINITY;
        if (aCpu !== bCpu) return aCpu - bCpu;

        const aNet = (a.netInBytesTotal ?? 0) + (a.netOutBytesTotal ?? 0);
        const bNet = (b.netInBytesTotal ?? 0) + (b.netOutBytesTotal ?? 0);
        return aNet - bNet;
      });

      return { scanned: candidates.length, candidates };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }
}
