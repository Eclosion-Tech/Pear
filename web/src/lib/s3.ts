import { S3Client } from "@aws-sdk/client-s3";

const S3_ENDPOINT = process.env.S3_ENDPOINT;
/** Optional override. If unset, presigned URLs use the request host + port 9000 (so browser uploads work with zero config when app and MinIO are on the same host). */
const S3_PUBLIC_ENDPOINT = process.env.S3_PUBLIC_ENDPOINT;
const S3_BUCKET = process.env.S3_BUCKET ?? "pear-attachments";
const S3_REGION = process.env.S3_REGION ?? "us-east-1";
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY;
const S3_SECRET_KEY = process.env.S3_SECRET_KEY;

/** Default MinIO port when deriving public URL from request host. */
export const S3_PUBLIC_DEFAULT_PORT = 9000;

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

/** Endpoint for presigning. Prefer override (e.g. derived from request), then S3_PUBLIC_ENDPOINT, then S3_ENDPOINT. */
function getPresigningEndpoint(override?: string): string {
  return override ?? S3_PUBLIC_ENDPOINT ?? S3_ENDPOINT!;
}

/** S3 client for server-side calls (e.g. GET in proxy). Uses S3_ENDPOINT (internal hostname OK). */
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

/** S3 client for generating presigned URLs. Pass endpointOverride (e.g. from request host + :9000) so the browser can reach the URL; if omitted, uses S3_PUBLIC_ENDPOINT or S3_ENDPOINT. */
export function getS3PresigningClient(endpointOverride?: string): S3Client {
  if (!isS3Configured()) {
    throw new Error("S3 is not configured. Set S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY.");
  }
  return new S3Client({
    endpoint: getPresigningEndpoint(endpointOverride),
    region: S3_REGION,
    credentials: {
      accessKeyId: S3_ACCESS_KEY!,
      secretAccessKey: S3_SECRET_KEY!,
    },
    forcePathStyle: true,
  });
}

/** Hostnames that are not reachable from the browser (internal Docker, etc.). */
const INTERNAL_HOST_PATTERN = /^(localhost|127\.0\.0\.1|[a-f0-9]{12})$|\.local$/i;

/**
 * Derive a browser-reachable MinIO URL from the request (same host, port 9000).
 * Uses Host or X-Forwarded-Host so it works when the app is in Docker and the
 * client connects via host IP. Ignores request.url which may be the internal
 * container URL (e.g. http://05e31a5cb840:3001). Returns undefined if the
 * host looks internal so caller can fall back to S3_PUBLIC_ENDPOINT.
 */
export function derivePublicS3EndpointFromRequest(request: Request): string | undefined {
  const hostHeader =
    request.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    request.headers.get("host");
  if (!hostHeader) return undefined;

  const hostname = hostHeader.split(":")[0]?.trim();
  if (!hostname || INTERNAL_HOST_PATTERN.test(hostname)) return undefined;

  const protocol =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "http";
  const scheme = protocol === "https" ? "https" : "http";
  return `${scheme}://${hostname}:${S3_PUBLIC_DEFAULT_PORT}`;
}
