import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Boxes, FileStack, Layers, Plus, Image } from 'lucide-react';
import { api } from '@/lib/api';
import { contentTypeKeys, errorMessage } from '@/lib/content-types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';

const navLink =
  'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground [&.active]:bg-muted [&.active]:font-medium [&.active]:text-foreground';

/**
 * The persistent left sidebar: brand header, a "Content" section listing every content type from
 * `api.contentTypes.list()` (one link per api_id -> the generic entries manager), and a link to the
 * Content-Type Builder. The type list lives in a scroll-area so a long catalog never pushes the
 * builder link off-screen. The list refetches whenever the builder invalidates `contentTypeKeys.all`.
 */
export function Sidebar() {
  const typesQuery = useQuery({
    queryKey: contentTypeKeys.list(),
    queryFn: ({ signal }) => api.contentTypes.list(signal),
  });

  return (
    <aside className="flex h-full w-60 shrink-0 flex-col border-r bg-card">
      <div className="flex h-14 items-center gap-2 px-4">
        <Boxes className="h-5 w-5 text-primary" />
        <Link to="/" className="font-semibold tracking-tight">
          absurdFastCMS
        </Link>
      </div>
      <Separator />

      <div className="flex items-center gap-2 px-4 pb-1 pt-4 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <Layers className="h-3.5 w-3.5" />
        Content
      </div>
      <ScrollArea className="min-h-0 flex-1 px-2">
        <nav className="space-y-0.5 py-1">
          {typesQuery.isLoading ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">Loading…</p>
          ) : typesQuery.isError ? (
            <p
              className="px-2 py-1.5 text-sm text-destructive"
              title={errorMessage(typesQuery.error)}
            >
              Failed to load types
            </p>
          ) : (typesQuery.data?.length ?? 0) === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">No content types yet.</p>
          ) : (
            typesQuery.data?.map((def) => (
              <Link
                key={def.apiId}
                to="/content/$apiId"
                params={{ apiId: def.apiId }}
                className={navLink}
              >
                <FileStack className="h-4 w-4 shrink-0" />
                <span className="truncate">{def.apiId}</span>
              </Link>
            ))
          )}
        </nav>
      </ScrollArea>

      <Separator />
      <nav className="space-y-0.5 p-2">
        <Link to="/media" className={navLink} activeOptions={{ exact: true }}>
          <Image className="h-4 w-4 shrink-0" />
          Media Library
        </Link>
        <Link to="/content-types/new" className={navLink}>
          <Plus className="h-4 w-4 shrink-0" />
          New content type
        </Link>
        <Link to="/content-types" className={navLink} activeOptions={{ exact: true }}>
          <Layers className="h-4 w-4 shrink-0" />
          Content-Type Builder
        </Link>
      </nav>
    </aside>
  );
}
