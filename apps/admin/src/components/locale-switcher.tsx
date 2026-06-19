import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Languages } from 'lucide-react';
import type { Entry } from '@absurd/sdk';
import { api } from '@/lib/api';
import { contentKeys, errorMessage } from '@/lib/content-manager';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

/**
 * i18n LOCALE SWITCHER for a single entry. Renders ONLY for an i18n type (the caller guards on
 * `def.i18n`). It lists every locale variant of THIS document (grouped by `document_id`) as quick links,
 * highlights the one being viewed, and offers a "+ locale" action that creates a NEW variant of the same
 * document (`createVariant`) and navigates to it. Shared fields are copied server-side; the new variant
 * starts with the shared values and empty localized fields (edit them on the variant's edit page).
 */
export function LocaleSwitcher({
  apiId,
  row,
}: {
  apiId: string;
  row: Entry;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [newLocale, setNewLocale] = useState('');

  const documentId = row['document_id'];
  const currentLocale = String(row['locale'] ?? '');

  // Every variant of this document (locale=* removes the locale predicate; filter by document_id).
  const variantsQuery = useQuery({
    queryKey: ['content', apiId, 'variants', documentId],
    queryFn: ({ signal }) =>
      api.list(apiId, { locale: '*', filters: { document_id: { $eq: documentId as number } } }, signal),
    enabled: documentId != null,
  });

  const variants = variantsQuery.data?.data ?? [];

  const createMutation = useMutation({
    mutationFn: (locale: string) => api.createVariant(apiId, row['id'] as number, locale, {}),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: contentKeys.all(apiId) });
      setOpen(false);
      setNewLocale('');
      toast.success(`Variant "${res.data.locale}" created`);
      void navigate({ to: '/content/$apiId/$id/edit', params: { apiId, id: String(res.data.id) } });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="flex items-center gap-2">
      <Languages className="h-4 w-4 text-muted-foreground" />
      <div className="flex flex-wrap items-center gap-1.5">
        {variants.map((v) => {
          const loc = String(v['locale'] ?? '');
          const active = loc === currentLocale;
          return (
            <Button
              key={loc}
              type="button"
              variant={active ? 'default' : 'secondary'}
              size="sm"
              className="h-7 px-2.5"
              onClick={() =>
                active
                  ? undefined
                  : void navigate({ to: '/content/$apiId/$id', params: { apiId, id: String(v['id']) } })
              }
            >
              {loc}
            </Button>
          );
        })}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2.5">
            <Plus className="h-3.5 w-3.5" />
            locale
          </Button>
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a locale variant</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              Creates a new locale variant of this document. Shared fields are copied; edit the localized
              fields on the next screen.
            </p>
            <Input
              value={newLocale}
              placeholder="e.g. fr, pt-BR"
              onChange={(e) => setNewLocale(e.target.value)}
            />
            {variants.length > 0 && (
              <p className="text-xs text-muted-foreground">
                Existing:{' '}
                {variants.map((v) => (
                  <Badge key={String(v['locale'])} variant="secondary" className="mr-1">
                    {String(v['locale'])}
                  </Badge>
                ))}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={newLocale.trim() === '' || createMutation.isPending}
              onClick={() => createMutation.mutate(newLocale.trim())}
            >
              {createMutation.isPending ? 'Creating…' : 'Create variant'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
