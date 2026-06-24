import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { X, Upload, ImagePlus, Check } from 'lucide-react';
import type { FileAsset } from '@conti/sdk';
import { api } from '@/lib/api';
import { mediaKeys, isImageAsset, formatBytes, type MediaFieldConfig } from '@/lib/media';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { toast } from '@/components/ui/toast';

// ──────────────────────────────────────────────────────────────────────────────────────────────
// be-04 MEDIA — the media-field picker.
//
// A CONTROLLED widget over the SELECTED ASSET ID SET: the parent (entry form) owns `value` (ids) and
// gets `onChange(ids)` back. Single fields keep at most one id; multiple keep an ordered set. Selected
// assets render as thumbnails; a "Browse / Upload" dialog lists the media library (grid) and lets the
// operator pick existing assets or upload a new one (which is added to the selection). All via @conti/sdk
// (client.assets.list + client.upload). A small id->asset cache labels selected ids that aren't in the
// current library page (e.g. seeded from a populated edit row).
// ──────────────────────────────────────────────────────────────────────────────────────────────

interface MediaPickerProps {
  id: string;
  config: MediaFieldConfig;
  /** Currently-selected asset ids (the parent owns this set). */
  value: number[];
  /** Pre-known assets (e.g. populated from the edit row) to label selected ids. */
  initialAssets?: FileAsset[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

export function MediaPicker({ id, config, value, initialAssets, onChange, disabled }: MediaPickerProps) {
  const [open, setOpen] = useState(false);
  // id -> asset cache (seeded from the populated edit row; grown as the user picks / uploads).
  const cache = useRef<Map<number, FileAsset>>(new Map());
  for (const a of initialAssets ?? []) if (!cache.current.has(a.id)) cache.current.set(a.id, a);

  const selected = value.map((vid) => cache.current.get(vid)).filter((a): a is FileAsset => a !== undefined);

  function add(asset: FileAsset): void {
    cache.current.set(asset.id, asset);
    if (config.multiple) {
      if (!value.includes(asset.id)) onChange([...value, asset.id]);
    } else {
      onChange([asset.id]);
      setOpen(false);
    }
  }

  function remove(assetId: number): void {
    onChange(value.filter((v) => v !== assetId));
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {selected.map((asset) => (
          <div key={asset.id} className="group relative">
            <AssetTile asset={asset} />
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${asset.filename}`}
                className="absolute -right-1.5 -top-1.5 rounded-full bg-background p-0.5 opacity-0 ring-1 ring-border transition-opacity group-hover:opacity-100"
                onClick={() => remove(asset.id)}
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        ))}
        {/* A selected-but-unresolved id (no cached asset) still shows a chip so it is removable. */}
        {value
          .filter((vid) => !cache.current.has(vid))
          .map((vid) => (
            <div
              key={vid}
              className="flex h-16 w-16 items-center justify-center rounded-md bg-muted text-xs text-muted-foreground ring-1 ring-border"
            >
              #{vid}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Remove #${vid}`}
                  className="absolute"
                  onClick={() => remove(vid)}
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        {!disabled && (config.multiple || value.length === 0) && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            id={id}
            className="h-16 w-16 flex-col gap-1"
            onClick={() => setOpen(true)}
          >
            <ImagePlus className="h-4 w-4" />
            <span className="text-[10px]">{value.length === 0 ? 'Add' : 'More'}</span>
          </Button>
        )}
        {!disabled && !config.multiple && value.length > 0 && (
          <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(true)}>
            Replace
          </Button>
        )}
      </div>

      <MediaLibraryDialog
        open={open}
        onOpenChange={setOpen}
        multiple={config.multiple}
        selectedIds={value}
        onPick={add}
      />
    </div>
  );
}

/** A 64px asset tile — image thumbnail or a mime badge, with filename below. */
function AssetTile({ asset }: { asset: FileAsset }) {
  return (
    <div className="flex w-16 flex-col items-center gap-0.5" title={asset.filename}>
      {isImageAsset(asset) ? (
        <img
          src={asset.url as string}
          alt={asset.filename}
          className="h-16 w-16 rounded-md object-cover ring-1 ring-border"
        />
      ) : (
        <div className="flex h-16 w-16 items-center justify-center rounded-md bg-muted text-[10px] uppercase text-muted-foreground ring-1 ring-border">
          {asset.mime.split('/')[1] ?? 'file'}
        </div>
      )}
      <span className="w-16 truncate text-center text-[10px] text-muted-foreground">{asset.filename}</span>
    </div>
  );
}

/**
 * The library-browse + upload dialog. Lists the first page of `client.assets.list`, lets the operator
 * pick an existing asset (toggle for multiple) or upload a new file (added to the selection on success).
 */
function MediaLibraryDialog({
  open,
  onOpenChange,
  multiple,
  selectedIds,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  multiple: boolean;
  selectedIds: number[];
  onPick: (asset: FileAsset) => void;
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const listQuery = useQuery({
    queryKey: mediaKeys.list(0, 50),
    queryFn: ({ signal }) => api.assets.list({ start: 0, limit: 50 }, signal),
    enabled: open,
  });

  const selectedSet = new Set(selectedIds);

  async function onUpload(files: FileList | null): Promise<void> {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const file of Array.from(files)) {
        const asset = await api.upload(file);
        onPick(asset);
      }
      await queryClient.invalidateQueries({ queryKey: mediaKeys.all });
      toast.success('Uploaded');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Media library</DialogTitle>
          <DialogDescription>
            Pick {multiple ? 'one or more assets' : 'an asset'} or upload a new file.
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <input
            ref={fileRef}
            type="file"
            multiple={multiple}
            className="hidden"
            onChange={(e) => void onUpload(e.target.files)}
          />
          <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => fileRef.current?.click()}>
            <Upload className="h-4 w-4" />
            {uploading ? 'Uploading…' : 'Upload file'}
          </Button>
        </div>

        <ScrollArea className="h-80">
          {listQuery.isLoading ? (
            <p className="p-4 text-sm text-muted-foreground">Loading…</p>
          ) : (listQuery.data?.data.length ?? 0) === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No assets yet. Upload one above.</p>
          ) : (
            <div className="grid grid-cols-4 gap-3 p-1 sm:grid-cols-5">
              {listQuery.data?.data.map((asset) => {
                const isSelected = selectedSet.has(asset.id);
                return (
                  <button
                    key={asset.id}
                    type="button"
                    onClick={() => onPick(asset)}
                    className={`group relative flex flex-col items-center gap-1 rounded-md p-1 ring-1 transition-colors ${
                      isSelected ? 'ring-2 ring-primary' : 'ring-border hover:bg-muted'
                    }`}
                    title={`${asset.filename} · ${formatBytes(asset.size)}`}
                  >
                    {isImageAsset(asset) ? (
                      <img src={asset.url as string} alt={asset.filename} className="h-20 w-full rounded object-cover" />
                    ) : (
                      <div className="flex h-20 w-full items-center justify-center rounded bg-muted text-[10px] uppercase text-muted-foreground">
                        {asset.mime.split('/')[1] ?? 'file'}
                      </div>
                    )}
                    <span className="w-full truncate text-center text-[10px] text-muted-foreground">{asset.filename}</span>
                    {isSelected && (
                      <span className="absolute right-1 top-1 rounded-full bg-primary p-0.5 text-primary-foreground">
                        <Check className="h-3 w-3" />
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </ScrollArea>

        <div className="flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
