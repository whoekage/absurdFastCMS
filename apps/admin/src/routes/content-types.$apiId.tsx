import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import type {
  ContentTypeDefinition,
  FieldDefinition,
  FieldSpec,
  UpdateFieldInput,
} from '@absurd/sdk';
import { api } from '@/lib/api';
import {
  contentTypeKeys,
  errorMessage,
  validateFieldDraft,
  draftOptions,
  draftToFieldSpec,
  draftFromField,
  emptyFieldDraft,
  type FieldDraft,
} from '@/lib/content-types';
import { FieldRowEditor } from '@/components/field-row-editor';
import { RelationConfigEditor } from '@/components/relation-config-editor';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const Route = createFileRoute('/content-types/$apiId')({
  component: ContentTypeDetailPage,
});

function ContentTypeDetailPage() {
  const { apiId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [addOpen, setAddOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<FieldDefinition | null>(null);
  const [dropFieldTarget, setDropFieldTarget] = useState<FieldDefinition | null>(null);
  const [dropTypeOpen, setDropTypeOpen] = useState(false);

  const defQuery = useQuery({
    queryKey: contentTypeKeys.detail(apiId),
    queryFn: ({ signal }) => api.contentTypes.get(apiId, signal),
  });

  const invalidate = async (def?: ContentTypeDefinition) => {
    if (def) queryClient.setQueryData(contentTypeKeys.detail(apiId), def);
    await queryClient.invalidateQueries({ queryKey: contentTypeKeys.all });
  };

  const dropFieldMutation = useMutation({
    mutationFn: (name: string) => api.contentTypes.dropField(apiId, name),
    onSuccess: async (def) => {
      await invalidate(def);
      toast.success('Field dropped');
      setDropFieldTarget(null);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const dropTypeMutation = useMutation({
    mutationFn: () => api.contentTypes.drop(apiId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: contentTypeKeys.all });
      toast.success(`Content type "${apiId}" dropped`);
      setDropTypeOpen(false);
      void navigate({ to: '/content-types' });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const def = defQuery.data;

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div>
        <Button asChild variant="ghost" size="sm" className="-ml-2">
          <Link to="/content-types">
            <ChevronLeft className="h-4 w-4" />
            Back to content types
          </Link>
        </Button>
      </div>

      {defQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : defQuery.isError || !def ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-6 text-sm">
          <p className="font-medium text-destructive">Could not load content type</p>
          <p className="mt-1 text-muted-foreground">{errorMessage(defQuery.error)}</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => defQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold tracking-tight">{def.apiId}</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {def.fields.length} field{def.fields.length === 1 ? '' : 's'}
              </p>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => setAddOpen(true)}>
                <Plus className="h-4 w-4" />
                Add field
              </Button>
              <Button variant="destructive" onClick={() => setDropTypeOpen(true)}>
                <Trash2 className="h-4 w-4" />
                Drop type
              </Button>
            </div>
          </div>

          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Nullable</TableHead>
                  <TableHead>System</TableHead>
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {def.fields.map((field) => (
                  <TableRow key={field.name}>
                    <TableCell className="font-medium">{field.name}</TableCell>
                    <TableCell>
                      <span className="text-sm">{field.cmsType}</span>
                      {field.enumValues && field.enumValues.length > 0 && (
                        <span className="ml-2 text-xs text-muted-foreground">
                          [{field.enumValues.join(', ')}]
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{field.nullable ? 'Yes' : 'No'}</TableCell>
                    <TableCell>
                      {field.system ? <Badge variant="secondary">system</Badge> : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {field.system ? (
                        <span className="text-xs text-muted-foreground">read-only</span>
                      ) : (
                        <div className="flex justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Edit field"
                            onClick={() => setEditTarget(field)}
                          >
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            title="Drop field"
                            onClick={() => setDropFieldTarget(field)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <RelationConfigEditor def={def} />
        </>
      )}

      {/* Add field */}
      <AddFieldDialog
        apiId={apiId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onSaved={invalidate}
      />

      {/* Edit field */}
      <EditFieldDialog
        apiId={apiId}
        field={editTarget}
        onClose={() => setEditTarget(null)}
        onSaved={invalidate}
      />

      {/* Drop field confirm */}
      <Dialog
        open={dropFieldTarget !== null}
        onOpenChange={(open) => !open && setDropFieldTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Drop field</DialogTitle>
            <DialogDescription>
              Drop field "{dropFieldTarget?.name}"? Its column and all its data are permanently
              removed. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDropFieldTarget(null)}
              disabled={dropFieldMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={dropFieldMutation.isPending}
              onClick={() =>
                dropFieldTarget && dropFieldMutation.mutate(dropFieldTarget.name)
              }
            >
              {dropFieldMutation.isPending ? 'Dropping…' : 'Drop field'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Drop type confirm (type-to-confirm) */}
      <DropTypeDialog
        apiId={apiId}
        open={dropTypeOpen}
        onOpenChange={setDropTypeOpen}
        pending={dropTypeMutation.isPending}
        onConfirm={() => dropTypeMutation.mutate()}
      />
    </section>
  );
}

// ── Add-field dialog ─────────────────────────────────────────────────────────────────────────

function AddFieldDialog({
  apiId,
  open,
  onOpenChange,
  onSaved,
}: {
  apiId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (def: ContentTypeDefinition) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FieldDraft>(() => emptyFieldDraft());
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (spec: FieldSpec) => api.contentTypes.addField(apiId, spec),
    onSuccess: async (def) => {
      await onSaved(def);
      toast.success('Field added');
      onOpenChange(false);
    },
    onError: (err) => {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
    },
  });

  const reset = () => {
    setDraft(emptyFieldDraft());
    setError(null);
  };

  const submit = () => {
    setError(null);
    const fieldError = validateFieldDraft(draft);
    if (fieldError) {
      setError(fieldError);
      return;
    }
    mutation.mutate(draftToFieldSpec(draft));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add field</DialogTitle>
          <DialogDescription>Add a new field to "{apiId}".</DialogDescription>
        </DialogHeader>
        <FieldRowEditor draft={draft} onChange={setDraft} />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={mutation.isPending}>
            {mutation.isPending ? 'Adding…' : 'Add field'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit-field dialog ────────────────────────────────────────────────────────────────────────

function EditFieldDialog({
  apiId,
  field,
  onClose,
  onSaved,
}: {
  apiId: string;
  field: FieldDefinition | null;
  onClose: () => void;
  onSaved: (def: ContentTypeDefinition) => Promise<void>;
}) {
  // The dialog body is keyed by field.name so the draft resets whenever a new field is opened.
  return (
    <Dialog open={field !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        {field && (
          <EditFieldBody
            key={field.name}
            apiId={apiId}
            field={field}
            onClose={onClose}
            onSaved={onSaved}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditFieldBody({
  apiId,
  field,
  onClose,
  onSaved,
}: {
  apiId: string;
  field: FieldDefinition;
  onClose: () => void;
  onSaved: (def: ContentTypeDefinition) => Promise<void>;
}) {
  const [draft, setDraft] = useState<FieldDraft>(() => draftFromField(field));
  const [error, setError] = useState<string | null>(null);

  const mutation = useMutation({
    mutationFn: (change: UpdateFieldInput) => api.contentTypes.updateField(apiId, field.name, change),
    onSuccess: async (def) => {
      await onSaved(def);
      toast.success('Field updated');
      onClose();
    },
    onError: (err) => {
      setError(errorMessage(err));
      toast.error(errorMessage(err));
    },
  });

  const submit = () => {
    setError(null);
    const fieldError = validateFieldDraft(draft);
    if (fieldError) {
      setError(fieldError);
      return;
    }

    const change: UpdateFieldInput = {};
    const newName = draft.name.trim();
    if (newName !== field.name) change.newName = newName;
    if (draft.cmsType !== field.cmsType) change.cmsType = draft.cmsType;
    // Carry options whenever the type changes (enum values / length / precision+scale).
    if (change.cmsType !== undefined) change.options = draftOptions(draft);

    if (change.newName === undefined && change.cmsType === undefined) {
      setError('Change the name or type to update the field');
      return;
    }
    mutation.mutate(change);
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Edit field</DialogTitle>
        <DialogDescription>
          Rename or change the type of "{field.name}". A forbidden type change is rejected by the
          server.
        </DialogDescription>
      </DialogHeader>
      <FieldRowEditor draft={draft} onChange={setDraft} />
      {error && <p className="text-sm text-destructive">{error}</p>}
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={mutation.isPending}>
          {mutation.isPending ? 'Saving…' : 'Save changes'}
        </Button>
      </DialogFooter>
    </>
  );
}

// ── Drop-type dialog (type-to-confirm) ─────────────────────────────────────────────────────────

function DropTypeDialog({
  apiId,
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  apiId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  pending: boolean;
  onConfirm: () => void;
}) {
  const [confirmText, setConfirmText] = useState('');
  const matches = confirmText === apiId;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setConfirmText('');
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Drop content type</DialogTitle>
          <DialogDescription>
            This permanently drops the "{apiId}" table and ALL of its data. This cannot be undone.
            Type <span className="font-mono font-semibold">{apiId}</span> to confirm.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-drop">Confirm API ID</Label>
          <Input
            id="confirm-drop"
            value={confirmText}
            placeholder={apiId}
            onChange={(e) => setConfirmText(e.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!matches || pending} onClick={onConfirm}>
            {pending ? 'Dropping…' : 'Drop type'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
