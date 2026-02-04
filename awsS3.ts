import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  GetObjectCommand,
  GetBucketLocationCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getRegion(): string {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("Missing AWS_REGION in environment");
  return region;
}

const s3Clients = new Map<string, S3Client>();
const bucketRegionCache = new Map<string, string>();

function getS3Client(region: string): S3Client {
  const cached = s3Clients.get(region);
  if (cached) return cached;

  const client = new S3Client({ region });
  s3Clients.set(region, client);
  return client;
}

function normalizeBucketRegion(region: string | undefined | null): string {
  if (!region) return "us-east-1";
  if (region === "EU") return "eu-west-1";
  return region;
}

async function getS3ClientForBucket(bucket: string): Promise<S3Client> {
  const cachedRegion = bucketRegionCache.get(bucket);
  if (cachedRegion) return getS3Client(cachedRegion);

  const defaultRegion = getRegion();
  const defaultClient = getS3Client(defaultRegion);

  try {
    const response = await defaultClient.send(
      new GetBucketLocationCommand({ Bucket: bucket })
    );

    const resolvedRegion = normalizeBucketRegion(response.LocationConstraint);
    bucketRegionCache.set(bucket, resolvedRegion);
    return getS3Client(resolvedRegion);
  } catch (error: any) {
    const headerRegion =
      error?.$metadata?.httpHeaders?.["x-amz-bucket-region"] ??
      error?.$response?.headers?.["x-amz-bucket-region"];
    if (headerRegion) {
      const resolvedRegion = normalizeBucketRegion(headerRegion);
      bucketRegionCache.set(bucket, resolvedRegion);
      return getS3Client(resolvedRegion);
    }

    return getS3Client(defaultRegion);
  }
}


export type S3ObjectMeta = {
  key: string;
  size: number;
  lastModified?: string;
  storageClass?: string;
};

export type OldObject = {
  key: string;
  size: number;
  lastModified?: string;
  ageDays?: number;
  storageClass?: string;
};

export type TextObject = {
  bucket: string;
  key: string;
  content: string;
  contentType?: string;
};

function toIso(date?: Date): string | undefined {
  return date ? date.toISOString() : undefined;
}

async function streamToString(body: any): Promise<string> {
  const chunks: Buffer[] = [];

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

export async function listS3Objects(
  bucket: string,
  prefix: string,
  maxKeys: number
): Promise<string[]> {
  const s3Client = await getS3ClientForBucket(bucket);
  const keys: string[] = [];
  let continuationToken: string | undefined = undefined;

  while (keys.length < maxKeys) {
    const remaining = maxKeys - keys.length;
    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: remaining,
      ContinuationToken: continuationToken,
    });

    const response = (await s3Client.send(command)) as ListObjectsV2CommandOutput;

    const pageKeys = (response.Contents ?? [])
      .map((item) => item.Key)
      .filter((key): key is string => typeof key === "string");

    keys.push(...pageKeys);

    if (!response.IsTruncated) break;
    continuationToken = response.NextContinuationToken;
    if (!continuationToken) break;
  }

  return keys.slice(0, maxKeys);
}

export async function createPresignedGetUrl(
  bucket: string,
  key: string,
  expiresInSeconds: number
): Promise<string> {
  const s3Client = await getS3ClientForBucket(bucket);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

export async function putTextObject(
  bucket: string,
  key: string,
  content: string,
  contentType?: string
): Promise<string | undefined> {
  const s3Client = await getS3ClientForBucket(bucket);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: contentType && contentType.trim().length > 0 ? contentType : undefined,
  });

  const response = await s3Client.send(command);
  return response.ETag;
}

export async function getTextObject(
  bucket: string,
  key: string
): Promise<TextObject> {
  const s3Client = await getS3ClientForBucket(bucket);
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  const body = response.Body;
  if (!body) {
    throw new Error(`S3 object had an empty body for key="${key}".`);
  }

  const content = await streamToString(body);

  return {
    bucket,
    key,
    content,
    contentType: response.ContentType,
  };
}

export async function listS3ObjectsWithMetaCapped(
  bucket: string,
  prefix: string,
  pageSize: number,
  maxTotalObjects: number
): Promise<{ items: S3ObjectMeta[]; truncated: boolean }> {
  const s3Client = await getS3ClientForBucket(bucket);
  const items: S3ObjectMeta[] = [];
  let continuationToken: string | undefined = undefined;

  while (items.length < maxTotalObjects) {
    const remaining = maxTotalObjects - items.length;
    const maxKeysThisPage = Math.min(pageSize, remaining);

    const command = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: maxKeysThisPage,
      ContinuationToken: continuationToken,
    });

    const response = (await s3Client.send(command)) as ListObjectsV2CommandOutput;

    const pageItems: S3ObjectMeta[] = (response.Contents ?? [])
      .map((item): S3ObjectMeta => ({
        key: item.Key ?? "",
        size: typeof item.Size === "number" ? item.Size : 0,
        lastModified: toIso(item.LastModified),
        storageClass: item.StorageClass,
      }))
      .filter((meta) => meta.key.length > 0);

    items.push(...pageItems);

    if (!response.IsTruncated) return { items, truncated: false };

    continuationToken = response.NextContinuationToken;
    if (!continuationToken) break;
  }

  return { items, truncated: true };
}

export async function findOldObjects(
  bucket: string,
  prefix: string,
  olderThanDays: number,
  minSizeBytes: number,
  pageSize: number,
  maxTotalObjects: number
): Promise<{ objects: OldObject[]; scanned: number; truncated: boolean }> {
  const { items, truncated } = await listS3ObjectsWithMetaCapped(
    bucket,
    prefix,
    pageSize,
    maxTotalObjects
  );

  const nowMs = Date.now();
  const cutoffMs = olderThanDays * 24 * 60 * 60 * 1000;

  const objects: OldObject[] = [];

  for (const item of items) {
    if (item.size < minSizeBytes) continue;
    if (!item.lastModified) continue;

    const lastModifiedMs = new Date(item.lastModified).getTime();
    if (!Number.isFinite(lastModifiedMs)) continue;

    const ageMs = nowMs - lastModifiedMs;
    if (ageMs < cutoffMs) continue;

    objects.push({
      key: item.key,
      size: item.size,
      lastModified: item.lastModified,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      storageClass: item.storageClass,
    });
  }

  // Sort biggest first so cleanup candidates are more useful
  objects.sort((a, b) => b.size - a.size);

  return { objects, scanned: items.length, truncated };
}
