import { createFileRoute, Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Plus, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { contentTypeKeys, errorMessage } from '@/lib/content-types';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const Route = createFileRoute('/content-types/')({
  component: ContentTypesListPage,
});

function ContentTypesListPage() {
  const listQuery = useQuery({
    queryKey: contentTypeKeys.list(),
    queryFn: ({ signal }) => api.contentTypes.list(signal),
  });

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Content Types</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Define and manage dynamic content types.
          </p>
        </div>
        <Button asChild>
          <Link to="/content-types/new">
            <Plus className="h-4 w-4" />
            New content type
          </Link>
        </Button>
      </div>

      {listQuery.isError ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-medium text-destructive">Could not load content types</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(listQuery.error)}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>API ID</TableHead>
                <TableHead>Fields</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQuery.isLoading ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              ) : (listQuery.data?.length ?? 0) === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="py-10 text-center text-muted-foreground">
                    No content types yet. Create one to get started.
                  </TableCell>
                </TableRow>
              ) : (
                listQuery.data?.map((def) => (
                  <TableRow key={def.apiId}>
                    <TableCell className="font-medium">{def.apiId}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{def.fields.length}</Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      <Button asChild variant="ghost" size="sm">
                        <Link to="/content-types/$apiId" params={{ apiId: def.apiId }}>
                          Manage
                          <ChevronRight className="h-4 w-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
