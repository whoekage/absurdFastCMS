import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';

/** Friendly 404-ish state shown when a `/content/$name` route targets a module that does not exist. */
export function UnknownType({ name }: { name: string }) {
  return (
    <section className="mx-auto max-w-md py-16 text-center">
      <p className="text-5xl font-semibold text-muted-foreground/40">404</p>
      <h1 className="mt-4 text-xl font-semibold tracking-tight">Module not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        No module with api id <span className="font-mono">{name}</span> exists.
      </p>
      {/* The Schema Builder UI was removed (files-first) — link back to the dashboard instead. */}
      <Button asChild className="mt-6" variant="outline">
        <Link to="/dashboard">Back to dashboard</Link>
      </Button>
    </section>
  );
}
