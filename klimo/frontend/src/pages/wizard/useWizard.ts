/**
 * The add-room wizard: a draft that grows step by step, devices offered from the chosen Home
 * Assistant area or found with one search over all of Home Assistant, what heats the room read
 * from the devices picked (nothing to declare up front), server-side validation before every
 * «Далі» (the server knows which entities exist and belong elsewhere), and after «Створити
 * кімнату» a live report of what the room's devices confirmed.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AggregationMethod,
  ApiErrorIssue,
  Band,
  CreateRoomReport,
  CreateRoomRequest,
  CreateRoomStepKind,
  DiscoveryCandidate,
  HaEntityDto,
  Id,
  SourceAdapter,
  SourceDemandPolicy,
  TrvStrategy,
  ValidationResult,
  WindowReaction,
  WizardDeviceRole,
} from '@api/model';
import { api } from '@api/endpoints';
import { isApiError } from '@api/client';
import { invalidate, liveStore, useCodeContext, useResource, useWizardReport } from '@data';
import { currentRoute } from '@app';
import { errorText, t } from '@i18n';
import { toast } from '@ui';

export type EmitterChoice = CreateRoomRequest['emitterKinds'][number];
export type WizardStep = 1 | 2 | 3 | 4 | 5;

/** A device found with the search rather than offered by the area. */
export interface ExtraDevice {
  role: WizardDeviceRole;
  entityId: string;
  name: string;
  /** Every role it can take («Use as…»). */
  roles: WizardDeviceRole[];
  /** What the search showed when it was added. */
  areaName: string | null;
  state: string | null;
  valueC: number | null;
  /** The room it belongs to now: adding it here moves it. */
  fromRoom: string | null;
  /** A thermostat's own reading standing in as the room sensor (the same entity is also the head). */
  ownTemperature?: boolean;
}

/** The blocks of the device step. */
export type SectionKey = 'trv' | 'temp' | 'window' | 'ac' | 'heater' | 'floor' | 'dehum';

export const SECTION_ROLES: Record<SectionKey, readonly WizardDeviceRole[]> = {
  trv: ['trv'],
  temp: ['temp_humidity', 'temperature', 'humidity'],
  window: ['window', 'door'],
  ac: ['ac'],
  heater: ['heater'],
  floor: ['floor_zone', 'floor_probe'],
  dehum: ['dehumidifier'],
};

export function sectionOf(role: WizardDeviceRole): SectionKey {
  return (Object.keys(SECTION_ROLES) as SectionKey[]).find((k) => SECTION_ROLES[k].includes(role)) ?? 'temp';
}

/** What heats or cools the room follows from its devices (the server checks the same pairs). */
const ROLE_KIND: Partial<Record<WizardDeviceRole, EmitterChoice>> = {
  trv: 'trv',
  ac: 'ac',
  heater: 'local',
  floor_zone: 'floor',
  floor_probe: 'floor',
};
const KIND_ORDER: readonly EmitterChoice[] = ['trv', 'floor', 'ac', 'local'];

/** A device the house already uses elsewhere: a source switches it, or it is a pump of the plant. */
export type DeviceInUse = { as: 'source'; name: string } | { as: 'pump' };

/** The entity a source is switched through (the one the server refuses to put into a room). */
function controlEntity(a: SourceAdapter): string | null {
  if (a.type === 'climate') return a.climate;
  if (a.type === 'relay') return a.command;
  if (a.type === 'flow') return a.enable;
  return null;
}

export function methodForCount(n: number): AggregationMethod {
  return n >= 3 ? 'median' : n === 2 ? 'average' : 'primary';
}

export interface Wizard {
  step: WizardStep;
  goTo: (s: 1 | 2 | 3 | 4) => void;
  name: string;
  setName: (v: string) => void;
  areaId: string | null;
  setArea: (id: string | null) => void;
  areas: { id: string; name: string; hint?: string }[];
  /** Read from the devices picked (and an opened underfloor block). */
  kinds: EmitterChoice[];
  demand: SourceDemandPolicy;
  setDemand: (p: SourceDemandPolicy) => void;
  candidates: DiscoveryCandidate[];
  discovering: boolean;
  integrations: string[];
  areaName: string | null;
  picked: (c: DiscoveryCandidate) => boolean;
  togglePick: (c: DiscoveryCandidate) => void;
  /** The role a candidate is taken as (the area's guess unless changed with «Use as…»). */
  roleOf: (c: DiscoveryCandidate) => WizardDeviceRole;
  /** Offered, but never pre-ticked: a source or a pump already uses it. */
  inUse: (c: DiscoveryCandidate) => DeviceInUse | null;
  extras: ExtraDevice[];
  /** A search result: ticks it when the area offered it, otherwise adds it. */
  addDevice: (e: HaEntityDto, role: WizardDeviceRole) => void;
  /** «Use as…» of a candidate or an added device. */
  setRole: (entityId: string, from: WizardDeviceRole, to: WizardDeviceRole) => void;
  removeExtra: (entityId: string, role: WizardDeviceRole) => void;
  /** The head's own temperature as the room sensor. */
  takeOwnTemperature: (d: { entityId: string; name: string }) => void;
  /** Blocks opened with a quick-add chip before anything is in them. */
  opened: SectionKey[];
  openSection: (k: SectionKey) => void;
  closeSection: (k: SectionKey) => void;
  floor: { circuitId: Id | null; newName: string; pumpEntityId: string | null };
  setFloor: (f: Partial<Wizard['floor']>) => void;
  floorCircuits: { id: Id; name: string }[];
  method: AggregationMethod;
  setMethod: (m: AggregationMethod) => void;
  /** What each method gives with the chosen sensors (from the server's step validation). */
  methodValues: Record<AggregationMethod, number | null> | undefined;
  heatTol: Band;
  setHeatTol: (b: Band) => void;
  coolTol: Band;
  setCoolTol: (b: Band) => void;
  needsCool: boolean;
  reaction: WindowReaction;
  setReaction: (r: WindowReaction) => void;
  strategy: TrvStrategy | null;
  setStrategy: (s: TrvStrategy) => void;
  autoStrategy: TrvStrategy | null;
  unsupported: { strategy: TrvStrategy; reason: string }[];
  request: CreateRoomRequest;
  issues: ApiErrorIssue[];
  busy: boolean;
  next: () => void;
  back: () => void;
  dirty: boolean;
  report: CreateRoomReport | null;
  retry: (kind: CreateRoomStepKind) => void;
  retrying: CreateRoomStepKind | null;
  reset: () => void;
}

const DEFAULT_HEAT: Band = { below: 0.2, above: 0.2 };
const DEFAULT_COOL: Band = { below: 0.3, above: 0.3 };

/** Everything the user entered and the server answered so far. */
interface Draft {
  step: WizardStep;
  name: string;
  nameTouched: boolean;
  areaId: string | null;
  demand: SourceDemandPolicy;
  pickedIds: string[];
  /** «Use as…» of area candidates, by entity id. */
  roles: Record<string, WizardDeviceRole>;
  opened: SectionKey[];
  /** The area whose suggested devices were pre-ticked (so a remount does not re-tick them). */
  preselectedFor: string | null;
  extras: ExtraDevice[];
  floor: Wizard['floor'];
  method: AggregationMethod | null;
  heatTol: Band | null;
  coolTol: Band | null;
  reaction: WindowReaction;
  strategy: TrvStrategy | null;
  issues: ApiErrorIssue[];
  hints: ValidationResult['hints'];
  reportId: Id | null;
  created: CreateRoomReport | null;
}

const EMPTY: Draft = {
  step: 1,
  name: '',
  nameTouched: false,
  areaId: null,
  demand: 'call',
  pickedIds: [],
  roles: {},
  opened: [],
  preselectedFor: null,
  extras: [],
  floor: { circuitId: null, newName: '', pumpEntityId: null },
  method: null,
  heatTol: null,
  coolTol: null,
  reaction: 'pause',
  strategy: null,
  issues: [],
  hints: undefined,
  reportId: null,
  created: null,
};

/**
 * The draft outlives the component while the route stays on the wizard: turning a phone to
 * landscape swaps the full-screen wizard for the centred panel, which mounts it anew.
 */
let kept: Draft | null = null;

/** Validation of the request body reports paths under `draft.`; the step checks do not. */
const plainPath = (issue: ApiErrorIssue): ApiErrorIssue => (issue.path.startsWith('draft.') ? { ...issue, path: issue.path.slice(6) } : issue);

export function useWizard(): Wizard {
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings'] });
  const areasRes = useResource('ha-areas', api.ha.areas);
  const circuitsRes = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit', 'pump'] });
  const sourcesRes = useResource('names:sources', api.sources.list, { reloadOn: ['source'] });
  const pumpsRes = useResource('names:pumps', api.pumps.list, { reloadOn: ['pump'] });
  const names = useCodeContext();
  const defaults = settings.data?.general.defaults.tolerance;

  const [d, setDraft] = useState<Draft>(() => kept ?? EMPTY);
  const patch = useCallback(
    (p: Partial<Draft> | ((d: Draft) => Partial<Draft>)) =>
      setDraft((x) => {
        const change = typeof p === 'function' ? p(x) : p;
        return Object.keys(change).length ? { ...x, ...change } : x;
      }),
    [],
  );
  const [busy, setBusy] = useState(false);
  const [retrying, setRetrying] = useState<CreateRoomStepKind | null>(null);

  useEffect(() => {
    kept = d;
  }, [d]);
  // leaving the wizard drops the draft; a remount on the same route keeps it
  useEffect(
    () => () => {
      if (currentRoute().name !== 'wizard') kept = null;
    },
    [],
  );

  const { step, name, areaId, demand, extras, opened, floor, method, heatTol, coolTol, reaction, strategy, issues, hints, reportId } = d;
  const pickedIds = useMemo(() => new Set(d.pickedIds), [d.pickedIds]);

  const discovery = useResource(areaId ? `area-discovery:${areaId}` : null, () => api.ha.discoverArea(areaId as string));
  const candidates = useMemo(() => discovery.data?.candidates ?? [], [discovery.data]);

  const inUse = useCallback(
    (c: DiscoveryCandidate): DeviceInUse | null => {
      const source = sourcesRes.data?.find((s) => controlEntity(s.config.adapter) === c.entityId);
      if (source) return { as: 'source', name: names.sourceLabel(source.config.id) ?? source.config.name };
      return pumpsRes.data?.some((p) => p.entityId === c.entityId) ? { as: 'pump' } : null;
    },
    [sourcesRes.data, pumpsRes.data, names],
  );
  const usesKnown = sourcesRes.settled && pumpsRes.settled;

  // the area's devices arrive: pre-check what the server suggests — never what belongs to another
  // room, and never the heat pump or a circuit pump that happen to hang in the same area
  useEffect(() => {
    const data = discovery.data;
    if (!data || data.areaId !== areaId || !usesKnown) return;
    patch((x) => {
      if (x.preselectedFor === data.areaId) return {};
      const suggested = data.candidates.filter((c) => c.preselected && !c.takenByRoomId && !inUse(c));
      return { preselectedFor: data.areaId, pickedIds: suggested.map((c) => c.entityId), roles: {} };
    });
  }, [discovery.data, areaId, usesKnown, inUse, patch]);

  const areas = useMemo(
    () =>
      (areasRes.data ?? []).map((a) => ({
        id: a.areaId,
        name: a.name,
        hint:
          a.areaId === areaId && discovery.data
            ? discovery.data.candidates.length
              ? t('{count} devices found in the area — they are offered on the next step.', { count: discovery.data.candidates.length })
              : t('No devices found in this area — the next step finds them by name.')
            : undefined,
      })),
    [areasRes.data, areaId, discovery.data],
  );

  const setArea = useCallback(
    (id: string | null) => {
      // the room is usually called like its area
      const area = areasRes.data?.find((a) => a.areaId === id);
      patch((x) => ({ areaId: id, name: area && (!x.nameTouched || !x.name.trim()) ? area.name : x.name }));
    },
    [areasRes.data, patch],
  );

  const roleOf = useCallback((c: DiscoveryCandidate): WizardDeviceRole => d.roles[c.entityId] ?? c.role, [d.roles]);

  const devices = useMemo<CreateRoomRequest['devices']>(() => {
    const out: CreateRoomRequest['devices'] = [];
    const seen = new Set<string>();
    for (const c of candidates) {
      if (!pickedIds.has(c.entityId)) continue;
      const role = roleOf(c);
      seen.add(`${role}|${c.entityId}`);
      out.push({ role, entityId: c.entityId, name: c.name, move: c.takenByRoomId ? true : undefined });
    }
    for (const x of extras) {
      if (seen.has(`${x.role}|${x.entityId}`)) continue;
      out.push({ role: x.role, entityId: x.entityId, name: x.name || undefined, move: x.fromRoom ? true : undefined });
    }
    return out;
  }, [candidates, pickedIds, extras, roleOf]);

  const kinds = useMemo<EmitterChoice[]>(() => {
    const set = new Set<EmitterChoice>();
    for (const dev of devices) {
      const k = ROLE_KIND[dev.role];
      if (k) set.add(k);
    }
    // a floor circuit can heat a room without a zone valve of its own
    if (opened.includes('floor')) set.add('floor');
    return KIND_ORDER.filter((k) => set.has(k));
  }, [devices, opened]);

  const tempCount = devices.filter((d) => d.role === 'temperature' || d.role === 'temp_humidity').length;
  const needsCool = kinds.includes('ac') || kinds.includes('floor');
  const floorCircuits = useMemo(
    () => (circuitsRes.data ?? []).filter((c) => c.config.kind === 'floor').map((c) => ({ id: c.config.id, name: c.config.name })),
    [circuitsRes.data],
  );

  const request = useMemo<CreateRoomRequest>(
    () => ({
      name: name.trim(),
      haAreaId: areaId,
      icon: null,
      emitterKinds: kinds,
      demandPolicy: demand,
      devices,
      circuits: {
        radiatorCircuitId: null,
        floorCircuitId: kinds.includes('floor') ? floor.circuitId : null,
        newFloorCircuit:
          kinds.includes('floor') && !floor.circuitId && floor.pumpEntityId
            ? { name: floor.newName.trim() || t('Floor heating · {room}', { room: name.trim() }), pumpEntityId: floor.pumpEntityId, sourceIds: [] }
            : null,
      },
      method,
      heatTolerance: heatTol ?? defaults?.heat ?? DEFAULT_HEAT,
      coolTolerance: needsCool ? (coolTol ?? defaults?.cool ?? DEFAULT_COOL) : null,
      windowReaction: reaction,
      trvStrategy: strategy,
    }),
    [name, areaId, kinds, demand, devices, floor, method, heatTol, coolTol, needsCool, defaults, reaction, strategy],
  );

  const validate = useCallback(
    async (s: 1 | 2 | 3 | 4): Promise<boolean> => {
      setBusy(true);
      try {
        const res = await api.rooms.validate({ step: s, draft: request });
        patch((x) => ({ issues: res.issues.map(plainPath), hints: res.hints ?? x.hints }));
        return res.ok;
      } catch (e) {
        if (isApiError(e) && e.issues.length) patch({ issues: e.issues.map(plainPath) });
        else toast({ tone: 'err', message: errorText(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request, patch],
  );

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const report = await api.rooms.create(request);
      patch({ created: report, reportId: report.reportId, step: 5, issues: [] });
      liveStore.refetchRooms();
      invalidate('overview');
    } catch (e) {
      if (isApiError(e) && e.issues.length) patch({ issues: e.issues.map(plainPath) });
      toast({ tone: 'err', message: t('The room was not created: {reason}', { reason: errorText(e) }) });
    } finally {
      setBusy(false);
    }
  }, [request, patch]);

  const next = useCallback(() => {
    if (busy) return;
    if (step === 4) {
      void (async () => {
        if (await validate(4)) await create();
      })();
      return;
    }
    if (step === 5) return;
    void (async () => {
      if (await validate(step)) patch({ issues: [], step: (step + 1) as WizardStep });
    })();
  }, [busy, step, validate, create, patch]);

  const back = useCallback(() => patch((x) => ({ issues: [], step: x.step > 1 && x.step < 5 ? ((x.step - 1) as WizardStep) : x.step })), [patch]);

  const goTo = useCallback((s: 1 | 2 | 3 | 4) => patch({ issues: [], step: s }), [patch]);

  const live = useWizardReport(reportId);
  const report = live ?? d.created;

  const retry = useCallback(
    (kind: CreateRoomStepKind) => {
      if (!reportId) return;
      setRetrying(kind);
      api.rooms
        .retryStep(reportId, kind)
        .then((r) => patch({ created: r }))
        .catch((e: unknown) => toast({ tone: 'err', message: errorText(e) }))
        .finally(() => setRetrying(null));
    },
    [reportId, patch],
  );

  const reset = useCallback(() => setDraft(EMPTY), []);

  const dirty = step < 5 && (name.trim() !== '' || areaId !== null || extras.length > 0 || opened.length > 0);

  const addDevice = useCallback(
    (e: HaEntityDto, role: WizardDeviceRole) =>
      patch((x) => {
        const cand = candidates.find((c) => c.entityId === e.entityId);
        // the same entity once as a device; a head's own reading as the sensor stays beside it
        const others = x.extras.filter((y) => y.entityId !== e.entityId || y.ownTemperature);
        if (cand) {
          const roles = { ...x.roles };
          if (role === cand.role) delete roles[cand.entityId];
          else roles[cand.entityId] = role;
          return { pickedIds: x.pickedIds.includes(cand.entityId) ? x.pickedIds : [...x.pickedIds, cand.entityId], roles, extras: others };
        }
        const possible = e.wizard?.possible ?? [role];
        const room = e.usedBy.find((u) => u.type === 'room');
        const extra: ExtraDevice = {
          role,
          entityId: e.entityId,
          name: e.name,
          roles: possible.includes(role) ? possible : [role, ...possible],
          areaName: e.areaName,
          state: e.available ? e.state : 'unavailable',
          valueC: e.valueC ?? null,
          fromRoom: room ? room.label : null,
        };
        return { extras: [...others, extra] };
      }),
    [candidates, patch],
  );

  const setRole = useCallback(
    (entityId: string, from: WizardDeviceRole, to: WizardDeviceRole) =>
      patch((x) => {
        const extra = x.extras.find((y) => y.entityId === entityId && y.role === from);
        if (extra) return { extras: x.extras.map((y) => (y === extra ? { ...y, role: to } : y)) };
        const cand = candidates.find((c) => c.entityId === entityId);
        if (!cand) return {};
        const roles = { ...x.roles };
        if (to === cand.role) delete roles[entityId];
        else roles[entityId] = to;
        return { roles };
      }),
    [candidates, patch],
  );

  const takeOwnTemperature = useCallback(
    (dev: { entityId: string; name: string }) =>
      patch((x) => {
        if (x.extras.some((y) => y.entityId === dev.entityId && y.role === 'temperature')) return {};
        const extra: ExtraDevice = {
          role: 'temperature',
          entityId: dev.entityId,
          name: dev.name,
          roles: ['temperature'],
          areaName: null,
          state: null,
          valueC: null,
          fromRoom: null,
          ownTemperature: true,
        };
        return { extras: [...x.extras, extra] };
      }),
    [patch],
  );

  return {
    step,
    goTo,
    name,
    setName: (v) => patch({ name: v, nameTouched: true }),
    areaId,
    setArea,
    areas,
    kinds,
    demand,
    setDemand: (v) => patch({ demand: v }),
    candidates,
    discovering: discovery.loading && !discovery.data,
    integrations: discovery.data?.integrations ?? [],
    areaName: discovery.data?.areaName ?? areasRes.data?.find((a) => a.areaId === areaId)?.name ?? null,
    picked: (c) => pickedIds.has(c.entityId),
    togglePick: (c) =>
      patch((x) => ({ pickedIds: x.pickedIds.includes(c.entityId) ? x.pickedIds.filter((id) => id !== c.entityId) : [...x.pickedIds, c.entityId] })),
    roleOf,
    inUse,
    extras,
    addDevice,
    setRole,
    removeExtra: (id, role) => patch((x) => ({ extras: x.extras.filter((e) => e.entityId !== id || e.role !== role) })),
    takeOwnTemperature,
    opened,
    openSection: (k) => patch((x) => (x.opened.includes(k) ? {} : { opened: [...x.opened, k] })),
    closeSection: (k) => patch((x) => ({ opened: x.opened.filter((y) => y !== k) })),
    floor,
    setFloor: (f) => patch((x) => ({ floor: { ...x.floor, ...f } })),
    floorCircuits,
    method: method ?? methodForCount(tempCount),
    setMethod: (m) => patch({ method: m }),
    methodValues: hints?.methodValues,
    heatTol: request.heatTolerance,
    setHeatTol: (b) => patch({ heatTol: b }),
    coolTol: request.coolTolerance ?? coolTol ?? defaults?.cool ?? DEFAULT_COOL,
    setCoolTol: (b) => patch({ coolTol: b }),
    needsCool,
    reaction,
    setReaction: (r) => patch({ reaction: r }),
    strategy,
    setStrategy: (v) => patch({ strategy: v }),
    autoStrategy: hints?.trvStrategy ?? null,
    unsupported: hints?.unsupportedStrategies ?? [],
    request,
    issues,
    busy,
    next,
    back,
    dirty,
    report,
    retry,
    retrying,
    reset,
  };
}
