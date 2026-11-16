import { parseHTML } from 'linkedom';
import { act, type ReactNode, useState } from 'react';
import { expect, it, vi } from 'vitest';
import type { AssignmentFileRef } from '@/api/types';
import { getLocale, m } from '@/i18n';

getLocale();
const { document, window } = parseHTML(
  '<!doctype html><html><body><div id="root"></div></body></html>'
);
Object.assign(globalThis, { document, IS_REACT_ACT_ENVIRONMENT: true, window });

const asked = vi.hoisted(() => ({ params: {} as { scope?: string } }));
vi.mock('@/api/hooks', () => ({
  // The Files list: a file of a workspace, a block with none, and rows a task
  // cannot hold.
  useItems: (params: { scope?: string }) => {
    asked.params = params;
    return {
      data: {
        pages: [
          {
            items: [
              {
                file: {
                  id: 'f1',
                  kind: 'pdf',
                  name: 'Chapter 4.pdf',
                  workspaceName: 'Biology',
                },
                type: 'file',
              },
              {
                material: { id: 'm1', kind: 'note', title: 'Loose note' },
                type: 'material',
              },
              {
                material: { id: 'c1', kind: 'canvas', title: 'Board' },
                type: 'material',
              },
              { embed: { assetId: 'e1' }, type: 'embed' },
            ],
          },
        ],
      },
      hasNextPage: false,
    };
  },
}));
// The menu opens from its trigger and shows its list only while open.
vi.mock('@/components/ui/Popover', async () => {
  const { createContext, useContext } = await import('react');
  const Open = createContext({ open: false, set: (_open: boolean) => {} });
  return {
    Popover: ({
      children,
      onOpenChange,
      open,
    }: {
      children: ReactNode;
      onOpenChange: (open: boolean) => void;
      open: boolean;
    }) => (
      <Open.Provider value={{ open, set: onOpenChange }}>
        {children}
      </Open.Provider>
    ),
    PopoverContent: ({ children }: { children: ReactNode }) =>
      useContext(Open).open ? <section data-picker>{children}</section> : null,
    PopoverTrigger: ({ children }: { children: ReactNode }) => {
      const { set } = useContext(Open);
      return <span onClickCapture={() => set(true)}>{children}</span>;
    },
  };
});
vi.mock('@/features/workspace/PanelSearch', () => ({
  PanelSearchField: () => null,
}));
vi.mock('@/components/app/ListEnd', () => ({ ListEnd: () => null }));
vi.mock('./TodoSection', () => ({ assignmentFileIcon: () => 'pdf' }));

const { createRoot } = await import('react-dom/client');
const { TaskFilesField } = await import('./TaskFiles');
type TaskFile = import('./TaskFiles').TaskFile;

it('picks files from every workspace and none, naming where each sits', async () => {
  let held: AssignmentFileRef[] = [];
  function Form() {
    const [value, setValue] = useState<AssignmentFileRef[]>([]);
    const [picked, setPicked] = useState<TaskFile[]>([]);
    held = value;
    return (
      <TaskFilesField
        onChange={setValue}
        onPicked={(file) => setPicked((rows) => [...rows, file])}
        picked={picked}
        saved={[]}
        value={value}
      />
    );
  }
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<Form />));
  const press = (button: Element | null | undefined) =>
    act(async () => (button as HTMLElement).click());
  const add = () =>
    [...host.querySelectorAll('button')].find(
      (button) => button.textContent === m.assignment_add_file()
    );
  const offered = () => [
    ...(host.querySelector('[data-picker]')?.querySelectorAll('button') ?? []),
  ];

  await press(add());
  expect(asked.params.scope).toBe('all');
  // A canvas and an embedded image are not files to put on a task.
  expect(offered().map((row) => row.textContent)).toEqual([
    'Chapter 4.pdfBiology',
    `Loose note${m.todo_no_workspace()}`,
  ]);
  await press(offered()[0]);
  expect(held).toEqual([{ fileId: 'f1' }]);
  expect(host.querySelector('[data-picker]')).toBeNull();
  expect(host.querySelector('li')?.textContent).toBe('Chapter 4.pdfBiology');
  // A file already on the task is not offered again.
  await press(add());
  expect(offered().map((row) => row.textContent)).toEqual([
    `Loose note${m.todo_no_workspace()}`,
  ]);
  await press(offered()[0]);
  expect(held).toEqual([{ fileId: 'f1' }, { materialId: 'm1' }]);
  await act(async () => root.unmount());
});
