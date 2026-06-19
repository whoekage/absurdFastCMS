import { Wand2 } from 'lucide-react';
import { AutoTextarea } from '@/components/ui/auto-textarea';
import { Button } from '@/components/ui/button';

interface JsonEditorProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  disabled?: boolean | undefined;
}

/** Live JSON validity for the current text (empty is considered "not invalid" — required-ness is the schema's job). */
function jsonError(text: string): string | undefined {
  if (text.trim() === '') return undefined;
  try {
    JSON.parse(text);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid JSON';
  }
}

/**
 * A JSON / array editor: an auto-growing monospace textarea with LIVE parse feedback and a
 * "Format" button that pretty-prints valid JSON in place. The actual submit-blocking error comes
 * from the field's Zod schema; this inline message is immediate UX on top of that.
 */
export function JsonEditor({ id, value, onChange, onBlur, disabled }: JsonEditorProps) {
  const error = jsonError(value);
  const canFormat = value.trim() !== '' && error === undefined;

  const format = () => {
    try {
      onChange(JSON.stringify(JSON.parse(value), null, 2));
    } catch {
      /* button is disabled while invalid; ignore */
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={format}
          disabled={disabled === true || !canFormat}
        >
          <Wand2 className="h-3.5 w-3.5" />
          Format
        </Button>
      </div>
      <AutoTextarea
        id={id}
        className="font-mono"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        spellCheck={false}
        {...(disabled !== undefined ? { disabled } : {})}
        {...(error !== undefined ? { 'aria-invalid': true } : {})}
      />
      {error !== undefined && <p className="text-xs text-destructive">JSON error: {error}</p>}
    </div>
  );
}
