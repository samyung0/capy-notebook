import type { Editor, JSONContent } from '@tiptap/core';
import { Loader2Icon, SaveIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import type {
  EditorTemplate,
  RenderedPreview,
} from '~/lib/email-template-types';
import { requestPreview, saveSource } from '~/lib/repository-api';
import {
  type EmailLocale,
  type EmailTemplateSource,
  emailLocales,
} from '../../../schema';
import { CopyEmailHtml } from './copy-email-html';
import { EmailEditor } from './email-editor';
import { PreviewEmailDialog } from './preview-email-dialog';
import { PreviewTextInfo } from './preview-text-info';
import { Input } from './ui/input';

interface EmailEditorSandboxProps {
  templates: ReadonlyArray<EditorTemplate>;
}

function localeLabel(locale: EmailLocale) {
  if (locale === 'en') return 'English';
  if (locale === 'zh') return '中文';
  return locale;
}

export function EmailEditorSandbox({
  templates: initialTemplates,
}: EmailEditorSandboxProps) {
  const [templates, setTemplates] = useState(initialTemplates);
  const [templateId, setTemplateId] = useState(initialTemplates[0]?.id ?? '');
  const [locale, setLocale] = useState<EmailLocale>('en');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [dirtySources, setDirtySources] = useState<Set<string>>(
    () => new Set()
  );
  const [isSaving, setIsSaving] = useState(false);

  const template = templates.find((candidate) => candidate.id === templateId);
  const source = template?.sources[locale];
  const sourceKey = template ? `${template.id}.${locale}` : '';
  const hasChanges = dirtySources.has(sourceKey);

  useEffect(() => {
    setEditor(null);
  }, [sourceKey]);

  useEffect(() => {
    if (dirtySources.size === 0) return;
    const warnAboutUnsavedChanges = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warnAboutUnsavedChanges);
    return () =>
      window.removeEventListener('beforeunload', warnAboutUnsavedChanges);
  }, [dirtySources.size]);

  function updateSource(patch: Partial<EmailTemplateSource>) {
    if (!template) return;
    setTemplates((current) =>
      current.map((candidate) =>
        candidate.id === template.id
          ? {
              ...candidate,
              sources: {
                ...candidate.sources,
                [locale]: { ...candidate.sources[locale], ...patch },
              },
            }
          : candidate
      )
    );
    setDirtySources((current) => new Set(current).add(sourceKey));
  }

  function currentSource() {
    if (!source) return;
    return {
      ...source,
      content: (editor?.getJSON() ??
        source.content) as EmailTemplateSource['content'],
    };
  }

  async function renderCurrentSource(): Promise<RenderedPreview> {
    const snapshot = currentSource();
    if (!template || !snapshot) throw new Error('No template is selected');
    return requestPreview(template.id, locale, snapshot);
  }

  async function saveCurrentSource() {
    const snapshot = currentSource();
    if (!template || !snapshot) return;
    setIsSaving(true);
    try {
      await saveSource(template.id, locale, snapshot);
      setTemplates((current) =>
        current.map((candidate) =>
          candidate.id === template.id
            ? {
                ...candidate,
                sources: { ...candidate.sources, [locale]: snapshot },
              }
            : candidate
        )
      );
      setDirtySources((current) => {
        const next = new Set(current);
        next.delete(sourceKey);
        return next;
      });
      toast.success('Template source saved');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Save failed');
    } finally {
      setIsSaving(false);
    }
  }

  if (!template || !source) {
    return (
      <main className="grid min-h-screen place-items-center text-gray-600">
        No email templates were found.
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-white pb-10">
      <header className="border-gray-200 border-b">
        <div className="mx-auto flex max-w-[calc(600px+80px)] items-center justify-between gap-3 px-10 py-4 max-md:items-start max-md:px-5">
          <div className="flex min-w-0 items-center gap-2.5">
            <img alt="Maily" className="size-8" src="/brand/icon.svg" />
            <div className="min-w-0">
              <h1 className="truncate font-semibold text-sm">
                Evo Notes email editor
              </h1>
              <p className="truncate text-gray-500 text-xs">Powered by Maily</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <PreviewEmailDialog
              disabled={!editor}
              renderPreview={renderCurrentSource}
            />
            <CopyEmailHtml
              disabled={!editor}
              renderPreview={renderCurrentSource}
            />
            <button
              className="flex min-h-[28px] cursor-pointer items-center justify-center rounded-md bg-black px-2 py-1 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50 max-lg:w-7"
              disabled={isSaving || !hasChanges}
              onClick={() => void saveCurrentSource()}
              type="button"
            >
              {isSaving ? (
                <Loader2Icon className="inline-block size-4 shrink-0 animate-spin lg:mr-1" />
              ) : (
                <SaveIcon className="inline-block size-4 shrink-0 lg:mr-1" />
              )}
              <span className="hidden lg:inline-block">Save source</span>
            </button>
          </div>
        </div>
      </header>

      <div className="mx-auto mt-5 flex max-w-[calc(600px+80px)] flex-wrap items-center gap-2 px-10 max-md:px-5">
        <label className="sr-only" htmlFor="email-template">
          Template
        </label>
        <select
          className="h-9 min-w-52 grow rounded-md border border-gray-200 bg-white px-3 text-sm"
          id="email-template"
          onChange={(event) => setTemplateId(event.target.value)}
          value={templateId}
        >
          {templates.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.label}
            </option>
          ))}
        </select>
        <div
          aria-label="Template language"
          className="flex rounded-md border border-gray-200 bg-gray-50 p-0.5"
          role="group"
        >
          {emailLocales.map((candidateLocale) => (
            <button
              aria-pressed={locale === candidateLocale}
              className="rounded px-2 py-1 text-sm aria-pressed:bg-black aria-pressed:text-white"
              key={candidateLocale}
              onClick={() => setLocale(candidateLocale)}
              type="button"
            >
              {localeLabel(candidateLocale)}
            </button>
          ))}
        </div>
        <span className="text-gray-500 text-xs">
          {hasChanges ? 'Unsaved changes' : `${sourceKey}.json`}
        </span>
      </div>

      <div className="mx-auto mt-5 max-w-[calc(600px+80px)] px-10 max-md:px-5">
        <div className="flex items-center font-normal">
          <label
            className="w-24 shrink-0 text-gray-600 after:ml-0.5 after:text-red-400 after:content-['*']"
            htmlFor="email-subject"
          >
            Subject
          </label>
          <Input
            className="h-auto rounded-none border-x-0 border-t-0 py-2.5 font-normal focus-visible:ring-0"
            id="email-subject"
            onChange={(event) => updateSource({ subject: event.target.value })}
            placeholder="Email subject"
            type="text"
            value={source.subject}
          />
        </div>
        <div className="relative mt-4">
          <Input
            className="h-auto rounded-none border-x-0 border-t-0 px-0 py-2.5 pr-5 text-base focus-visible:ring-0"
            onChange={(event) => updateSource({ preview: event.target.value })}
            placeholder="Preview text"
            type="text"
            value={source.preview}
          />
          <span className="absolute top-0 right-0 flex h-full items-center">
            <PreviewTextInfo />
          </span>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-gray-500 text-xs">
          <span className="mr-1">Body</span>
          {template.variables.map(({ name }) => (
            <code className="rounded bg-gray-100 px-1.5 py-0.5" key={name}>
              @{name}
            </code>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-gray-500 text-xs">
          <span className="mr-1">Subject and preview</span>
          {template.variables.map(({ name }) => (
            <code className="rounded bg-gray-100 px-1.5 py-0.5" key={name}>
              {`{{.${name}}}`}
            </code>
          ))}
        </div>
      </div>

      <EmailEditor
        autofocus={false}
        content={source.content as JSONContent}
        key={sourceKey}
        onCreate={setEditor}
        onUpdate={(nextEditor) => {
          setEditor(nextEditor);
          updateSource({
            content: nextEditor.getJSON() as EmailTemplateSource['content'],
          });
        }}
        variables={template.variables}
      />

      <p className="mx-auto mt-3 max-w-[calc(600px+80px)] px-10 text-center text-gray-500 text-xs max-md:px-5">
        Save writes the locale JSON source. Run{' '}
        <code className="rounded bg-gray-100 px-1.5 py-0.5">
          pnpm email:build
        </code>{' '}
        to regenerate Go HTML and text templates.
      </p>
    </main>
  );
}
