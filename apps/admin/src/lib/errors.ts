import { ApiError } from '@conti/sdk';

/** Pull a human-readable message out of any thrown value (API errors carry a server message). */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    return err.message || `Request failed (${err.status})`;
  }
  if (err instanceof Error) return err.message;
  return 'Something went wrong';
}
