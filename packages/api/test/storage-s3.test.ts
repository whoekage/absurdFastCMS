import { test, before, after } from 'node:test';
import { MinioContainer, type StartedMinioContainer } from '@testcontainers/minio';
import { S3Client, CreateBucketCommand } from '@aws-sdk/client-s3';
import { S3StorageProvider, type S3ProviderConfig } from '../src/storage/s3.provider.ts';
import { runProviderContract } from './storage-contract.ts';

/**
 * be-04 MEDIA — the S3 provider against a REAL S3-compatible server (MinIO via Testcontainers). The SAME
 * @aws-sdk/client-s3 talks real HTTP to a real MinIO — NEVER a mocked/stubbed client (hard project rule).
 * Runs the IDENTICAL provider contract suite the local-fs test runs.
 *
 * Escape hatch: if S3_TEST_ENDPOINT is set, skip MinIO and run the same suite against that real endpoint
 * (mirrors the TEST_DATABASE_URL pattern). Still no mock.
 */

const BUCKET = 'absurd-test';

let minio: StartedMinioContainer | undefined;
let cfg: S3ProviderConfig;

before(async () => {
  const external = process.env.S3_TEST_ENDPOINT?.trim();
  if (external) {
    cfg = {
      bucket: BUCKET,
      region: process.env.S3_REGION?.trim() || 'us-east-1',
      endpoint: external,
      accessKeyId: process.env.S3_ACCESS_KEY_ID?.trim() || 'minioadmin',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY?.trim() || 'minioadmin',
      forcePathStyle: true,
    };
  } else {
    // .withReuse() keeps the container warm across runs; carry NO run-varying config (reuse-hash rule).
    minio = await new MinioContainer('minio/minio:latest').withReuse().start();
    cfg = {
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: minio.getConnectionUrl(),
      accessKeyId: minio.getUsername(),
      secretAccessKey: minio.getPassword(),
      forcePathStyle: true,
    };
  }

  // Create the bucket once (idempotent: a 'BucketAlreadyOwnedByYou'/exists error is fine on a reused server).
  const client = new S3Client({
    region: cfg.region,
    endpoint: cfg.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  });
  try {
    await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw e;
  } finally {
    client.destroy();
  }
}, { timeout: 120_000 });

after(async () => {
  // Reuse-enabled container: leave it warm (testcontainers reaps reused containers per its own policy).
  if (minio && process.env.TESTCONTAINERS_REUSE_ENABLE === 'false') await minio.stop().catch(() => {});
});

runProviderContract('s3', () => new S3StorageProvider(cfg));
