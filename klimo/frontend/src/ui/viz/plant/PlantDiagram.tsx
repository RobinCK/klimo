import { useMemo, type CSSProperties, type ReactNode } from 'react';
import type { Reason, SchemaEdge, SchemaNode } from '@api/model';
import { useUiText } from '../../UiTextContext';
import { layoutPlant } from './layout';
import { edgeColor, PlantNodeCard } from './parts';
import s from './plant.module.css';

export interface PlantDiagramProps {
  nodes: readonly SchemaNode[];
  edges: readonly SchemaEdge[];
  /** Columns left to right with their headers («Джерела», «Колектор», «Контури й насоси», «Кімнати»). */
  columns: readonly { key: string; label: string }[];
  /** Turns a node's state/meta and an edge's label code into words. */
  renderState: (r: Reason) => string;
  /** Caption of the lower band («У кімнатах — напряму, без контурів»). */
  bandLabel?: string;
  /** The energy strip, drawn full width under the bands. */
  energy?: ReactNode;
  onNodeClick?: (node: SchemaNode) => void;
  ariaLabel?: string;
}

/**
 * Sources → manifolds → circuits → rooms on a fixed canvas (the page puts it in a horizontal
 * scroller). Tone and dash say whether energy flows; the same view serves live state and the
 * «what if» simulation.
 */
export function PlantDiagram({ nodes, edges, columns, renderState, bandLabel, energy, onNodeClick, ariaLabel }: PlantDiagramProps) {
  const ut = useUiText();
  const hasEnergy = energy != null;
  const layout = useMemo(() => layoutPlant(nodes, edges, columns, hasEnergy), [nodes, edges, columns, hasEnergy]);
  const titles = useMemo(() => new Map(nodes.map((n) => [n.key, n.title])), [nodes]);

  // screen readers get the arrows as text on the node they leave from
  const outgoing = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of edges) {
      const to = titles.get(e.to);
      if (!to) continue;
      const label = e.label ? renderState(e.label) : '';
      const list = m.get(e.from) ?? [];
      list.push(label ? `→ ${to} (${label})` : `→ ${to}`);
      m.set(e.from, list);
    }
    return m;
  }, [edges, titles, renderState]);

  return (
    <figure
      className={s.diagram}
      style={{ width: `${layout.width}px`, height: `${layout.height}px` } as CSSProperties}
      aria-label={ariaLabel ?? ut('Plant diagram')}
    >
      <svg className={s.edges} width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
        {layout.divider != null ? <path d={`M24 ${layout.divider}H${layout.width - 24}`} className={s.divider} /> : null}
        {layout.edges.map(({ edge, path, head }) => {
          const color = edgeColor(edge.tone, edge.dashed);
          return (
            <g key={`${edge.from}->${edge.to}`} style={{ '--edge': color } as CSSProperties}>
              <path d={path} className={s.edgeLine} data-dashed={edge.dashed ? '' : undefined} />
              <path d={head} className={s.edgeHead} />
            </g>
          );
        })}
      </svg>

      {layout.columns.map((c) => (
        <span key={c.key} className={s.columnHead} style={{ left: `${c.x}px` }}>
          {c.label}
        </span>
      ))}
      {layout.divider != null && bandLabel ? (
        <span className={s.bandLabel} style={{ top: `${layout.divider + 16}px` }}>
          {bandLabel}
        </span>
      ) : null}

      {layout.edges.map(({ edge, label }) =>
        edge.label && label ? (
          <span
            key={`${edge.from}->${edge.to}:label`}
            className={s.edgeLabel}
            style={{ left: `${label.x}px`, top: `${label.y}px`, maxWidth: `${label.w}px` }}
            aria-hidden="true"
          >
            {renderState(edge.label)}
          </span>
        ) : null,
      )}

      {layout.nodes.map(({ node, x, y, w, h, size }) => (
        <div key={node.key} className={s.nodeSlot} style={{ left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` }}>
          <PlantNodeCard
            icon={node.icon}
            title={node.title}
            state={renderState(node.state)}
            meta={node.meta ? renderState(node.meta) : null}
            tone={node.tone}
            size={size}
            dashed={node.dashed}
            onClick={onNodeClick ? () => onNodeClick(node) : undefined}
            srText={outgoing.get(node.key)?.join('; ')}
          />
        </div>
      ))}

      {layout.energy && energy != null ? (
        <div className={s.energySlot} style={{ left: `${layout.energy.x}px`, top: `${layout.energy.y}px`, width: `${layout.energy.w}px` }}>
          {energy}
        </div>
      ) : null}
    </figure>
  );
}
