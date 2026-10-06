import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FloatingToolbar } from '@/components/ui/BlockToolbar';
import { Button } from '@/components/ui/Button';
import { ContentSwap } from '@/components/ui/ContentSwap';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/ContextMenu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Menu } from '@/components/ui/Menu';
import '@/styles/tailwind.css';

function MotionChecks() {
  const [open, setOpen] = useState(false);
  const [copy, setCopy] = useState(false);
  const [action, setAction] = useState('none');
  const [executions, setExecutions] = useState(0);

  return (
    <main className="flex flex-col items-start gap-2 p-4">
      <Button onClick={() => setOpen(!open)}>Toggle tool</Button>
      <FloatingToolbar
        data-testid="tool"
        open={open}
        positionClassName="fixed z-50"
        style={{ left: 0, top: 0, transform: 'translate(360px, 80px)' }}
      >
        <button type="button">Tool action</button>
      </FloatingToolbar>
      <Button onClick={() => setCopy(!copy)}>Change copy</Button>
      <ContentSwap contentKey={String(copy)}>
        {copy ? 'Copied' : 'Copy'}
      </ContentSwap>
      <Menu
        alignWidthToTrigger
        items={[
          {
            label: 'Rename',
            onClick: () => {
              setAction('rename');
              setExecutions((count) => count + 1);
            },
          },
          { disabled: true, label: 'Unavailable' },
          {
            danger: true,
            label: 'Delete',
            onClick: () => {
              setAction('delete');
              setExecutions((count) => count + 1);
            },
          },
        ]}
        trigger={<Button className="w-64">Actions</Button>}
      />
      <output>{action}</output>
      <span data-testid="executions">{executions}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button>Nested actions</Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>More actions</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem
                onSelect={() => setExecutions((count) => count + 1)}
              >
                Nested action
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <Button>Context actions</Button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuSub>
            <ContextMenuSubTrigger>More actions</ContextMenuSubTrigger>
            <ContextMenuSubContent>
              <ContextMenuItem
                onSelect={() => setExecutions((count) => count + 1)}
              >
                Nested action
              </ContextMenuItem>
            </ContextMenuSubContent>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenu>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MotionChecks />
  </StrictMode>
);
