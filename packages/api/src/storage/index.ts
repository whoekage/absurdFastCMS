import { config } from '../config.ts';
import type { StorageProvider } from './provider.ts';
import { LocalStorageProvider } from './local.provider.ts';
import { S3StorageProvider } from './s3.provider.ts';

/**
 * be-04 MEDIA — config-driven provider SELECTION. S3 when `config.s3` is set (S3_BUCKET present), else the
 * local filesystem provider. Memoised as a process singleton: the first call builds the provider (and the
 * one S3Client), every later call returns it.
 *
 * Boot diagnostic NEVER prints credentials: `provider=s3 bucket=… region=…` only (mirrors the
 * CURSOR_SECRET discipline — absence is logged, the value never is).
 */
let cached: StorageProvider | undefined;

export function getStorageProvider(): StorageProvider {
  if (cached !== undefined) return cached;
  const s3 = config.s3;
  if (s3 !== undefined) {
    cached = new S3StorageProvider(s3);
  } else {
    cached = new LocalStorageProvider(config.localStoragePath, config.publicBaseUrl);
  }
  return cached;
}

/** Reset the memoised provider (tests that swap env between cases). */
export function resetStorageProvider(): void {
  cached = undefined;
}

export type { StorageProvider, ProviderName } from './provider.ts';
export { ObjectNotFoundError } from './provider.ts';
