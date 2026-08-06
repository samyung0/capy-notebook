import { ArrowUpFromLine, ChevronDown } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { userToast } from '@/components/ui/userToast';
import { ToolbarButton } from '@/features/notes/toolbar/ToolbarButton';
import { MenuRow } from '@/features/notes/toolbar/ToolbarMenuRow';

export type ImportKind = 'markdown' | 'docx' | 'json';

const IMPORT_OPTIONS: Record<
  ImportKind,
  { accept: string; extensions: string[]; maxBytes: number }
> = {
  docx: {
    accept:
      '.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    extensions: ['.docx'],
    maxBytes: 25 * 1024 * 1024,
  },
  json: {
    accept: '.json,.plate.json,application/json',
    extensions: ['.json'],
    maxBytes: 10 * 1024 * 1024,
  },
  markdown: {
    accept: '.md,.mdx,text/markdown,text/mdx',
    extensions: ['.md', '.mdx'],
    maxBytes: 5 * 1024 * 1024,
  },
};

function validateImportFile(file: File, kind: ImportKind) {
  const option = IMPORT_OPTIONS[kind];
  const name = file.name.toLowerCase();

  if (!option.extensions.some((extension) => name.endsWith(extension))) {
    throw new Error(`Choose a ${option.extensions.join(' or ')} file.`);
  }
  if (file.size === 0) {
    throw new Error('The selected file is empty.');
  }
  if (file.size > option.maxBytes) {
    throw new Error(
      `The selected file is larger than ${option.maxBytes / 1024 / 1024} MB.`
    );
  }
}

export function ImportMenu({
  importFile,
}: {
  importFile: (file: File, kind: ImportKind) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const markdownInput = useRef<HTMLInputElement>(null);
  const docxInput = useRef<HTMLInputElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const inputRefs = {
    docx: docxInput,
    json: jsonInput,
    markdown: markdownInput,
  } satisfies Record<ImportKind, React.RefObject<HTMLInputElement | null>>;

  const chooseFile = (kind: ImportKind) => {
    setOpen(false);
    inputRefs[kind].current?.click();
  };

  const handleFile = async (
    event: React.ChangeEvent<HTMLInputElement>,
    kind: ImportKind
  ) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      validateImportFile(file, kind);
      await importFile(file, kind);
    } catch (cause) {
      userToast({
        description:
          cause instanceof Error
            ? cause.message
            : 'The selected file could not be read.',
        title: 'Import failed',
        variant: 'error',
      });
    }
  };

  return (
    <>
      {(Object.keys(IMPORT_OPTIONS) as ImportKind[]).map((kind) => (
        <input
          accept={IMPORT_OPTIONS[kind].accept}
          className="hidden"
          key={kind}
          onChange={(event) => void handleFile(event, kind)}
          ref={inputRefs[kind]}
          type="file"
        />
      ))}
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <ToolbarButton className="w-fit" label="Import document">
            <ArrowUpFromLine />
            <ChevronDown className="size-3! text-fg-secondary" />
          </ToolbarButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="w-52 gap-0.5 border border-line bg-surface p-1 shadow-pop"
        >
          <MenuRow
            label="Import Markdown (.md)"
            onClick={() => chooseFile('markdown')}
          />
          <MenuRow
            label="Import Word (.docx)"
            onClick={() => chooseFile('docx')}
          />
          <MenuRow label="Import JSON" onClick={() => chooseFile('json')} />
        </PopoverContent>
      </Popover>
    </>
  );
}
