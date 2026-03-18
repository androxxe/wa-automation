import { Client } from 'minio'
import type { Readable } from 'stream'

const MINIO_ENDPOINT  = process.env.MINIO_ENDPOINT ?? 'localhost'
const MINIO_PORT      = parseInt(process.env.MINIO_PORT ?? '9000', 10)
const MINIO_USE_SSL   = process.env.MINIO_USE_SSL === 'true'
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY ?? ''
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY ?? ''

export const MINIO_BUCKET = process.env.MINIO_BUCKET ?? 'whatsapp-automation'

export const minioClient = new Client({
  endPoint:  MINIO_ENDPOINT,
  port:      MINIO_PORT,
  useSSL:    MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY,
  secretKey: MINIO_SECRET_KEY,
})

/**
 * Ensure the bucket exists. Called once at startup.
 */
export async function ensureBucket(): Promise<void> {
  const exists = await minioClient.bucketExists(MINIO_BUCKET)
  if (!exists) {
    await minioClient.makeBucket(MINIO_BUCKET)
    console.log(`[minio] created bucket: ${MINIO_BUCKET}`)
  }
}

/**
 * Upload a buffer to MinIO and return the object key.
 */
export async function uploadBuffer(
  key:         string,
  buffer:      Buffer,
  contentType: string,
): Promise<string> {
  await minioClient.putObject(MINIO_BUCKET, key, buffer, buffer.length, {
    'Content-Type': contentType,
  })
  return key
}

/**
 * Generate a presigned GET URL for a MinIO object.
 * @param key     Object key in the bucket
 * @param expiry  Expiry in seconds (default 3600 = 1 hour)
 */
export async function presignedUrl(key: string, expiry = 3600): Promise<string> {
  return minioClient.presignedGetObject(MINIO_BUCKET, key, expiry)
}

/**
 * Read a MinIO object into a Buffer.
 */
export async function getBuffer(key: string): Promise<Buffer> {
  const stream: Readable = await minioClient.getObject(MINIO_BUCKET, key)
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/**
 * Check if a MinIO object exists.
 */
export async function objectExists(key: string): Promise<boolean> {
  try {
    await minioClient.statObject(MINIO_BUCKET, key)
    return true
  } catch {
    return false
  }
}
