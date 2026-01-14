import "reflect-metadata";
import { DaemoFunction } from "daemo-engine";
import { z } from "zod";
import {
  listS3Objects,
  createPresignedGetUrl,
  putTextObject,
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
}


















