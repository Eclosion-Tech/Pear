import { NextResponse } from "next/server";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  getS3PresigningClient,
  getS3Bucket,
  isS3Configured,
  derivePublicS3EndpointFromRequest,
} from "@/src/lib/s3";

/** Sanitize filename to a safe extension (e.g. ".png") or default. */
function getExtension(filename: string): string {
  const last = filename.split("/").pop() ?? "";
  const idx = last.lastIndexOf(".");
  if (idx <= 0) return "";
  const ext = last.slice(idx).toLowerCase();
  if (/^\.([a-z0-9]+)$/.test(ext)) return ext;
  return "";
}

export async function POST(request: Request) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Upload is not configured. Set S3_* environment variables." },
      { status: 503 }
    );
  }

  let body: { pageId?: string; filename?: string; contentType?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
  const filename = typeof body.filename === "string" ? body.filename.trim() : "";
  const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "application/octet-stream";

  if (!pageId || !filename) {
    return NextResponse.json(
      { error: "pageId and filename are required" },
      { status: 400 }
    );
  }

  const ext = getExtension(filename) || ".bin";
  const storageKey = `pages/${pageId}/${crypto.randomUUID()}${ext}`;
  const bucket = getS3Bucket();

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: storageKey,
    ContentType: contentType,
  });

  const publicEndpoint = derivePublicS3EndpointFromRequest(request);

  let uploadUrl: string;
  try {
    const presigningClient = getS3PresigningClient(publicEndpoint);
    uploadUrl = await getSignedUrl(presigningClient, command, { expiresIn: 900 }); // 15 min
  } catch (err) {
    console.error("[upload/request] presign error:", err);
    return NextResponse.json(
      { error: "Failed to generate upload URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({ uploadUrl, storageKey });
}
