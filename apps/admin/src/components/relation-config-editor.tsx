import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Info } from 'lucide-react';
import type {
  ContentTypeDefinition,
  DeclareRelationInput,
  RelationDefinition,
  RelationKind,
} from '@absurd/sdk';
import { api } from '@/lib/api';
import { contentTypeKeys, errorMessage } from '@/lib/content-types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { toast } from '@/components/ui/toast';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// Relation builder + viewer (API-driven).
//
// This DECLARES real relations in the database via `POST /content-types/:apiId/relations`
// (client.contentTypes.addRelation) and LISTS the relations the API already projects on the
// definition (`def.relations`). It replaces the old localStorage relation-config mirror (fe-06):
// relations are now first-class server state, discovered from the schema and created over HTTP.
// ──────────────────────────────────────────────────────────────────────────────────────────────

/** The four server relation kinds, with human labels for the kind dropdown. */
const KIND_OPTIONS: { value: RelationKind; label: string }[] = [
  { value: 'oneToMany', label: 'one-to-many (this has many)' },
  { value: 'manyToOne', label: 'many-to-one (this belongs to one)' },
  { value: 'oneToOne', label: 'one-to-one' },
  { value: 'manyToMany', label: 'many-to-many' },
];

interface RelationDraft {
  field: string;
  kind: RelationKind;
  target: string;
  inverseField: string;
}

function emptyDraft(): RelationDraft {
  return { field: '', kind: 'manyToOne', target: '', inverseField: '' };
}

export function RelationConfigEditor({ def }: { def: ContentTypeDefinition }) {
  const apiId = def.apiId;
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<RelationDraft>(() => emptyDraft());
  const [error, setError] = useState<string | null>(null);

  // Candidate target types (every content-type) for the target dropdown.
  const typesQuery = useQuery({
    queryKey: contentTypeKeys.list(),
    queryFn: ({ signal }) => api.contentTypes.list(signal),
  });
  const targetOptions = (typesQuery.data ?? []).map((t) => t.apiId);

  const mutation = useMutation({
    mutationFn: (input: DeclareRelationInput) => api.contentTypes.addRelation(apiId, input),
    onSuccess: async (updated) => {
      // The owner's definition came back with the new relation; seed it and invalidate the rest (the
      // target type's inverse relation also changed for a two-way declaration).
      queryClient.setQueryData(contentTypeKeys.detail(apiId), updated);
      await queryClient.invalidateQueries({ queryKey: contentTypeKeys.all });
      toast.success('Relation declared');
      setDraft(emptyDraft());
      setError(null);
    },
    onError: (err) => {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
    },
  });

  function submit(): void {
    setError(null);
    const field = draft.field.trim();
    const inverseField = draft.inverseField.trim();
    if (field === '') {
      setError('Field name is required');
      return;
    }
    if (draft.target === '') {
      setError('Target type is required');
      return;
    }
    if (def.relations.some((r) => r.field === field)) {
      setError(`A relation named "${field}" already exists on this type`);
      return;
    }
    const input: DeclareRelationInput = {
      field,
      kind: draft.kind,
      target: draft.target,
      ...(inverseField !== '' ? { inverseField } : {}),
    };
    mutation.mutate(input);
  }

  return (
    <div className="space-y-4 rounded-md border p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold">Relations</h2>
          <p className="mt-1 flex items-start gap-1.5 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              Declare a relation to another content type. The link table is created server-side and the
              relation goes live immediately for the entry-form picker, populate, and deep filtering.
              Provide an inverse field name to make it two-way (a partner field appears on the target).
            </span>
          </p>
        </div>
      </div>

      {def.relations.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Field</TableHead>
                <TableHead>Kind</TableHead>
                <TableHead>Target</TableHead>
                <TableHead>Inverse</TableHead>
                <TableHead>Owner</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {def.relations.map((r: RelationDefinition) => (
                <TableRow key={r.field}>
                  <TableCell className="font-medium">{r.field}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{r.kind}</Badge>
                  </TableCell>
                  <TableCell>{r.target}</TableCell>
                  <TableCell className="text-muted-foreground">{r.inverseField ?? '—'}</TableCell>
                  <TableCell>{r.owner ? 'Yes' : 'No (inverse)'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No relations declared on this type.</p>
      )}

      {/* Declare a relation. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-5 sm:items-end">
        <div className="space-y-1.5">
          <Label htmlFor="rel-field">Field name</Label>
          <Input
            id="rel-field"
            value={draft.field}
            placeholder="author"
            onChange={(e) => setDraft({ ...draft, field: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rel-kind">Kind</Label>
          <Select
            value={draft.kind}
            onValueChange={(v) => setDraft({ ...draft, kind: v as RelationKind })}
          >
            <SelectTrigger id="rel-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rel-target">Target type</Label>
          <Select
            {...(draft.target === '' ? {} : { value: draft.target })}
            onValueChange={(v) => setDraft({ ...draft, target: v })}
          >
            <SelectTrigger id="rel-target">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {targetOptions.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="rel-inverse">Inverse field</Label>
          <Input
            id="rel-inverse"
            value={draft.inverseField}
            placeholder="(optional, two-way)"
            onChange={(e) => setDraft({ ...draft, inverseField: e.target.value })}
          />
        </div>
        <Button type="button" onClick={submit} disabled={mutation.isPending}>
          <Plus className="h-4 w-4" />
          {mutation.isPending ? 'Declaring…' : 'Declare'}
        </Button>
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
