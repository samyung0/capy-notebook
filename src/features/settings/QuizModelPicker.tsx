import { useEffect, useState } from 'react';
import { useModels, useSetModelPrefs } from '@/api/hooks';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/Select';
import { browserLlmHost } from '@/features/quizzes/browserLlm';
import {
  BROWSER_QUIZ_MODELS,
  type BrowserQuizModel,
  browserModelWarn,
  browserQuizModel,
  formatBytes,
  isBrowserQuizModel,
} from '@/features/quizzes/browserModels';
import { m } from '@/i18n';
import { cn } from '@/lib/cn';

function cloudLabel(key: string, fallback: string): string {
  switch (key) {
    case 'deepseek-flash':
      return m.model_deepseek_flash();
    case 'deepseek-pro':
      return m.model_deepseek_pro();
    default:
      return fallback;
  }
}

function SlowIcon() {
  return (
    <Icon
      aria-label={m.quiz_model_slow_icon()}
      className="size-3.5 shrink-0 text-tint-warning-fg"
      name="warning"
    />
  );
}

function BrowserOptionLabel({
  model,
  warn,
}: {
  model: BrowserQuizModel;
  warn: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {warn ? <SlowIcon /> : null}
      <span className="min-w-0 truncate">{model.displayName}</span>
    </span>
  );
}

export function QuizModelPicker({ className }: { className?: string }) {
  const { data } = useModels('quiz', { errorBoundary: false });
  const { isPending, mutate } = useSetModelPrefs();
  const [downloadPct, setDownloadPct] = useState<number | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [isolated, setIsolated] = useState<boolean | null>(null);
  const [webgpu, setWebgpu] = useState<boolean | null>(null);
  const cloud = data?.models ?? [];
  const selectedKey = data?.selectedKey || '';
  const browser = browserQuizModel(selectedKey);
  const selectedWarn = browser
    ? browserModelWarn(browser, { isolated, webgpu })
    : null;

  useEffect(() => {
    let cancelled = false;
    void browserLlmHost()
      .probeRuntime()
      .then((caps) => {
        if (cancelled) return;
        setIsolated(caps.isolated);
        setWebgpu(caps.webgpu);
      })
      .catch(() => {
        if (cancelled) return;
        setIsolated(false);
        setWebgpu(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Select
        disabled={isPending}
        onValueChange={(key) => {
          setDownloadError('');
          mutate({ quizModelKey: key });
        }}
        value={selectedKey || undefined}
      >
        <SelectTrigger
          aria-label={m.settings_llm_quiz()}
          className="w-full max-w-sm"
        >
          <SelectValue placeholder={m.model_picker_label()} />
        </SelectTrigger>
        <SelectContent>
          {cloud.map((option) => (
            <SelectItem key={option.key} value={option.key}>
              {cloudLabel(option.key, option.displayName)}
              {option.isDefault ? ` · ${m.settings_llm_default()}` : ''}
            </SelectItem>
          ))}
          {BROWSER_QUIZ_MODELS.map((option) => {
            const warn = !!browserModelWarn(option, { isolated, webgpu });
            return (
              <SelectItem key={option.id} value={option.id}>
                <BrowserOptionLabel model={option} warn={warn} />
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      {selectedWarn ? (
        <p
          className="flex items-start gap-2 rounded-button border border-solid-warning/40 bg-tint-warning px-3 py-2 text-sm text-tint-warning-fg"
          role="status"
        >
          <Icon className="mt-0.5 size-4 shrink-0" name="warning" />
          <span>
            {selectedWarn === 'isolation'
              ? m.quiz_model_warn_ternary()
              : m.quiz_model_warn_webgpu()}
          </span>
        </p>
      ) : null}
      {browser ? (
        <p className="text-fg-muted text-sm">{browser.description}</p>
      ) : null}
      {isBrowserQuizModel(selectedKey) && browser ? (
        <div className="mt-1 flex flex-col items-start gap-1.5">
          <Button
            disabled={downloadPct != null}
            onClick={() => {
              setDownloadError('');
              setDownloadPct(0);
              void browserLlmHost()
                .download(selectedKey, ({ loaded, total }) => {
                  if (total) setDownloadPct(Math.round((loaded / total) * 100));
                })
                .then(() => setDownloadPct(null))
                .catch((err) => {
                  setDownloadPct(null);
                  setDownloadError(
                    err instanceof Error
                      ? err.message
                      : m.quiz_model_download_failed()
                  );
                });
            }}
            size="sm"
            variant="outline"
          >
            {downloadPct == null
              ? m.quiz_model_download({ size: formatBytes(browser.bytes) })
              : m.quiz_model_downloading({ pct: String(downloadPct) })}
          </Button>
          {downloadError ? (
            <p className="text-sm text-tint-error-fg">{downloadError}</p>
          ) : (
            <p className="text-fg-muted text-sm">{m.quiz_model_cache_hint()}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
