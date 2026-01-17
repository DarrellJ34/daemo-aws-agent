import "reflect-metadata";
import { DaemoFunction } from "daemo-engine";
import { z } from "zod";
import {
  listS3Objects,
  createPresignedGetUrl,
  putTextObject,
  findOldObjects,
} from "./awsS3";

const ListObjectsInput = z.object({
  bucket: z.string().min(3),
  prefix: z.string().optional().default(""),
  maxKeys: z.number().int().min(1).max(50).optional().default(20),
});

const ListObjectsOutput = z.object({
  bucket: z.string(),
  prefix: z.string(),
  count: z.number().int().nonnegative(),
  keys: z.array(z.string()),
});

const PresignInput = z.object({
  bucket: z.string().min(3),
  key: z.string().min(1),
  expiresInSeconds: z.number().int().min(60).max(3600).optional().default(900),
});

const PresignOutput = z.object({
  url: z.string().url(),
  expiresInSeconds: z.number().int(),
});

const PutTextInput = z.object({
  bucket: z.string().min(3),
  key: z.string().min(1),
  content: z.string().min(1),
  contentType: z.string().optional().default("text/plain"),
});

const PutTextOutput = z.object({
  bucket: z.string(),
  key: z.string(),
  etag: z.string().optional(),
});

const FindOldFilesInput = z.object({
  bucket: z.string().min(3),
  prefix: z.string().optional().default(""),

  olderThanDays: z.number().int().min(1).max(3650).optional().default(180),

  minSizeBytes: z.number().int().min(0).optional().default(1024),

  pageSize: z.number().int().min(1).max(1000).optional().default(250),
  maxTotalObjects: z.number().int().min(1).max(20000).optional().default(5000),

  maxResults: z.number().int().min(1).max(500).optional().default(100),
});

const OldObjectSchema = z.object({
  key: z.string(),
  size: z.number().int().nonnegative(),
  lastModified: z.string().optional(),
  ageDays: z.number().int().optional(),
  storageClass: z.string().optional(),
});

const FindOldFilesOutput = z.object({
  bucket: z.string(),
  prefix: z.string(),
  olderThanDays: z.number().int(),

  scanned: z.number().int().nonnegative(),
  truncated: z.boolean(),

  resultCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),

  objects: z.array(OldObjectSchema),
});

export class AwsFunctions {
  @DaemoFunction({
    description:
      "Lists object keys in an S3 bucket. Optionally filter by prefix (like a folder).",
    inputSchema: ListObjectsInput,
    outputSchema: ListObjectsOutput,
  })
  async listS3Objects(
    args: z.infer<typeof ListObjectsInput>
  ): Promise<z.infer<typeof ListObjectsOutput>> {
    const { bucket, prefix, maxKeys } = args;
    const keys = await listS3Objects(bucket, prefix, maxKeys);

    return {
      bucket,
      prefix,
      count: keys.length,
      keys,
    };
  }

  @DaemoFunction({
    description:
      "Generates a presigned URL to download an S3 object (temporary link).",
    inputSchema: PresignInput,
    outputSchema: PresignOutput,
  })
  async presignDownloadUrl(
    args: z.infer<typeof PresignInput>
  ): Promise<z.infer<typeof PresignOutput>> {
    const { bucket, key, expiresInSeconds } = args;
    const url = await createPresignedGetUrl(bucket, key, expiresInSeconds);

    return { url, expiresInSeconds };
  }

  @DaemoFunction({
    description:
      "Uploads a text object to S3 at the given key. Useful for quick demos and notes/logs.",
    inputSchema: PutTextInput,
    outputSchema: PutTextOutput,
  })
  async putTextObject(
    args: z.infer<typeof PutTextInput>
  ): Promise<z.infer<typeof PutTextOutput>> {
    const { bucket, key, content, contentType } = args;
    const etag = await putTextObject(bucket, key, content, contentType);

    return { bucket, key, etag };
  }

  @DaemoFunction({ // note, S3 uses last modified, not last accessed
    description:
      "Finds S3 objects older than N days using LastModified. Results are capped and sorted by size (largest first).",
    inputSchema: FindOldFilesInput,
    outputSchema: FindOldFilesOutput,
  })
  async findOldFiles(
    args: z.infer<typeof FindOldFilesInput>
  ): Promise<z.infer<typeof FindOldFilesOutput>> {
    const {
      bucket,
      prefix,
      olderThanDays,
      minSizeBytes,
      pageSize,
      maxTotalObjects,
      maxResults,
    } = args;

    const result = await findOldObjects(
      bucket,
      prefix,
      olderThanDays,
      minSizeBytes,
      pageSize,
      maxTotalObjects
    );

    const objects = result.objects.slice(0, maxResults);
    const totalBytes = objects.reduce((sum, o) => sum + o.size, 0);

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
  }
}



















