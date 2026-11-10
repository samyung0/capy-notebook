import { TableBlockModel } from '@blocksuite/affine/model';
import {
  deleteSelectedModelsCommand,
  duplicateSelectedModelsCommand,
  getSelectedModelsCommand,
} from '@blocksuite/affine/shared/commands';
import {
  type ToolbarContext,
  ToolbarModuleExtension,
} from '@blocksuite/affine/shared/services';
import { BlockFlavourIdentifier } from '@blocksuite/affine/std';
import {
  Copy02Icon,
  Delete02Icon,
  LayoutTable01Icon,
} from '@hugeicons/core-free-icons';
import { html } from 'lit';
import { m } from '@/i18n';
import { hugeIcon } from './chromeIcons';

/** A header row is a prop of ours on the row (todo-blocksuite-layout.md, Tables). */
type Row = { header?: boolean; order: string; rowId: string };

const tableOf = (ctx: ToolbarContext) => {
  const model = ctx.getCurrentModel();
  return model instanceof TableBlockModel ? model : null;
};

const firstRow = (model: TableBlockModel) =>
  (Object.values(model.props.rows) as Row[]).reduce<Row | null>(
    (first, row) => (first && first.order <= row.order ? first : row),
    null
  );

const selected = (ctx: ToolbarContext) =>
  ctx.chain.pipe(getSelectedModelsCommand, {
    mode: 'highest',
    types: ['block'],
  });

/**
 * A selected table's bar (Epo 2026-11-10, mock T2): Header row, Duplicate and
 * Delete. Rows and columns have their own handles and menus (BlockSuite's);
 * this is what applies to the table as a whole, in the one floating bar.
 */
export const tableBar = ToolbarModuleExtension({
  config: {
    actions: [
      {
        active: (ctx: ToolbarContext) => {
          const model = tableOf(ctx);
          return Boolean(model && firstRow(model)?.header);
        },
        icon: html`${hugeIcon(LayoutTable01Icon)}`,
        id: 'a.header-row',
        label: m.question_ui_header_row(),
        run: (ctx: ToolbarContext) => {
          const model = tableOf(ctx);
          const row = model && firstRow(model);
          if (!(model && row)) return;
          ctx.store.captureSync();
          // The first row alone carries it (the table keeps it there as rows
          // move: vendor README local change 38).
          ctx.store.transact(() => {
            const rows = model.props.rows as Record<string, Row>;
            const on = !row.header;
            for (const id of Object.keys(rows)) delete rows[id].header;
            if (on) rows[row.rowId].header = true;
          });
        },
        showLabel: true,
        tooltip: m.question_ui_header_row(),
      },
      {
        icon: html`${hugeIcon(Copy02Icon)}`,
        id: 'b.duplicate',
        label: m.chrome_duplicate(),
        run: (ctx: ToolbarContext) => {
          ctx.store.captureSync();
          selected(ctx).pipe(duplicateSelectedModelsCommand).run();
        },
        tooltip: m.chrome_duplicate(),
      },
      {
        icon: html`${hugeIcon(Delete02Icon)}`,
        id: 'c.delete',
        label: m.action_delete(),
        run: (ctx: ToolbarContext) => {
          selected(ctx).pipe(deleteSelectedModelsCommand).run();
        },
        tooltip: m.action_delete(),
        variant: 'destructive' as const,
      },
    ],
  },
  id: BlockFlavourIdentifier('affine:table'),
});
