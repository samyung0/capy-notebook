import type { ReactNode } from 'react';

/** The chat's table look, Billing & usage's at the chat's 12px table text
 * (11px header): no frame, muted header labels, a divider under the header
 * and every row, scrolling sideways. Markdown tables draw with these parts. */
export function TableFrame({ children }: { children?: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">{children}</table>
    </div>
  );
}

export function TableRow({ children }: { children?: ReactNode }) {
  return <tr className="border-divider border-b">{children}</tr>;
}

export function TableHead({ children }: { children?: ReactNode }) {
  return (
    <th
      className="py-2.5 pr-4 align-bottom font-medium text-[11px] text-fg-muted last:pr-0"
      scope="col"
    >
      {children}
    </th>
  );
}

export function TableCell({ children }: { children?: ReactNode }) {
  return <td className="py-3 pr-4 align-top last:pr-0">{children}</td>;
}
