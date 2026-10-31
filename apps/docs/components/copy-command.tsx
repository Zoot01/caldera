'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

/** A shell command in a box, with a button that copies it. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <div className="flex items-center gap-2 rounded-lg border bg-fd-background py-1.5 ps-3 pe-1.5 font-mono text-sm">
      <span className="select-none text-fd-muted-foreground">$</span>
      <code className="flex-1 truncate">{command}</code>
      <button type="button" onClick={copy} aria-label="Copy the command" className="flex size-7 items-center justify-center rounded-md text-fd-muted-foreground transition-colors hover:bg-fd-accent hover:text-fd-foreground">
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </button>
    </div>
  );
}
