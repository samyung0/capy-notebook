import { Collapsible } from 'radix-ui';
import { useEffect, useRef, useState } from 'react';
import * as limits from '@/api/limits.generated';
import { Button } from '@/components/ui/Button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu';
import { Icon } from '@/components/ui/Icon';
import { Input } from '@/components/ui/Input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/Popover';
import { ToolbarButton } from '@/components/ui/ToolbarButton';
import { m } from '@/i18n';
import { textLength } from '@/lib/textLength';
import { Field, SelectField } from './editorFields';
import { createGraphBoard, GraphError } from './graph';
import type { GraphBlock, GraphElement } from './types';

const graphLabels = {
  angle: m.question_ui_angle,
  arc: m.question_ui_arc,
  circle: m.question_ui_circle,
  functiongraph: m.question_ui_function,
  line: m.question_ui_line,
  point: m.question_ui_point,
  polygon: m.question_ui_polygon,
  sector: m.question_ui_sector,
  segment: m.question_ui_segment,
  text: m.question_ui_label,
};

const graphTypes = [
  'functiongraph',
  'point',
  'line',
  'segment',
  'circle',
  'angle',
  'arc',
  'sector',
  'polygon',
  'text',
] as const;

/** How many existing points an element needs before it can be added. */
const pointsNeeded: Partial<Record<GraphElement['type'], number>> = {
  angle: 3,
  arc: 3,
  circle: 1,
  line: 2,
  polygon: 3,
  sector: 3,
  segment: 2,
};

export function GraphEditor({
  value,
  onChange,
}: {
  value: GraphBlock;
  onChange: (value: GraphBlock) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    let destroy = () => {};
    setError('');
    const target = container.current;
    if (!target) return;
    const stage = document.createElement('div');
    stage.style.width = '100%';
    stage.style.aspectRatio = `${value.width} / ${value.height}`;
    target.append(stage);
    createGraphBoard(stage, value)
      .then((board) => {
        if (cancelled) board.destroy();
        else {
          destroy = board.destroy;
          const svg = stage.querySelector('svg');
          if (svg) {
            svg.setAttribute(
              'viewBox',
              `0 0 ${stage.clientWidth} ${stage.clientHeight}`
            );
            svg.setAttribute('width', '100%');
            svg.setAttribute('height', '100%');
          }
        }
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setError(
            error instanceof GraphError
              ? error.message
              : m.question_ui_graph_could_not_load()
          );
      });
    return () => {
      cancelled = true;
      destroy();
      stage.remove();
    };
  }, [value]);
  const update = (id: string, next: GraphElement) =>
    onChange({
      ...value,
      elements: value.elements.map((element) =>
        element.id === id ? next : element
      ),
    });
  const points = value.elements
    .filter((element) => element.type === 'point')
    .map((element) => ({
      label: element.name || element.id,
      value: element.id,
    }));
  const add = (type: GraphElement['type']) => {
    const id = crypto.randomUUID();
    let element: GraphElement;
    switch (type) {
      case 'functiongraph':
        element = { id, term: 'x', type };
        break;
      case 'point':
        element = {
          coords: [0, 0],
          id,
          name: String.fromCharCode(65 + points.length),
          type,
        };
        break;
      case 'text':
        element = { coords: [0, 0], id, text: '', type };
        break;
      case 'circle':
        if (!points.length) return;
        element = { center: points[0].value, id, radius: 1, type };
        break;
      case 'line':
      case 'segment':
        if (points.length < 2) return;
        element = { id, points: [points[0].value, points[1].value], type };
        break;
      case 'angle':
        if (points.length < 3) return;
        element = {
          id,
          points: [points[0].value, points[1].value, points[2].value],
          type,
        };
        break;
      case 'arc':
      case 'sector':
        if (points.length < 3) return;
        element = {
          center: points[0].value,
          id,
          points: [points[1].value, points[2].value],
          type,
        };
        break;
      case 'polygon':
        if (points.length < 3) return;
        element = {
          id,
          points: points.slice(0, 3).map((point) => point.value),
          type,
        };
        break;
    }
    onChange({ ...value, elements: [...value.elements, element] });
  };
  return (
    <div className="grid min-w-0 items-start gap-6 md:grid-cols-2">
      <div className="min-w-0">
        <div className="w-full bg-white" ref={container} />
        {error && (
          <p className="text-solid-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="min-w-0 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">{m.question_ui_elements()}</h3>
          <Popover>
            <PopoverTrigger asChild>
              <ToolbarButton label={m.question_ui_add_graph_element()}>
                <Icon name="plus" />
              </ToolbarButton>
            </PopoverTrigger>
            <PopoverContent>
              {graphTypes.map((type) => (
                <Button
                  disabled={points.length < (pointsNeeded[type] ?? 0)}
                  key={type}
                  onClick={() => add(type)}
                  type="button"
                  variant="ghost"
                >
                  {graphLabels[type]()}
                </Button>
              ))}
            </PopoverContent>
          </Popover>
        </div>
        {value.elements.map((element) => (
          <div
            className="flex items-end gap-3 border-divider border-b py-3"
            key={element.id}
          >
            <div className="min-w-0 flex-1 space-y-2">
              {element.type === 'functiongraph' && (
                <Field
                  count={{
                    max: limits.QUESTION_GRAPH_TERM_MAX,
                    value: textLength(element.term),
                  }}
                  label={m.question_ui_function_f_x()}
                >
                  <Input
                    onChange={(event) =>
                      update(element.id, {
                        ...element,
                        term: event.target.value,
                      })
                    }
                    value={element.term}
                  />
                </Field>
              )}
              {(element.type === 'point' || element.type === 'text') && (
                <>
                  <Field
                    count={
                      element.type === 'point'
                        ? {
                            max: limits.QUESTION_METADATA_MAX,
                            value: textLength(element.name),
                          }
                        : {
                            max: limits.QUESTION_TEXT_MAX,
                            value: textLength(element.text),
                          }
                    }
                    label={
                      element.type === 'point'
                        ? m.question_ui_point_name()
                        : m.question_ui_label()
                    }
                  >
                    <Input
                      onChange={(event) =>
                        update(
                          element.id,
                          element.type === 'point'
                            ? { ...element, name: event.target.value }
                            : { ...element, text: event.target.value }
                        )
                      }
                      value={
                        element.type === 'point'
                          ? (element.name ?? '')
                          : element.text
                      }
                    />
                  </Field>
                  <div className="grid grid-cols-2 gap-2">
                    {(['x', 'y'] as const).map((axis, i) => (
                      <Field key={axis} label={axis}>
                        <Input
                          onChange={(event) =>
                            update(element.id, {
                              ...element,
                              coords:
                                i === 0
                                  ? [
                                      event.target.valueAsNumber,
                                      element.coords[1],
                                    ]
                                  : [
                                      element.coords[0],
                                      event.target.valueAsNumber,
                                    ],
                            })
                          }
                          type="number"
                          value={
                            Number.isFinite(element.coords[i])
                              ? element.coords[i]
                              : ''
                          }
                        />
                      </Field>
                    ))}
                  </div>
                </>
              )}
              {(element.type === 'line' || element.type === 'segment') && (
                <div className="grid grid-cols-2 gap-2">
                  {[0, 1].map((i) => (
                    <SelectField
                      key={i}
                      label={m.question_ui_graph_point({
                        kind: graphLabels[element.type](),
                        number: i + 1,
                      })}
                      onChange={(id) =>
                        update(element.id, {
                          ...element,
                          points:
                            i === 0
                              ? [id, element.points[1]]
                              : [element.points[0], id],
                        })
                      }
                      options={points}
                      value={element.points[i]}
                    />
                  ))}
                </div>
              )}
              {element.type === 'angle' && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {[0, 1, 2].map((i) => (
                      <SelectField
                        key={i}
                        label={
                          i === 1
                            ? m.question_ui_vertex()
                            : m.question_ui_graph_point({
                                kind: graphLabels.angle(),
                                number: i === 0 ? 1 : 2,
                              })
                        }
                        onChange={(id) =>
                          update(element.id, {
                            ...element,
                            points: element.points.map((point, j) =>
                              j === i ? id : point
                            ) as [string, string, string],
                          })
                        }
                        options={points}
                        value={element.points[i]}
                      />
                    ))}
                  </div>
                  <Field
                    count={{
                      max: limits.QUESTION_METADATA_MAX,
                      value: textLength(element.label),
                    }}
                    label={m.question_ui_label()}
                  >
                    <Input
                      onChange={(event) =>
                        update(element.id, {
                          ...element,
                          label: event.target.value,
                        })
                      }
                      value={element.label ?? ''}
                    />
                  </Field>
                </>
              )}
              {(element.type === 'arc' || element.type === 'sector') && (
                <div className="grid grid-cols-3 gap-2">
                  <SelectField
                    label={m.question_ui_center()}
                    onChange={(center) =>
                      update(element.id, { ...element, center })
                    }
                    options={points}
                    value={element.center}
                  />
                  {[0, 1].map((i) => (
                    <SelectField
                      key={i}
                      label={m.question_ui_graph_point({
                        kind: graphLabels[element.type](),
                        number: i + 1,
                      })}
                      onChange={(id) =>
                        update(element.id, {
                          ...element,
                          points:
                            i === 0
                              ? [id, element.points[1]]
                              : [element.points[0], id],
                        })
                      }
                      options={points}
                      value={element.points[i]}
                    />
                  ))}
                </div>
              )}
              {element.type === 'polygon' && (
                <>
                  <div className="grid grid-cols-3 gap-2">
                    {element.points.map((point, i) => (
                      <SelectField
                        key={i}
                        label={m.question_ui_graph_point({
                          kind: graphLabels.polygon(),
                          number: i + 1,
                        })}
                        onChange={(id) =>
                          update(element.id, {
                            ...element,
                            points: element.points.map((value, j) =>
                              j === i ? id : value
                            ),
                          })
                        }
                        options={points}
                        value={point}
                      />
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Button
                      disabled={
                        element.points.length >= points.length ||
                        element.points.length >=
                          limits.QUESTION_GRAPH_POLYGON_MAX
                      }
                      onClick={() =>
                        update(element.id, {
                          ...element,
                          points: [
                            ...element.points,
                            (
                              points.find(
                                (point) => !element.points.includes(point.value)
                              ) ?? points[0]
                            ).value,
                          ],
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {m.question_ui_add_point()}
                    </Button>
                    <Button
                      disabled={element.points.length <= 3}
                      onClick={() =>
                        update(element.id, {
                          ...element,
                          points: element.points.slice(0, -1),
                        })
                      }
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      {m.question_ui_remove_point()}
                    </Button>
                  </div>
                </>
              )}
              {element.type === 'circle' && (
                <div className="grid grid-cols-2 gap-2">
                  <SelectField
                    label={m.question_ui_center()}
                    onChange={(center) =>
                      update(element.id, { ...element, center })
                    }
                    options={points}
                    value={element.center}
                  />
                  <Field label={m.question_ui_radius()}>
                    <Input
                      onChange={(event) =>
                        update(element.id, {
                          ...element,
                          radius: event.target.valueAsNumber,
                        })
                      }
                      type="number"
                      value={
                        Number.isFinite(element.radius) ? element.radius : ''
                      }
                    />
                  </Field>
                </div>
              )}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <ToolbarButton label={m.question_ui_element_actions()}>
                  <Icon name="moreVertical" />
                </ToolbarButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  onSelect={() =>
                    update(element.id, { ...element, hidden: !element.hidden })
                  }
                >
                  {element.hidden ? m.question_ui_show() : m.question_ui_hide()}
                </DropdownMenuItem>
                {element.type !== 'point' &&
                element.type !== 'text' &&
                element.type !== 'angle' ? (
                  <DropdownMenuItem
                    onSelect={() =>
                      update(element.id, { ...element, dash: !element.dash })
                    }
                  >
                    {element.dash
                      ? m.question_ui_solid_line()
                      : m.question_ui_dashed_line()}
                  </DropdownMenuItem>
                ) : null}
                {element.type === 'segment' && (element.ticks ?? 0) < 3 && (
                  <DropdownMenuItem
                    onSelect={() =>
                      update(element.id, {
                        ...element,
                        ticks: (element.ticks ?? 0) + 1,
                      })
                    }
                  >
                    {m.question_ui_add_equal_length_mark()}
                  </DropdownMenuItem>
                )}
                {element.type === 'segment' && (element.ticks ?? 0) > 0 && (
                  <DropdownMenuItem
                    onSelect={() =>
                      update(element.id, { ...element, ticks: undefined })
                    }
                  >
                    {m.question_ui_remove_equal_length_marks()}
                  </DropdownMenuItem>
                )}
                {(element.type === 'sector' || element.type === 'polygon') && (
                  <DropdownMenuItem
                    onSelect={() =>
                      update(element.id, { ...element, shade: !element.shade })
                    }
                  >
                    {element.shade
                      ? m.question_ui_remove_shading()
                      : m.question_ui_shade()}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onSelect={() =>
                    onChange({
                      ...value,
                      // Drop everything built on a deleted point.
                      elements: value.elements.filter(
                        (item) =>
                          item.id !== element.id &&
                          !(
                            'points' in item && item.points.includes(element.id)
                          ) &&
                          !('center' in item && item.center === element.id)
                      ),
                    })
                  }
                >
                  {m.question_ui_delete()}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ))}
        <Collapsible.Root>
          <Collapsible.Trigger asChild>
            <Button
              iconLeft="chevronDown"
              size="sm"
              type="button"
              variant="ghost"
            >
              {m.question_ui_advanced()}
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content className="space-y-3 pt-3">
            <div className="grid grid-cols-2 gap-3">
              {[
                m.question_ui_x_minimum(),
                m.question_ui_y_maximum(),
                m.question_ui_x_maximum(),
                m.question_ui_y_minimum(),
              ].map((label, i) => (
                <Field key={label} label={label}>
                  <Input
                    onChange={(event) => {
                      const bbox = [
                        ...value.board.bbox,
                      ] as GraphBlock['board']['bbox'];
                      bbox[i] = event.target.valueAsNumber;
                      onChange({ ...value, board: { ...value.board, bbox } });
                    }}
                    type="number"
                    value={
                      Number.isFinite(value.board.bbox[i])
                        ? value.board.bbox[i]
                        : ''
                    }
                  />
                </Field>
              ))}
            </div>
            <div className="flex gap-5">
              <label className="flex items-center gap-2">
                <input
                  checked={value.board.grid}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      board: { ...value.board, grid: event.target.checked },
                    })
                  }
                  type="checkbox"
                />
                {m.question_ui_grid()}
              </label>
              <label className="flex items-center gap-2">
                <input
                  checked={value.board.axis}
                  onChange={(event) =>
                    onChange({
                      ...value,
                      board: { ...value.board, axis: event.target.checked },
                    })
                  }
                  type="checkbox"
                />
                {m.question_ui_axes()}
              </label>
            </div>
            <Field
              count={{
                max: limits.QUESTION_TEXT_MAX,
                value: textLength(value.description),
              }}
              label={m.question_ui_description()}
            >
              <Input
                onChange={(event) =>
                  onChange({ ...value, description: event.target.value })
                }
                value={value.description}
              />
            </Field>
          </Collapsible.Content>
        </Collapsible.Root>
      </div>
    </div>
  );
}
