import { S3Client } from "@aws-sdk/client-s3";

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_BUCKET = process.env.S3_BUCKET ?? "pear-attachments";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;

export function isS3Configured(): boolean {
  return !!(
    S3_ENDPOINT &&
    S3_ACCESS_KEY &&
    S3_SECRET_KEY
  );
}

export function getS3Bucket(): string {
  return S3_BUCKET;
}

/** S3 client configured for MinIO or any S3-compatible backend. */
export function getS3Client(): S3Client {
  if (!isS3Configured()) {
    throw new Error("S3 is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY.");
  }
  return new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY!,
      secretAccessKey: S3_SECRET_KEY!,
    },
    forcePathStyle: true, // required for MinIO
  });
}
