import { imageSize } from 'image-size';
import { createHash } from 'node:crypto';

/**
 * be-04 MEDIA — pure-JS file metadata extraction. METADATA ONLY: a content hash, byte size, sniffed
 * mime + extension, and (for images) pixel dimensions. NO decode, NO resize — sharp is explicitly out of
 * scope (a separate future run). The light, zero-dependency `image-size` lib gives dimensions + format
 * for jpg/png/webp/gif (+ more) synchronously from the buffer.
 *
 * TRUST THE BYTES, NOT THE HEADER: when `image-size` recognizes the bytes as an image we DERIVE the
 * canonical `mime` (`image/<type>`) and `ext` from the sniffed format — a lying `Content-Type` header
 * cannot poison the record. For a non-image (or a corrupt/truncated image that throws), dimensions are
 * NULL and we fall back to the client-declared mime / a sanitized extension.
 */

/** The metadata of one uploaded file, ready to (a) build the storage key and (b) insert into `files`. */
export interface FileMetadata {
  /** sha256 hex of the bytes — the content address (storage key stem + the `files.hash` dedup key). */
  hash: string;
  /** Byte length. */
  size: number;
  /** Canonical content type: sniffed `image/<fmt>` for an image, else the declared mime / octet-stream. */
  mime: string;
  /** Pixel width for an image, else NULL. */
  width: number | null;
  /** Pixel height for an image, else NULL. */
  height: number | null;
  /** Lower-`[a-z0-9]` extension for the storage key (sniffed image format, sanitized name ext, or `bin`). */
  ext: string;
}

/** Map the few sniffed `image-size` `type`s whose canonical mime/extension differs from the literal. */
const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', svg: 'image/svg+xml' };

/** Derive a safe lower-`[a-z0-9]` extension (max 8 chars) from a sanitized filename, or null if none. */
function extFromFilename(filename: string): string | null {
  const dot = filename.lastIndexOf('.');
  if (dot < 0 || dot === filename.length - 1) return null;
  const raw = filename.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (raw.length === 0) return null;
  return raw.slice(0, 8);
}

/**
 * Extract {@link FileMetadata} from the raw bytes. `declaredMime` is the client-sent part mime (trusted
 * only as a fallback); `filename` is the already-basename'd original name (used only for a fallback ext).
 * NEVER throws for a corrupt image — it degrades to null dimensions.
 */
export function extractMetadata(bytes: Buffer, declaredMime: string, filename: string): FileMetadata {
  const hash = createHash('sha256').update(bytes).digest('hex');
  const size = bytes.byteLength;

  let width: number | null = null;
  let height: number | null = null;
  let mime = declaredMime || 'application/octet-stream';
  let ext: string | null = null;

  try {
    const dims = imageSize(bytes);
    if (dims && typeof dims.width === 'number' && typeof dims.height === 'number' && dims.type) {
      width = dims.width;
      height = dims.height;
      const type = dims.type.toLowerCase();
      mime = IMAGE_MIME[type] ?? `image/${type}`;
      ext = type === 'jpg' ? 'jpg' : type.replace(/[^a-z0-9]/g, '').slice(0, 8) || null;
    }
  } catch {
    // Not a recognized / parseable image: leave dims null and fall back below. Never a 500.
  }

  if (ext === null) ext = extFromFilename(filename) ?? 'bin';

  return { hash, size, mime, width, height, ext };
}

/** Build the content-addressed storage key from a hash + extension: `ab/cd/<sha256>.<ext>`. */
export function storageKeyFor(hash: string, ext: string): string {
  return `${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.${ext}`;
}
