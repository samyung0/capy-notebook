import type { TableViewBlock, TableViewColumn } from './model';

/* The spec's example table view, for the layers' tests. */

export const status: TableViewColumn = {
  id: 'c_status',
  kind: 'select',
  name: 'Status',
  options: [
    { color: 'gray', id: 'o_1', name: 'Not yet' },
    { color: 'orange', id: 'o_2', name: 'Revising' },
    { color: 'green', id: 'o_3', name: 'Done' },
  ],
};

/** The spec's example block. */
export const tracker = (): TableViewBlock =>
  structuredClone<TableViewBlock>({
    columns: [
      status,
      { id: 'c_title', kind: 'title', name: 'Topic' },
      { id: 'c_mark', kind: 'number', name: 'Mark' },
      { id: 'c_review', kind: 'date', name: 'Review on' },
      { id: 'c_done', kind: 'checkbox', name: 'Done' },
    ],
    rows: [
      {
        c_done: false,
        c_mark: 6,
        c_review: '2026-11-10',
        c_status: 'o_2',
        c_title: 'Krebs cycle',
        id: 'r_1',
      },
      { c_done: true, c_status: 'o_3', c_title: 'Glycolysis | ATP', id: 'r_2' },
    ],
    title: 'Revision tracker',
    views: [
      {
        id: 'v_1',
        kind: 'table',
        name: 'Table',
        sort: { columnId: 'c_review', dir: 'asc' },
      },
      { groupBy: 'c_status', id: 'v_2', kind: 'kanban', name: 'Kanban' },
    ],
  });
