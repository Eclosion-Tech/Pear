/**
 * Worker-side S3/MinIO access — mirrors the web service's config (`web/src/lib/s3.ts`):
 * same `S3_*` env vars, path-style addressing for MinIO. Used to fetch image
 * attachment bytes so they can be handed to any AI provider as base64 (the
 * worker never exposes S3 URLs to providers).
 */

import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const S3_ENDPOINT = process.env.S3_ENDPOINT;
const S3_BUCKET = process.env.S3_BUCKET ?? "pear-attachments";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;

export function isS3Configured(): boolean {
  return !!(S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY);
}

let client: S3Client | undefined;

function getS3Client(): S3Client {
  if (!isS3Configured()) {
    throw new Error("S3 is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY.");
  }
  client ??= new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY!,
      secretAccessKey: S3_SECRET_KEY!,
    },
    forcePathStyle: true, // required for Garage (and MinIO-era deployments)
    // Match web/src/lib/s3.ts: strict stores (Garage) reject the SDK's
    // default flexible-checksum injection.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
  });
  return client;
}

/** Fetch an object's bytes as base64. Throws if S3 is unconfigured or the object is missing. */
export async function fetchObjectBase64(objectKey: string): Promise<string> {
  const res = await getS3Client().send(
    new GetObjectCommand({ Bucket: S3_BUCKET, Key: objectKey }),
  );
  if (!res.Body) {
    throw new Error(`S3 object "${objectKey}" has no body`);
  }
  const bytes = await res.Body.transformToByteArray();
  return Buffer.from(bytes).toString("base64");
}
