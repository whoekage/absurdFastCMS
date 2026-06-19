import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';

/** Friendly 404-ish state shown when a `/content/$apiId` route targets a content-type that does not exist. */
export function UnknownType({ apiId }: { apiId: string }) {
  return (
    <section className="mx-auto max-w-md py-16 text-center">
      <p className="text-5xl font-semibold text-muted-foreground/40">404</p>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Content type not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No content type with api id <span className="font-mono">{apiId}</span> exists.
      </p>
      <Button asChild className="mt-6" variant="outline">
        <Link to="/content-types">Browse content types</Link>
      </Button>
    </section>
  );
}
