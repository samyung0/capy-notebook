import type { ReactNode } from 'react';
import { Card } from '@/components/ui/Card';
import { cn } from '@/lib/cn';

// The shared bar shape has no router, search, or editor dependencies.
export function TopInsetFrame({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        'top-inset-bar-shape flex-row items-center justify-between gap-2.5 py-1.5 pr-3 pl-4',
        className
      )}
      radius="unset"
      theme="surface-dark"
    >
      {children}
    </Card>
  );
}
