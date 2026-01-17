import {
  S3Client,
  ListObjectsV2Command,
  type ListObjectsV2CommandOutput,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getRegion(): string {
  const region = process.env.AWS_REGION; // note: Auth is done all through .env
  if (!region) throw new Error("Missing AWS_REGION in environment");
  return region;
}

const s3 = new S3Client({ region: getRegion() });

// 1 MB max object size 
const MAX_OBJECT_BYTES = 1 * 1024 * 1024;

function assertMaxObjectSizeBytes(sizeBytes: number, key: string) {
  if (sizeBytes > MAX_OBJECT_BYTES) {
    throw new Error(
      `S3 object too large for key="${key}". Size=${sizeBytes} bytes. Max=${MAX_OBJECT_BYTES} bytes (1MB).`
    );
  }
}

export type S3ObjectMeta = {
  key: string;
  size: number; // bytes
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

function toIso(d?: Date): string | undefined {
  return d ? d.toISOString() : undefined;
}

export async function listS3ObjectsWithMetaCapped(
  bucket: string,
  prefix: string,
  pageSize: number,
  maxTotalObjects: number
): Promise<{ items: S3ObjectMeta[]; truncated: boolean }> {
  const items: S3ObjectMeta[] = [];
  let continuationToken: string | undefined = undefined;

  while (items.length < maxTotalObjects) {
    const remaining = maxTotalObjects - items.length;
    const maxKeysThisPage = Math.min(pageSize, remaining);

    const cmd = new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix || undefined,
      MaxKeys: maxKeysThisPage,
      ContinuationToken: continuationToken,
    });

    const resp = (await s3.send(cmd)) as ListObjectsV2CommandOutput;

    const pageItems: S3ObjectMeta[] = (resp.Contents ?? [])
      .map((o): S3ObjectMeta => ({
        key: o.Key ?? "",
        size: typeof o.Size === "number" ? o.Size : 0,
        lastModified: toIso(o.LastModified),
        storageClass: o.StorageClass,
      }))
      .filter((x): x is S3ObjectMeta => x.key.length > 0);

    items.push(...pageItems);

    if (!resp.IsTruncated) return { items, truncated: false };

    continuationToken = resp.NextContinuationToken;
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

  for (const it of items) {
    if (it.size < minSizeBytes) continue;
    if (!it.lastModified) continue;

    const lmMs = new Date(it.lastModified).getTime();
    if (!Number.isFinite(lmMs)) continue;

    const ageMs = nowMs - lmMs;
    if (ageMs < cutoffMs) continue;

    objects.push({
      key: it.key,
      size: it.size,
      lastModified: it.lastModified,
      ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      storageClass: it.storageClass,
    });
  }

  // biggest first
  objects.sort((a, b) => b.size - a.size);

  return { objects, scanned: items.length, truncated };
}

export async function listS3Objects(
  bucket: string,
  prefix: string,
  maxKeys: number
): Promise<string[]> {
  const cmd = new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix || undefined,
    MaxKeys: maxKeys,
  });

  const resp = (await s3.send(cmd)) as ListObjectsV2CommandOutput;

  const keys = (resp.Contents ?? [])
    .map((o) => o.Key)
    .filter((k): k is string => typeof k === "string");

  return keys;
}

export async function createPresignedGetUrl(
  bucket: string,
  key: string,
  expiresInSeconds: number
): Promise<string> {
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: key });
  return await getSignedUrl(s3, cmd, { expiresIn: expiresInSeconds });
}

export async function putTextObject(
  bucket: string,
  key: string,
  content: string,
  contentType: string
): Promise<string | undefined> {
  // Enforce max size before uploading. this is for me due to limited AWS credits
  const sizeBytes = Buffer.byteLength(content, "utf8");
  assertMaxObjectSizeBytes(sizeBytes, key);

  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: contentType,
  });

  const resp = await s3.send(cmd);
  return resp.ETag;
}



