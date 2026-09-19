import { Link, useParams } from '@tanstack/react-router';
import { useState } from 'react';
import { useMaterial } from '@/api/hooks';
import { PageHeader, PanelWithInvertedRadius } from '@/components/app/layout';
import { QueryPausedState } from '@/components/app/QueryPausedState';
import { Icon } from '@/components/ui/Icon';
import { Tabs } from '@/components/ui/Tabs';
import { FileError, FileLoading } from '@/features/files/FileStates';
import { MaterialContent } from '@/features/materials/CenterContent';
import {
  type MaterialMode,
  materialModePolicy,
  resolveMaterialMode,
} from '@/features/materials/modePolicy';
import { m } from '@/i18n';

/** A material outside any workspace: a standalone note, or a single-material
 * clone. Quizzes and flashcard sets keep their own study routes; this page
 * renders the same body the workspace center pane uses. */
export default function MaterialOpen() {
  const params = useParams({ strict: false });
  const materialId = (params as { materialId: string }).materialId;
  const {
    data: material,
    fetchStatus,
    isError,
    isLoading,
  } = useMaterial(materialId, { errorBoundary: false });
  const [mode, setMode] = useState<MaterialMode | null>(null);
  const policy = material
    ? materialModePolicy(material.kind, material.capabilities)
    : null;
  const activeMode = policy ? resolveMaterialMode(mode, policy) : 'view';

  return (
    <PanelWithInvertedRadius>
      <PageHeader
        actions={
          policy?.modes.includes('edit') ? (
            <Tabs
              bottomBorder={false}
              className="w-auto"
              onChange={(value) => setMode(value as MaterialMode)}
              tabs={[
                { label: m.material_mode_edit(), value: 'edit' },
                { label: m.material_mode_view(), value: 'view' },
              ]}
              value={activeMode === 'view' ? 'view' : 'edit'}
            />
          ) : undefined
        }
        title={
          <span className="flex min-w-0 items-center gap-2">
            <Link
              aria-label={m.material_open_back()}
              className="flex size-8 shrink-0 items-center justify-center rounded-button text-fg-muted hover:bg-surface-hover-bg hover:text-fg"
              to="/create"
            >
              <Icon name="arrowLeft" size={18} />
            </Link>
            <span className="truncate">{material?.title ?? ''}</span>
          </span>
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden px-6 pb-4">
        {fetchStatus === 'paused' && !material ? (
          <QueryPausedState />
        ) : isLoading ? (
          <FileLoading />
        ) : isError || !material ? (
          <FileError />
        ) : (
          <MaterialContent
            allowExternalAssets={activeMode !== 'view'}
            forceReadOnly={false}
            key={`${materialId}:${activeMode}`}
            materialId={materialId}
            mode={activeMode}
            onEditorStatusChange={() => {}}
          />
        )}
      </div>
    </PanelWithInvertedRadius>
  );
}
