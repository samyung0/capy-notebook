import type { RowProps, TableProps } from '../schema';
import { CiteFooter, elements } from './Cite';

/** A read-only table. Citations sit under the block, never inside a cell. */
export function ChatTable({ props }: { props: TableProps }) {
  const rows = elements<RowProps>(props.rows);
  const columns = props.columns ?? [];
  return (
    <div className="flex flex-col gap-1.5">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          {props.caption ? (
            <caption className="pb-2 text-left font-semibold text-[13.5px] text-fg">
              {props.caption}
            </caption>
          ) : null}
          <thead>
            <tr>
              {columns.map((column, index) => (
                <th
                  className="bg-page px-2 py-1.5 text-left font-semibold text-[11px] text-fg-secondary"
                  key={index}
                  scope="col"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr className="border-divider border-b" key={index}>
                {columns.map((_, cell) => (
                  <td
                    className="px-2 py-1.5 align-top first:font-semibold"
                    key={cell}
                  >
                    {row.props.cells[cell] ?? ''}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <CiteFooter
        passages={props.passages}
        rows={rows.map((row, index) => ({
          index,
          passages: row.props.passages,
        }))}
      />
    </div>
  );
}
