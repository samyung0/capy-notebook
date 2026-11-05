import { Badge } from '@/components/ui/Badge';
import { cn } from '@/lib/cn';
import { lateLabel } from './assignmentText';

/** A late submission's mark (Epo 2026-11-05): "Late", or "Late −20%" when that
 * cost marks. */
export function LateBadge({
  className,
  penaltyPct,
}: {
  className?: string;
  penaltyPct: number;
}) {
  return (
    <Badge
      className={cn('shrink-0 whitespace-nowrap', className)}
      size="sm"
      tone="warning"
    >
      {lateLabel(penaltyPct)}
    </Badge>
  );
}
