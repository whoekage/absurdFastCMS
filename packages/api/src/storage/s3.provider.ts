import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { assertStorageKey, ObjectNotFoundError, type StorageProvider } from './provider.ts';

/**
 * be-04 MEDIA — the S3 storage provider over `@aws-sdk/client-s3`. The SAME code talks to real AWS S3
 * (no `endpoint`) OR any S3-compatible server (MinIO: `endpoint` + `forcePathStyle:true`) — which is what
 * lets the no-mock MinIO test (test/storage-s3.test.ts) exercise this exact class against a REAL server.
 *
 * SECRET HYGIENE: credentials are passed straight into the `S3Client` ctor and are NEVER copied,
 * cached, or logged here. The provider holds only the bucket + the client.
 */
export interface S3ProviderConfig {
  bucket: string;
  region: string;
  /** S3-compatible endpoint (MinIO / R2 / etc.); omit for real AWS S3. */
  endpoint?: string | undefined;
  accessKeyId: string;
  secretAccessKey: string;
  /** Path-style addressing (required for MinIO and most non-AWS S3 servers). */
  forcePathStyle: boolean;
  /** Optional CDN / public URL base (no trailing slash); else derived from endpoint or the AWS host. */
  publicBaseUrl?: string | undefined;
}

/** Whether an S3 SDK error means "no such key" (HeadObject 404 has no NoSuchKey code, only the metadata). */
function isNotFound(e: unknown): boolean {
  const err = e as { name?: string; $metadata?: { httpStatusCode?: number } };
  return err.name === 'NoSuchKey' || err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404;
}

export class S3StorageProvider implements StorageProvider {
  readonly name = 's3' as const;
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Pre-computed public URL prefix (no trailing slash). */
  private readonly publicPrefix: string;

  constructor(cfg: S3ProviderConfig) {
    this.bucket = cfg.bucket;
    const clientCfg: ConstructorParameters<typeof S3Client>[0] = {
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    };
    if (cfg.endpoint !== undefined) clientCfg.endpoint = cfg.endpoint;
    this.client = new S3Client(clientCfg);
    this.publicPrefix = this.derivePublicPrefix(cfg);
  }

  /** Build the URL prefix once: explicit CDN base > path-style endpoint/bucket > virtual-hosted AWS host. */
  private derivePublicPrefix(cfg: S3ProviderConfig): string {
    if (cfg.publicBaseUrl !== undefined) return cfg.publicBaseUrl.replace(/\/+$/, '');
    if (cfg.endpoint !== undefined) {
      const base = cfg.endpoint.replace(/\/+$/, '');
      // forcePathStyle => bucket is a path segment; else it is a host subdomain.
      return cfg.forcePathStyle ? `${base}/${cfg.bucket}` : base;
    }
    return `https://${cfg.bucket}.s3.${cfg.region}.amazonaws.com`;
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertStorageKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async get(key: string): Promise<Buffer> {
    assertStorageKey(key);
    try {
      const out = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const body = out.Body;
      if (body === undefined) throw new ObjectNotFoundError(key);
      // transformToByteArray is provided by the SDK's stream mixin in Node + browser.
      const bytes = await body.transformToByteArray();
      return Buffer.from(bytes);
    } catch (e) {
      if (isNotFound(e)) throw new ObjectNotFoundError(key);
      throw e;
    }
  }

  async delete(key: string): Promise<void> {
    assertStorageKey(key);
    // S3 DeleteObject is already idempotent (deleting a missing key succeeds).
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertStorageKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  url(key: string): string {
    assertStorageKey(key);
    return `${this.publicPrefix}/${key}`;
  }
}
