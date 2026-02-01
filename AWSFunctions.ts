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

import {
  listRdsInstancesSimple,
  getRdsInstanceDetails,
  listRdsSnapshotsSimple,
  type rdsInstanceSummary,
  type rdsInstanceDetails,
  type rdsSnapshotSummary,
} from "./awsRds.js";
import { queryMysqlRds, type rdsQueryResult } from "./awsRdsQuery.js";
import { getRdsCpuUtilization, type rdsCpuMetrics } from "./awsRdsMetrics.js";

const defaultBucketName = "daemo-agent-s3-darrell";
const allowedBuckets = (process.env.ALLOWED_BUCKETS ?? defaultBucketName)
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);

function resolveBucket(requestedBucket?: string): string {
  const bucket = (requestedBucket ?? allowedBuckets[0] ?? defaultBucketName).trim();
  if (!allowedBuckets.includes(bucket)) {
    throw new Error(`BucketNotAllowed:${bucket}`);
  }
  return bucket;
}

// ----------------------------
// S3 Schemas
// ----------------------------

const listFilesInputSchema = z.object({
  bucket: z.string().optional(),
  prefix: z.string().optional().default(""),
  limit: z.number().int().min(1).max(1000).optional().default(20),
});

const listFilesOutputSchema = z.object({
  bucket: z.string(),
  prefix: z.string(),
  count: z.number().int().nonnegative(),
  keys: z.array(z.string()),
});

const emptyInputSchema = z.object({});

const listBucketsOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  buckets: z.array(z.string()),
});

const readTextInputSchema = z.object({
  bucket: z.string().optional(),
  key: z.string().min(1),
});

const readTextOutputSchema = z.object({
  bucket: z.string(),
  key: z.string(),
  content: z.string(),
  contentType: z.string().optional(),
});

const writeTextInputSchema = z.object({
  bucket: z.string().optional(),
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
  bucket: z.string().optional(),
  key: z.string().min(1),
  expiresInSeconds: z.number().int().min(60).max(3600).optional().default(900),
});

const presignDownloadOutputSchema = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int(),
});

const findOldFilesInputSchema = z.object({
  bucket: z.string().optional(),
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
// RDS Schemas
// ----------------------------

const listRdsInstancesInputSchema = z.object({
  maxInstances: z.number().int().min(1).max(100).optional().default(50),
});

const rdsInstanceSummarySchema = z.object({
  dbInstanceIdentifier: z.string(),
  engine: z.string().optional(),
  engineVersion: z.string().optional(),
  instanceClass: z.string().optional(),
  status: z.string().optional(),
  endpointAddress: z.string().optional(),
  endpointPort: z.number().int().optional(),
  availabilityZone: z.string().optional(),
  publiclyAccessible: z.boolean().optional(),
  storageEncrypted: z.boolean().optional(),
  multiAz: z.boolean().optional(),
  allocatedStorageGb: z.number().int().optional(),
  dbName: z.string().optional(),
});

const listRdsInstancesOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  instances: z.array(rdsInstanceSummarySchema),
});

const getRdsInstanceInputSchema = z.object({
  dbInstanceIdentifier: z.string().min(1),
});

const rdsInstanceDetailsSchema = rdsInstanceSummarySchema.extend({
  arn: z.string().optional(),
  masterUsername: z.string().optional(),
  vpcId: z.string().optional(),
  subnetGroupName: z.string().optional(),
  preferredMaintenanceWindow: z.string().optional(),
  preferredBackupWindow: z.string().optional(),
  backupRetentionPeriodDays: z.number().int().optional(),
});

const getRdsInstanceOutputSchema = rdsInstanceDetailsSchema;

const listRdsSnapshotsInputSchema = z.object({
  dbInstanceIdentifier: z.string().min(1).optional(),
  maxSnapshots: z.number().int().min(1).max(100).optional().default(50),
});

const rdsSnapshotSummarySchema = z.object({
  snapshotIdentifier: z.string().optional(),
  dbInstanceIdentifier: z.string().optional(),
  status: z.string().optional(),
  snapshotType: z.string().optional(),
  engine: z.string().optional(),
  snapshotCreateTime: z.string().optional(),
  allocatedStorageGb: z.number().int().optional(),
});

const listRdsSnapshotsOutputSchema = z.object({
  count: z.number().int().nonnegative(),
  dbInstanceIdentifier: z.string().optional(),
  snapshots: z.array(rdsSnapshotSummarySchema),
});

const rdsCpuInputSchema = z.object({
  dbInstanceIdentifier: z.string().min(1),
  lookbackHours: z.number().int().min(1).max(168).optional().default(6),
  periodSeconds: z.number().int().min(60).max(3600).optional().default(300),
});

const rdsCpuOutputSchema = z.object({
  dbInstanceIdentifier: z.string(),
  periodSeconds: z.number().int(),
  datapoints: z.number().int().nonnegative(),
  average: z.number().optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  latestTimestamp: z.string().optional(),
  latestAverage: z.number().optional(),
});

const queryRdsInputSchema = z.object({
  sql: z.string().min(1),
  maxRows: z.number().int().min(1).max(500).optional().default(100),
});

const queryRdsOutputSchema = z.object({
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  rows: z.array(z.record(z.any())),
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
    return `That bucket does not exist or is not accessible. Allowed buckets: ${allowedBuckets.join(
      ", "
    )}.`;
  }

  if (errorCode === "BucketNotAllowed") {
    const requested = String(error?.message || "").split(":")[1] || "unknown";
    return `Bucket '${requested}' is not allowed. Allowed buckets: ${allowedBuckets.join(", ")}.`;
  }

  if (errorCode === "DBInstanceNotFound") {
    return "That RDS instance identifier does not exist or is not accessible.";
  }

  if (errorCode === "DBSnapshotNotFound") {
    return "That RDS snapshot identifier does not exist or is not accessible.";
  }

  if (errorCode === "ER_ACCESS_DENIED_ERROR") {
    return "MySQL access denied. Check RDS_USER and RDS_PASSWORD.";
  }

  if (errorCode === "ER_BAD_DB_ERROR") {
    return "Unknown database. Check RDS_DB or remove it to use the default.";
  }

  if (errorCode === "ENOTFOUND") {
    return "RDS host not found. Check RDS_HOST and the instance endpoint.";
  }

  if (errorCode === "ECONNREFUSED") {
    return "Connection refused. Check the RDS security group inbound rule for port 3306.";
  }

  if (errorCode === "ETIMEDOUT") {
    return "Connection timed out. The RDS instance may not be reachable from this network/VPC.";
  }

  if (errorCode === "EHOSTUNREACH") {
    return "Host unreachable. The RDS instance may be in a private VPC.";
  }

  if (errorCode === "OnlyReadQueriesAllowed") {
    return "Only read-only SQL queries are allowed (SELECT/SHOW/DESCRIBE).";
  }

  if (errorCode === "Missing RDS_HOST") {
    return "Missing RDS_HOST environment variable.";
  }

  if (errorCode === "Missing RDS_USER") {
    return "Missing RDS_USER environment variable.";
  }

  if (errorCode === "Missing RDS_PASSWORD") {
    return "Missing RDS_PASSWORD environment variable.";
  }

  if (errorCode === "PermanentRedirect" || httpStatusCode === 301) {
    return "AWS says this bucket must be accessed using a different regional endpoint. Double-check the bucket region matches AWS_REGION.";
  }

  if (error?.message && error?.message !== "Error") {
    return error.message;
  }

  return `AWS error: ${errorCode ?? "UnknownError"}`;
}

// ----------------------------
// Daemo Tools
// ----------------------------

export class AwsFunctions {
  @DaemoFunction({
    description:
      "Lists the S3 buckets this agent is allowed to access (configured via ALLOWED_BUCKETS).",
    inputSchema: emptyInputSchema,
    outputSchema: listBucketsOutputSchema,
  })
  async listAllowedBuckets(): Promise<z.infer<typeof listBucketsOutputSchema>> {
    return {
      count: allowedBuckets.length,
      buckets: allowedBuckets,
    };
  }

  @DaemoFunction({
    description:
      "Lists file keys in an allowed S3 bucket. Optionally provide bucket, prefix like 'logs/', and a limit.",
    inputSchema: listFilesInputSchema,
    outputSchema: listFilesOutputSchema,
  })
  async listFiles(
    args: z.infer<typeof listFilesInputSchema>
  ): Promise<z.infer<typeof listFilesOutputSchema>> {
    const { bucket: requestedBucket, prefix, limit } = args;

    try {
      const bucket = resolveBucket(requestedBucket);
      const keys = await listS3Objects(bucket, prefix, limit);
      return { bucket, prefix, count: keys.length, keys };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Reads a small text file (<=1MB) from an allowed S3 bucket by key.",
    inputSchema: readTextInputSchema,
    outputSchema: readTextOutputSchema,
  })
  async readTextFile(
    args: z.infer<typeof readTextInputSchema>
  ): Promise<z.infer<typeof readTextOutputSchema>> {
    const { bucket: requestedBucket, key } = args;

    try {
      const bucket = resolveBucket(requestedBucket);
      return await getTextObject(bucket, key);
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Writes a small text file (<=1MB) to an allowed S3 bucket at the given key.",
    inputSchema: writeTextInputSchema,
    outputSchema: writeTextOutputSchema,
  })
  async writeTextFile(
    args: z.infer<typeof writeTextInputSchema>
  ): Promise<z.infer<typeof writeTextOutputSchema>> {
    const { bucket: requestedBucket, key, content, contentType } = args;

    try {
      const bucket = resolveBucket(requestedBucket);
      const etag = await putTextObject(bucket, key, content, contentType);
      return { bucket, key, etag };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Creates a temporary download link (presigned URL) for a file in an allowed S3 bucket.",
    inputSchema: presignDownloadInputSchema,
    outputSchema: presignDownloadOutputSchema,
  })
  async presignDownload(
    args: z.infer<typeof presignDownloadInputSchema>
  ): Promise<z.infer<typeof presignDownloadOutputSchema>> {
    const { bucket: requestedBucket, key, expiresInSeconds } = args;

    try {
      const bucket = resolveBucket(requestedBucket);
      const url = await createPresignedGetUrl(bucket, key, expiresInSeconds);
      return { url, expiresInSeconds };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Finds older files in an allowed S3 bucket using LastModified, with optional bucket, prefix, age, and size filters.",
    inputSchema: findOldFilesInputSchema,
    outputSchema: findOldFilesOutputSchema,
  })
  async findOldFiles(
    args: z.infer<typeof findOldFilesInputSchema>
  ): Promise<z.infer<typeof findOldFilesOutputSchema>> {
    const { bucket: requestedBucket, prefix, olderThanDays, minSizeBytes, maxResults } = args;

    // Internal safety caps (keeps the tool conversational and fast).
    const pageSize = 250;
    const maxTotalObjects = 5000;

    try {
      const bucket = resolveBucket(requestedBucket);
      const result = await findOldObjects(
        bucket,
        prefix,
        olderThanDays,
        minSizeBytes,
        pageSize,
        maxTotalObjects
      );

      const objects = result.objects.slice(0, maxResults);
      const totalBytes = objects.reduce((sum, item) => sum + item.size, 0);

      return {
        bucket,
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

  @DaemoFunction({
    description:
      "Lists RDS DB instances (basic info). Use when the user asks what databases exist or are available.",
    inputSchema: listRdsInstancesInputSchema,
    outputSchema: listRdsInstancesOutputSchema,
  })
  async listRdsInstances(
    args: z.infer<typeof listRdsInstancesInputSchema>
  ): Promise<z.infer<typeof listRdsInstancesOutputSchema>> {
    const { maxInstances } = args;

    try {
      const instances: rdsInstanceSummary[] = await listRdsInstancesSimple(maxInstances);
      return { count: instances.length, instances };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Gets details for a specific RDS DB instance by identifier.",
    inputSchema: getRdsInstanceInputSchema,
    outputSchema: getRdsInstanceOutputSchema,
  })
  async getRdsInstance(
    args: z.infer<typeof getRdsInstanceInputSchema>
  ): Promise<z.infer<typeof getRdsInstanceOutputSchema>> {
    const { dbInstanceIdentifier } = args;

    try {
      const details: rdsInstanceDetails = await getRdsInstanceDetails(dbInstanceIdentifier);
      return details;
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Lists RDS DB snapshots, optionally filtered by instance identifier.",
    inputSchema: listRdsSnapshotsInputSchema,
    outputSchema: listRdsSnapshotsOutputSchema,
  })
  async listRdsSnapshots(
    args: z.infer<typeof listRdsSnapshotsInputSchema>
  ): Promise<z.infer<typeof listRdsSnapshotsOutputSchema>> {
    const { dbInstanceIdentifier, maxSnapshots } = args;

    try {
      const snapshots: rdsSnapshotSummary[] = await listRdsSnapshotsSimple(
        dbInstanceIdentifier,
        maxSnapshots
      );
      return { count: snapshots.length, dbInstanceIdentifier, snapshots };
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Runs a read-only SQL query (SELECT/SHOW/DESCRIBE) against the configured MySQL RDS instance.",
    inputSchema: queryRdsInputSchema,
    outputSchema: queryRdsOutputSchema,
  })
  async queryRdsDatabase(
    args: z.infer<typeof queryRdsInputSchema>
  ): Promise<z.infer<typeof queryRdsOutputSchema>> {
    const { sql, maxRows } = args;

    try {
      const result: rdsQueryResult = await queryMysqlRds(sql, maxRows);
      return result;
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }

  @DaemoFunction({
    description:
      "Gets RDS CPU utilization from CloudWatch for a DB instance over a lookback window.",
    inputSchema: rdsCpuInputSchema,
    outputSchema: rdsCpuOutputSchema,
  })
  async getRdsCpuUtilization(
    args: z.infer<typeof rdsCpuInputSchema>
  ): Promise<z.infer<typeof rdsCpuOutputSchema>> {
    const { dbInstanceIdentifier, lookbackHours, periodSeconds } = args;

    try {
      const metrics: rdsCpuMetrics = await getRdsCpuUtilization(
        dbInstanceIdentifier,
        lookbackHours,
        periodSeconds
      );
      return metrics;
    } catch (error: any) {
      throw new Error(formatAwsErrorMessage(error));
    }
  }
}
