import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { AlertOctagon, Home, RotateCcw } from 'lucide-react';
import { errorMessage } from '@/lib/errors';
import { Button } from '@/components/ui/button';

/**
 * Route-level error boundary (TanStack Router `errorComponent`). Catches a thrown render/loader
 * error for the matched route subtree, shows the human message, and offers "Try again" (invalidate
 * + reset the router) and a link home.
 */
export function RouteErrorComponent({ error }: ErrorComponentProps) {
  const router = useRouter();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertOctagon className="h-12 w-12 text-destructive" />
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Something went wrong</h1>
        <p className="max-w-md text-sm text-muted-foreground">{errorMessage(error)}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => void router.invalidate()}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
        <Button asChild>
          <Link to="/">
            <Home className="h-4 w-4" />
            Go home
          </Link>
        </Button>
      </div>
    </div>
  );
}

/**
 * The 404 component (TanStack Router `notFoundComponent`). Shown when no route matches the URL or a
 * loader throws `notFound()`.
 */
export function RouteNotFoundComponent() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <p className="text-5xl font-bold text-muted-foreground">404</p>
      <div className="space-y-1">
        <h1 className="text-lg font-semibold">Page not found</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          The page you are looking for does not exist or has been moved.
        </p>
      </div>
      <Button asChild>
        <Link to="/">
          <Home className="h-4 w-4" />
          Go home
        </Link>
      </Button>
    </div>
  );
}
