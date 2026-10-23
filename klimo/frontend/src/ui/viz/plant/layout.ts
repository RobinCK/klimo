import type { SchemaEdge, SchemaNode } from '@api/model';

/*
 * Fixed-canvas layout of the plant schema: columns left to right (sources → manifolds →
 * circuits → rooms), a hydronic band on top and a band of room-scope sources below a dashed
 * divider. Positions follow the 1232 × 680 reference canvas: rows every 120 px, 96 px nodes,
 * 80 px gaps where the arrows run.
 */

export type NodeSize = 'source' | 'manifold' | 'rooms';

const COLUMN_WIDTH: Record<string, number> = { sources: 240, manifolds: 200, circuits: 240, rooms: 264 };
const PAD = 24;
const GAP = 80;
const TOP = 56;
const ROW = 120;
export const NODE_H = 96;
const DIVIDER_GAP = 40;
const BAND_GAP = 48;
export const ENERGY_H = 56;

export interface PlacedNode {
  node: SchemaNode;
  x: number;
  y: number;
  w: number;
  h: number;
  size: NodeSize;
}

export interface PlacedEdge {
  edge: SchemaEdge;
  /** Line from the source node to just before the arrow tip. */
  path: string;
  /** Filled arrowhead triangle. */
  head: string;
  /** Centre of the label box (above the last horizontal run) and its usable width; null when arrows into one node sit too close for it. */
  label: { x: number; y: number; w: number } | null;
}

export interface PlantLayout {
  width: number;
  height: number;
  columns: { key: string; label: string; x: number }[];
  nodes: PlacedNode[];
  edges: PlacedEdge[];
  /** y of the dashed divider between the hydronic band and room-scope sources, if both exist. */
  divider: number | null;
  /** Where the energy strip goes (full width), when there is one. */
  energy: { x: number; y: number; w: number } | null;
}

export function sizeOf(column: string): NodeSize {
  return column === 'manifolds' ? 'manifold' : column === 'rooms' ? 'rooms' : 'source';
}

export function layoutPlant(
  nodes: readonly SchemaNode[],
  edges: readonly SchemaEdge[],
  columns: readonly { key: string; label: string }[],
  withEnergy: boolean,
): PlantLayout {
  const colX = new Map<string, number>();
  const colW = new Map<string, number>();
  let x = PAD;
  for (const c of columns) {
    const w = COLUMN_WIDTH[c.key] ?? 240;
    colX.set(c.key, x);
    colW.set(c.key, w);
    x += w + GAP;
  }
  const width = Math.max(x - GAP + PAD, 2 * PAD + 240);

  const shown = nodes.filter((n) => colX.has(n.column));
  const byKey = new Map(shown.map((n) => [n.key, n]));

  // a manifold spans every row it connects to, so its arrows can run straight
  const span = new Map<string, [number, number]>();
  for (const n of shown) {
    let lo = n.row;
    let hi = n.row;
    if (n.column === 'manifolds') {
      for (const e of edges) {
        const other = e.from === n.key ? byKey.get(e.to) : e.to === n.key ? byKey.get(e.from) : undefined;
        if (other && other.band === n.band) {
          lo = Math.min(lo, other.row);
          hi = Math.max(hi, other.row);
        }
      }
    }
    span.set(n.key, [lo, hi]);
  }

  const rowsIn = (band: SchemaNode['band']) => {
    let max = -1;
    for (const n of shown) if (n.band === band) max = Math.max(max, (span.get(n.key) as [number, number])[1]);
    return max + 1;
  };
  const hydroRows = rowsIn('hydronic');
  const localRows = rowsIn('local');
  const hydroBottom = hydroRows ? TOP + hydroRows * ROW - (ROW - NODE_H) : TOP;
  const divider = hydroRows && localRows ? hydroBottom + DIVIDER_GAP : null;
  const localTop = divider != null ? divider + BAND_GAP : TOP;
  const localBottom = localRows ? localTop + localRows * ROW - (ROW - NODE_H) : hydroBottom;
  const contentBottom = Math.max(hydroBottom, localBottom);

  const placed: PlacedNode[] = shown.map((n) => {
    const [lo, hi] = span.get(n.key) as [number, number];
    const top = n.band === 'hydronic' ? TOP : localTop;
    return {
      node: n,
      x: colX.get(n.column) as number,
      y: top + lo * ROW,
      w: colW.get(n.column) as number,
      h: (hi - lo) * ROW + NODE_H,
      size: sizeOf(n.column),
    };
  });
  const at = new Map(placed.map((p) => [p.node.key, p]));

  const fan = fanIn(edges, at);
  const placedEdges: PlacedEdge[] = [];
  for (const e of edges) {
    const a = at.get(e.from);
    const b = at.get(e.to);
    if (!a || !b || a === b) continue;
    placedEdges.push(routeEdge(e, a, b, fan.arrive.get(e), fan.lane.get(a.node.key) ?? 0));
  }

  const energy = withEnergy ? { x: PAD, y: contentBottom + PAD, w: width - 2 * PAD } : null;
  const height = (energy ? energy.y + ENERGY_H : contentBottom) + PAD;
  return {
    width,
    height,
    columns: columns.map((c) => ({ key: c.key, label: c.label, x: colX.get(c.key) as number })),
    nodes: placed,
    edges: placedEdges,
    divider,
    energy,
  };
}

const mid = (p: PlacedNode) => p.y + p.h / 2;

/** y where an arrow meets a node: its middle, or level with the partner when the node is tall enough to take it. */
function joinY(self: PlacedNode, other: PlacedNode): number {
  const m = mid(other);
  if (self.h > NODE_H && m >= self.y + 24 && m <= self.y + self.h - 24) return m;
  return mid(self);
}

/** Arrows closer than this into one node leave their labels out (the source cards say the same). */
const LABEL_SPACING = 28;
const LANE = 12;

/**
 * Several arrows into the same side of one node (two sources feeding a circuit directly) would draw over
 * each other and stack their labels: they arrive spread over the node's height instead, and each source
 * turns in its own lane of the gap so its arrows can be followed.
 */
function fanIn(edges: readonly SchemaEdge[], at: Map<string, PlacedNode>): { arrive: Map<SchemaEdge, { y: number; quiet: boolean }>; lane: Map<string, number> } {
  const groups = new Map<string, { edge: SchemaEdge; a: PlacedNode; b: PlacedNode }[]>();
  for (const edge of edges) {
    const a = at.get(edge.from);
    const b = at.get(edge.to);
    if (!a || !b || a.x === b.x) continue;
    const key = `${edge.to}|${b.x > a.x ? 'l' : 'r'}|${Math.round(joinY(b, a))}`;
    groups.set(key, [...(groups.get(key) ?? []), { edge, a, b }]);
  }
  const arrive = new Map<SchemaEdge, { y: number; quiet: boolean }>();
  const fanned = new Map<string, PlacedNode>();
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((p, q) => mid(p.a) - mid(q.a) || p.a.x - q.a.x);
    const b = list[0].b;
    const step = b.h / (list.length + 1);
    list.forEach(({ edge, a }, i) => {
      arrive.set(edge, { y: b.y + step * (i + 1), quiet: step < LABEL_SPACING });
      fanned.set(a.node.key, a);
    });
  }
  const lane = new Map<string, number>();
  const sources = [...fanned.values()].sort((p, q) => mid(p) - mid(q));
  const width = Math.min(LANE, (GAP - 16) / Math.max(1, sources.length - 1));
  sources.forEach((a, i) => lane.set(a.node.key, (i - (sources.length - 1) / 2) * width));
  return { arrive, lane };
}

function routeEdge(edge: SchemaEdge, a: PlacedNode, b: PlacedNode, arrive?: { y: number; quiet: boolean }, lane = 0): PlacedEdge {
  const f = (v: number) => Number(v.toFixed(1));
  if (a.x === b.x) {
    // same column: a short vertical arrow
    const down = b.y > a.y;
    const x = a.x + a.w / 2;
    const y0 = down ? a.y + a.h : a.y;
    const y1 = down ? b.y - 1 : b.y + b.h + 1;
    const dir = down ? 1 : -1;
    return {
      edge,
      path: `M${f(x)} ${f(y0)}V${f(y1 - dir * 6)}`,
      head: `M${f(x - 4.5)} ${f(y1 - dir * 8)}L${f(x)} ${f(y1)}L${f(x + 4.5)} ${f(y1 - dir * 8)}Z`,
      label: { x: x + 40, y: (y0 + y1) / 2 - 8, w: 72 },
    };
  }
  const right = b.x > a.x;
  const sy = joinY(a, b);
  const ey = arrive?.y ?? joinY(b, a);
  const sx = right ? a.x + a.w : a.x;
  const ex = right ? b.x - 1 : b.x + b.w + 1;
  const dir = right ? 1 : -1;
  const lineEnd = ex - dir * 6;
  let path: string;
  let runFrom = sx;
  if (Math.abs(sy - ey) < 0.5) {
    path = `M${f(sx)} ${f(sy)}H${f(lineEnd)}`;
  } else {
    // turn in the middle of the first gap (or the source's lane in it) so the vertical run never crosses a node
    const turn = sx + dir * (GAP / 2 + lane);
    path = `M${f(sx)} ${f(sy)}H${f(turn)}V${f(ey)}H${f(lineEnd)}`;
    runFrom = turn;
  }
  const head = `M${f(ex - dir * 8)} ${f(ey - 4.5)}L${f(ex)} ${f(ey)}L${f(ex - dir * 8)} ${f(ey + 4.5)}Z`;
  const w = Math.max(48, Math.abs(ex - runFrom) - 8);
  return { edge, path, head, label: arrive?.quiet ? null : { x: (runFrom + ex) / 2, y: ey, w } };
}
