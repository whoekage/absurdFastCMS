import { useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import type { CreateContentTypeInput } from '@absurd/sdk';
import { api } from '@/lib/api';
import {
  contentTypeKeys,
  errorMessage,
  validateIdentifier,
  validateFieldDraft,
  draftToFieldSpec,
  emptyFieldDraft,
  type FieldDraft,
} from '@/lib/content-types';
import { FieldRowEditor } from '@/components/field-row-editor';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/components/ui/toast';

export const Route = createFileRoute('/content-types/new')({
  component: NewContentTypePage,
});

function NewContentTypePage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [apiId, setApiId] = useState('');
  const [fields, setFields] = useState<FieldDraft[]>(() => [emptyFieldDraft()]);
  const [draftPublish, setDraftPublish] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const createMutation = useMutation({
    mutationFn: (input: CreateContentTypeInput) => api.contentTypes.create(input),
    onSuccess: async (def) => {
      await queryClient.invalidateQueries({ queryKey: contentTypeKeys.all });
      toast.success(`Content type "${def.apiId}" created`);
      void navigate({ to: '/content-types/$apiId', params: { apiId: def.apiId } });
    },
    onError: (err) => {
      setFormError(errorMessage(err));
      toast.error(errorMessage(err));
    },
  });

  const updateField = (index: number, next: FieldDraft) => {
    setFields((prev) => prev.map((f, i) => (i === index ? next : f)));
  };
  const removeField = (index: number) => {
    setFields((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = () => {
    setFormError(null);

    const apiIdError = validateIdentifier(apiId.trim(), 'API ID');
    if (apiIdError) {
      setFormError(apiIdError);
      return;
    }
    if (fields.length === 0) {
      setFormError('Add at least one field');
      return;
    }
    for (const draft of fields) {
      const fieldError = validateFieldDraft(draft);
      if (fieldError) {
        setFormError(fieldError);
        return;
      }
    }
    const names = fields.map((f) => f.name.trim());
    if (new Set(names).size !== names.length) {
      setFormError('Field names must be unique');
      return;
    }

    createMutation.mutate({
      apiId: apiId.trim(),
      fields: fields.map(draftToFieldSpec),
      ...(draftPublish ? { draftPublish: true } : {}),
    });
  };

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

      <Card>
        <CardHeader>
          <CardTitle>New content type</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-6"
            onSubmit={(e) => {
              e.preventDefault();
              handleSubmit();
            }}
          >
            <div className="max-w-sm space-y-1.5">
              <Label htmlFor="apiId">API ID</Label>
              <Input
                id="apiId"
                value={apiId}
                placeholder="e.g. product"
                onChange={(e) => setApiId(e.target.value)}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <div className="space-y-0.5">
                <Label htmlFor="draftPublish">Draft &amp; Publish</Label>
                <p className="text-xs text-muted-foreground">
                  Entries start as drafts and are hidden until published. Cannot be changed later.
                </p>
              </div>
              <Switch id="draftPublish" checked={draftPublish} onCheckedChange={setDraftPublish} />
            </div>

            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium">Fields</h2>
              </div>
              {fields.map((draft, index) => (
                <FieldRowEditor
                  key={draft.key}
                  draft={draft}
                  onChange={(next) => updateField(index, next)}
                  onRemove={fields.length > 1 ? () => removeField(index) : undefined}
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setFields((prev) => [...prev, emptyFieldDraft()])}
              >
                <Plus className="h-4 w-4" />
                Add field
              </Button>
            </div>

            {formError && <p className="text-sm text-destructive">{formError}</p>}

            <div className="flex items-center gap-2 pt-2">
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending ? 'Creating…' : 'Create content type'}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => void navigate({ to: '/content-types' })}
                disabled={createMutation.isPending}
              >
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </section>
  );
}
