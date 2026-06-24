import { useRef, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Upload, Trash2, UploadCloud } from 'lucide-react';
import type { FileAsset } from '@conti/sdk';
import { api } from '@/lib/api';
import { mediaKeys, isImageAsset, formatBytes } from '@/lib/media';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/media/')({
  component: MediaLibraryPage,
});

/**
 * be-04 — the MEDIA LIBRARY screen: a Lua dropzone over a grid of every uploaded asset (image thumbnail
 * or mime chip), with upload (multiple, click OR drag-drop) and per-asset delete. All via @conti/sdk
 * (client.assets.list / client.upload / client.assets.delete). Deleting an asset that a media field
 * still references is allowed — the reference dangles and a populate read resolves it to null/drops it.
 */
function MediaLibraryPage() {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const listQuery = useQuery({
    queryKey: mediaKeys.list(0, 100),
    queryFn: ({ signal }) => api.assets.list({ start: 0, limit: 100 }, signal),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.assets.delete(id),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
      toast.success('Asset deleted');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Delete failed'),
  });

  async function onUpload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      let count = 0;
      for (const file of Array.from(files)) {
        await api.upload(file);
        count += 1;
      }
      await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
      toast.success(`Uploaded ${count} file(s)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const assets = listQuery.data?.data ?? [];
  const total = listQuery.data?.meta.pagination.total;
  // REAL aggregate size across the loaded page of assets.
  const totalBytes = assets.reduce((sum, a) => sum + a.size, 0);

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl font-semibold tracking-tight">Media Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {total !== undefined ? (
              <>
                <span className="font-mono">{total}</span> asset{total === 1 ? '' : 's'} ·{' '}
                <span className="font-mono">{formatBytes(totalBytes)}</span> ·{' '}
                {/* Decorative flourish — NOT a live metric. */}
                <span className="text-muted-foreground/70">served from edge</span>
              </>
            ) : (
              'Upload, browse, and manage assets.'
            )}
          </p>
        </div>
        <div>
          <input
            ref={fileRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void onUpload(e.target.files)}
          />
          <Button disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload'}
          </Button>
        </div>
      </div>

      {/* Lua dropzone — click or drag-drop onto it to upload. */}
      <button
        type="button"
        disabled={uploading}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void onUpload(e.dataTransfer.files);
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed bg-card px-6 py-10 text-center transition-colors',
          dragOver ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/50',
          uploading && 'pointer-events-none opacity-60',
        )}
      >
        <span className="flex h-11 w-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <UploadCloud className="h-5 w-5" />
        </span>
        <p className="font-display text-sm font-semibold">
          {uploading ? 'Uploading…' : 'Drop files here or browse'}
        </p>
        <p className="text-xs text-muted-foreground">
          Images and documents · multiple files supported
        </p>
      </button>

      {listQuery.isError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-6 text-sm shadow-card">
          <p className="font-medium text-destructive">Could not load the media library</p>
          <Button className="mt-3" variant="outline" size="sm" onClick={() => listQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : listQuery.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">
          No assets yet. Drop files above or click{' '}
          <span className="font-medium">Upload</span> to add your first file.
        </div>
      ) : (
        <ScrollArea className="h-[calc(100vh-20rem)]">
          <div className="grid grid-cols-2 gap-4 p-1 sm:grid-cols-3 lg:grid-cols-5">
            {assets.map((asset) => (
              <AssetCard
                key={asset.id}
                asset={asset}
                onDelete={() => deleteMutation.mutate(asset.id)}
                deleting={deleteMutation.isPending && deleteMutation.variables === asset.id}
              />
            ))}
          </div>
        </ScrollArea>
      )}
    </section>
  );
}

function AssetCard({ asset, onDelete, deleting }: { asset: FileAsset; onDelete: () => void; deleting: boolean }) {
  const typeChip = asset.mime.split('/')[1] ?? asset.mime;
  const dims = asset.width !== null && asset.height !== null ? `${asset.width}×${asset.height}` : null;
  return (
    <div className="group relative flex flex-col overflow-hidden rounded-xl border bg-card shadow-card transition-shadow hover:shadow-pop">
      <div className="relative">
        {isImageAsset(asset) ? (
          <img
            src={asset.url as string}
            alt={asset.filename}
            className="aspect-square w-full object-cover"
          />
        ) : (
          <div className="flex aspect-square w-full items-center justify-center bg-muted text-sm uppercase text-muted-foreground">
            {typeChip}
          </div>
        )}
        {/* Type chip + delete affordance overlaid on the thumbnail. */}
        <span className="absolute left-2 top-2 rounded-md bg-background/80 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase text-muted-foreground backdrop-blur">
          {typeChip}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          title="Delete asset"
          disabled={deleting}
          onClick={onDelete}
          className="absolute right-2 top-2 h-7 w-7 bg-background/80 opacity-0 backdrop-blur transition-opacity group-hover:opacity-100"
        >
          <Trash2 className="h-3.5 w-3.5 text-destructive" />
        </Button>
      </div>
      <div className="min-w-0 p-2.5">
        <p className="truncate text-xs font-medium" title={asset.filename}>
          {asset.filename}
        </p>
        <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
          {formatBytes(asset.size)}
          {dims ? ` · ${dims}` : ''}
        </p>
      </div>
    </div>
  );
}
