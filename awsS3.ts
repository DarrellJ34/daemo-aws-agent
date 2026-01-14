import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

function getRegion(): string {
  const region = process.env.AWS_REGION;
  if (!region) throw new Error("Missing AWS_REGION in environment");
  return region;
}

const s3 = new S3Client({ region: getRegion() });

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

  const resp = await s3.send(cmd);
  const keys = (resp.Contents ?? [])
    .map(o => o.Key)
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
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: content,
    ContentType: contentType,
  });

  const resp = await s3.send(cmd);
  return resp.ETag;
}
