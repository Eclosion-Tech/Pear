import { NextRequest, NextResponse } from "next/server";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { getS3Client, getS3Bucket, isS3Configured } from "@/src/lib/s3";

/**
 * GET /api/upload/url?key=storageKey
 * Returns a temporary presigned GET URL so the client can display or download the file.
 */
export async function GET(request: NextRequest) {
  if (!isS3Configured()) {
    return NextResponse.json(
      { error: "Upload is not configured. Set S3_* environment variables." },
      { status: 503 }
    );
  }

  const key = request.nextUrl.searchParams.get("key");
  if (!key || !key.startsWith("pages/")) {
    return NextResponse.json(
      { error: "Query parameter 'key' (storage key) is required and must start with pages/" },
      { status: 400 }
    );
  }

  const client = getS3Client();
  const bucket = getS3Bucket();

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
  });

  let getUrl: string;
  try {
    getUrl = await getSignedUrl(client, command, { expiresIn: 3600 }); // 1 hour
  } catch (err) {
    console.error("[upload/url] presign error:", err);
    return NextResponse.json(
      { error: "Failed to generate download URL" },
      { status: 500 }
    );
  }

  return NextResponse.json({ getUrl });
}
