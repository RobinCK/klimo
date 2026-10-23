import { sourceLabels } from '../../config/source-labels';
import { sourceTemplate } from '../../shared/defaults';
import type {
  Circuit,
  CircuitKind,
  CircuitState,
  EngineConfig,
  IconName,
  Id,
  PlantState,
  Reason,
  RoomState,
  SchemaEdge,
  SchemaNode,
  SchemaView,
  SimConditions,
  SimPresetId,
  SourceConfig,
  SourceState,
} from '../../shared/model';
import { circuitMembers, emptyCircuitState, isRunningState } from './mappers';

/* =====================================================================================================
 * The plant diagram («Схема»): sources → manifolds → circuits → the rooms they serve, and below the
 * divider room-scope sources straight into their rooms. Built from the same plant state the engine
 * produced (live or from a dry run), so the picture and the decisions cannot disagree.
 * ===================================================================================================== */

export interface SchemaInput {
  cfg: EngineConfig;
  plant: PlantState;
  rooms: RoomState[];
  simulated: boolean;
  preset: SimPresetId;
  conditions: SimConditions;
}

type NodeTone = SchemaNode['tone'];

const FLOWING: ReadonlySet<NodeTone> = new Set<NodeTone>(['heat', 'cool', 'mixed']);

/** The rooms box notes the dew guard only: rooms kept out for humidity or heating-only loops say so themselves. */
function dewMeta(cs: CircuitState): Reason | null {
  const hold = cs.dewHold;
  if (hold) return hold.kind === 'lockout' ? { code: 'circuit.dew_lockout', params: { until: hold.until, trips: hold.trips } } : { code: 'circuit.dew_hold', params: { until: hold.until } };
  return cs.excludedRooms.some((x) => x.reason === 'dew') ? { code: 'circuit.dew_blocked', params: { dewC: cs.dewPointMaxC } } : null;
}

function circuitIcon(kind: CircuitKind): IconName {
  switch (kind) {
    case 'floor':
      return 'floor';
    case 'fancoil':
      return 'fan';
    case 'radiators':
      return 'radiator';
    default:
      return 'pumps';
  }
}

function sourceTone(s: SourceState | undefined, cfg: SourceConfig): NodeTone {
  if (!s) return cfg.enabled ? 'idle' : 'off';
  if (s.state === 'fault' || s.state === 'unavailable') return 'fault';
  return s.tone;
}

export function buildSchema(x: SchemaInput): SchemaView {
  const { cfg, plant } = x;
  const nodes: SchemaNode[] = [];
  const edges: SchemaEdge[] = [];
  const edgeKeys = new Set<string>();
  const rows = new Map<string, number>();
  const nextRow = (column: SchemaNode['column'], band: SchemaNode['band']) => {
    const k = `${band}|${column}`;
    const r = rows.get(k) ?? 0;
    rows.set(k, r + 1);
    return r;
  };
  const sourceState = new Map(plant.sources.map((s) => [s.sourceId, s]));
  const circuitState = new Map(plant.circuits.map((c) => [c.circuitId, c]));
  const roomState = new Map(x.rooms.map((r) => [r.roomId, r]));
  const nodeTone = new Map<string, NodeTone>();
  const sourceName = sourceLabels(cfg);

  const addNode = (n: Omit<SchemaNode, 'row'>) => {
    const node: SchemaNode = { ...n, row: nextRow(n.column, n.band) };
    nodes.push(node);
    nodeTone.set(node.key, node.tone);
  };
  const addEdge = (from: string, to: string, governing: string, label: Reason | null) => {
    const key = `${from}>${to}`;
    if (edgeKeys.has(key) || !nodeTone.has(from) || !nodeTone.has(to)) return;
    edgeKeys.add(key);
    const tone = nodeTone.get(governing) ?? 'idle';
    edges.push({ from, to, tone, dashed: !FLOWING.has(tone), label });
  };

  /* hydronic band: central sources in chain order, then the rest */
  const central = cfg.sources.filter((s) => s.scope === 'central');
  const chainOrder = [...cfg.heat.chain, ...cfg.cool.chain].flatMap((e) => e.sourceIds);
  central.sort((a, b) => rank(chainOrder, a.id) - rank(chainOrder, b.id) || a.order - b.order);
  for (const s of central) {
    const st = sourceState.get(s.id);
    const tone = sourceTone(st, s);
    addNode({
      key: `source:${s.id}`,
      column: 'sources',
      band: 'hydronic',
      tone,
      icon: sourceTemplate(s.kind).icon,
      title: sourceName.get(s.id) ?? s.name,
      state: st?.detail ?? { code: s.enabled ? 'source.detail.idle' : 'source.blocked.disabled' },
      meta: st?.roleReason ?? null,
      roomIds: [],
      dashed: !st || !isRunningState(st.state),
    });
  }

  const usedManifolds = new Set(cfg.circuits.map((c) => c.manifoldId).filter((m): m is Id => !!m));
  for (const m of cfg.manifolds.filter((m) => usedManifolds.has(m.id))) {
    const live = plant.manifolds.find((x) => x.manifoldId === m.id);
    const feeding = cfg.circuits
      .filter((c) => c.manifoldId === m.id)
      .flatMap((c) => circuitState.get(c.id)?.feedingSourceIds ?? [])
      .filter((id, i, all) => all.indexOf(id) === i);
    const runningMode = feeding.map((id) => sourceState.get(id)?.mode).find((mode) => !!mode) ?? null;
    const tone: NodeTone = live?.tone ?? 'idle';
    const state: Reason = feeding.length
      ? runningMode === 'cool' || runningMode === 'dry'
        ? { code: 'circuit.cooling', params: { supplyC: live?.supplyC ?? null, dewC: null } }
        : { code: 'circuit.heating', params: { supplyC: live?.supplyC ?? null, sourceId: feeding[0] } }
      : { code: 'circuit.idle' };
    addNode({ key: `manifold:${m.id}`, column: 'manifolds', band: 'hydronic', tone, icon: 'manifold', title: m.name, state, meta: null, roomIds: [], dashed: !FLOWING.has(tone) });
  }

  const circuits: Circuit[] = [...cfg.circuits].sort((a, b) => a.order - b.order);
  for (const c of circuits) {
    const cs: CircuitState = circuitState.get(c.id) ?? emptyCircuitState(cfg, c);
    addNode({
      key: `circuit:${c.id}`,
      column: 'circuits',
      band: 'hydronic',
      tone: cs.tone,
      icon: circuitIcon(c.kind),
      title: c.shortName || c.name,
      state: cs.state,
      meta: cs.runOnUntil !== null ? { code: 'circuit.run_on', params: { until: cs.runOnUntil } } : null,
      roomIds: cs.memberRoomIds.length ? cs.memberRoomIds : circuitMembers(cfg, c.id),
      dashed: !cs.pumpOn && cs.mode === 'none',
    });
    const members = cs.memberRoomIds.length ? cs.memberRoomIds : circuitMembers(cfg, c.id);
    if (!members.length) continue;
    const requesting = cs.requestingRoomIds.length;
    const tone: NodeTone = requesting ? cs.tone : cs.mode === 'none' && (cs.state.code === 'circuit.summer' || cs.state.code === 'circuit.heat_only_blocked') ? 'off' : 'idle';
    addNode({
      key: `rooms:circuit:${c.id}`,
      column: 'rooms',
      band: 'hydronic',
      tone,
      icon: 'home',
      title: members.map((id) => cfg.rooms.find((r) => r.id === id)?.name ?? '').filter(Boolean).join(' · '),
      // rooms of a circuit ask by their temperature; heads exist only on some of them
      state: requesting ? { code: 'why.rooms_asking', params: { n: requesting, total: members.length } } : cs.state,
      meta: dewMeta(cs),
      roomIds: members,
      dashed: !FLOWING.has(tone),
    });
  }

  for (const s of central) {
    const st = sourceState.get(s.id);
    for (const c of circuits.filter((c) => c.sourceIds.includes(s.id))) {
      const target = c.manifoldId && nodeTone.has(`manifold:${c.manifoldId}`) ? `manifold:${c.manifoldId}` : `circuit:${c.id}`;
      addEdge(`source:${s.id}`, target, `source:${s.id}`, st?.roleReason ?? null);
    }
  }
  for (const c of circuits) {
    if (c.manifoldId) addEdge(`manifold:${c.manifoldId}`, `circuit:${c.id}`, `circuit:${c.id}`, null);
    addEdge(`circuit:${c.id}`, `rooms:circuit:${c.id}`, `rooms:circuit:${c.id}`, null);
  }

  /* local band: room-scope sources straight into their rooms */
  const local = cfg.sources.filter((s) => s.scope === 'room' && s.roomId);
  const servedRooms: Id[] = [];
  for (const s of local) {
    const st = sourceState.get(s.id);
    addNode({
      key: `local:${s.id}`,
      column: 'sources',
      band: 'local',
      tone: sourceTone(st, s),
      icon: sourceTemplate(s.kind).icon,
      title: sourceName.get(s.id) ?? s.name,
      state: st?.detail ?? { code: s.enabled ? 'source.detail.idle' : 'source.blocked.disabled' },
      meta: st?.roleReason ?? null,
      roomIds: s.roomId ? [s.roomId] : [],
      dashed: !st || !isRunningState(st.state),
    });
    if (s.roomId && !servedRooms.includes(s.roomId)) servedRooms.push(s.roomId);
  }
  for (const roomId of servedRooms) {
    const room = cfg.rooms.find((r) => r.id === roomId);
    if (!room) continue;
    const rs = roomState.get(roomId);
    const tone: NodeTone = rs ? (rs.state === 'heat' ? 'heat' : rs.state === 'cool' ? 'cool' : rs.state === 'off' || rs.state === 'monitor' ? 'off' : rs.state === 'window' || rs.state === 'wait' ? 'wait' : 'idle') : 'idle';
    addNode({
      key: `room:${roomId}`,
      column: 'rooms',
      band: 'local',
      tone,
      icon: room.icon ?? 'home',
      title: room.name,
      state: rs?.why[0] ?? { code: 'why.no_data', params: { safeC: cfg.safety.noDataTrvSetpointC } },
      meta: null,
      roomIds: [roomId],
      dashed: !FLOWING.has(tone),
    });
  }
  for (const s of local) if (s.roomId) addEdge(`local:${s.id}`, `room:${s.roomId}`, `local:${s.id}`, sourceState.get(s.id)?.roleReason ?? null);

  return {
    simulated: x.simulated,
    preset: x.preset,
    conditions: x.conditions,
    nodes,
    edges,
    energy: plant.energy,
    why: plant.why,
    sources: plant.sources,
    circuits: plant.circuits,
  };
}

function rank(order: readonly Id[], id: Id): number {
  const i = order.indexOf(id);
  return i < 0 ? Number.MAX_SAFE_INTEGER : i;
}
