/**
 * The add-room wizard: a draft that grows step by step. Step 1 says what heats or cools the room
 * (picking a device of a kind later ticks it too); devices are offered from the chosen Home
 * Assistant area, by kind, or added with «Додати пристрій» from all of Home Assistant; the room joins the house's
 * radiator or floor circuit (the floor one is set up here once if the house has none); the server
 * validates every «Далі» (it knows which entities exist and belong elsewhere), and after «Створити
 * кімнату» a live report shows what the room's devices confirmed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AggregationMethod,
  ApiErrorIssue,
  Band,
  CircuitDto,
  CircuitMode,
  CreateRoomReport,
  CreateRoomRequest,
  CreateRoomStepKind,
  DiscoveryCandidate,
  HaEntityDto,
  Id,
  NewCircuitRequest,
  RoomHeatingKind,
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
import { DEVICE_GROUP_ROLES, deviceGroupOf, errorText, HEATING_KIND_ORDER, ROLE_HEATING_KIND, t, type DeviceGroup } from '@i18n';
import { toast } from '@ui';

export type EmitterChoice = RoomHeatingKind;
export type WizardStep = 1 | 2 | 3 | 4 | 5;

/** A device added by hand rather than offered by the area. */
export interface ExtraDevice {
  role: WizardDeviceRole;
  entityId: string;
  name: string;
  /** What the search showed when it was added. */
  areaName: string | null;
  state: string | null;
  valueC: number | null;
  /** The room it belongs to now: adding it here moves it. */
  fromRoom: string | null;
  /** Its Home Assistant device: a combined sensor's temperature and humidity share it. */
  deviceId?: string | null;
  /** A thermostat's own reading standing in as the room sensor (the same entity is also the head). */
  ownTemperature?: boolean;
}

/** The blocks of the device step. */
export type SectionKey = DeviceGroup;

export const SECTION_ROLES = DEVICE_GROUP_ROLES;

export const sectionOf = deviceGroupOf;

/** The device roles of a heating kind (unticking the kind drops them from the draft). */
const KIND_ROLES = (k: EmitterChoice): WizardDeviceRole[] =>
  (Object.keys(ROLE_HEATING_KIND) as WizardDeviceRole[]).filter((r) => ROLE_HEATING_KIND[r] === k);

/** The one-time setup of the house floor circuit (when the house has none yet). */
export interface FloorSetup {
  name: string;
  pumpEntityId: string | null;
  mode: CircuitMode;
  /** Empty: every central heat source. */
  sourceIds: Id[];
  runOnMin: number;
}

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
  /** Ticked on step 1, plus what the devices picked bring (a head ticks smart radiators). */
  kinds: EmitterChoice[];
  /** Ticks or unticks a kind; unticking drops that kind's devices. */
  toggleKind: (k: EmitterChoice) => void;
  /** «The heads are mechanical»: smart heads are swapped for radiators with ordinary valves. */
  toOrdinaryValves: () => void;
  demand: SourceDemandPolicy;
  setDemand: (p: SourceDemandPolicy) => void;
  candidates: DiscoveryCandidate[];
  discovering: boolean;
  integrations: string[];
  areaName: string | null;
  picked: (c: DiscoveryCandidate) => boolean;
  togglePick: (c: DiscoveryCandidate) => void;
  /** The role a candidate is taken as (the area's guess unless it was added to another block). */
  roleOf: (c: DiscoveryCandidate) => WizardDeviceRole;
  /** Offered, but never pre-ticked: a source or a pump already uses it. */
  inUse: (c: DiscoveryCandidate) => DeviceInUse | null;
  extras: ExtraDevice[];
  /** A device found in «Додати пристрій»: ticks it when the area offered it, otherwise adds it. */
  addDevice: (e: HaEntityDto, role: WizardDeviceRole) => void;
  removeExtra: (entityId: string, role: WizardDeviceRole) => void;
  /** The head's own temperature as the room sensor. */
  takeOwnTemperature: (d: { entityId: string; name: string }) => void;
  /** The house floor circuit chosen (with several), and the one-time setup when there is none. */
  floor: { circuitId: Id | null; setup: FloorSetup };
  setFloor: (f: { circuitId?: Id | null; setup?: Partial<FloorSetup> }) => void;
  floorCircuits: CircuitDto[];
  /** The circuit the room joins: the chosen or the only one; null while it has to be chosen or set up. */
  floorCircuit: CircuitDto | null;
  /** This room's zone valve is used: the circuit (or the one being set up) runs by zones. */
  floorZoned: boolean;
  radiatorCircuits: CircuitDto[];
  radiatorCircuitId: Id | null;
  setRadiatorCircuit: (id: Id | null) => void;
  /** The circuit the radiators go on (the chosen or the first); null: one is created, fed by every heat source. */
  radiatorCircuit: CircuitDto | null;
  /** Central sources that can heat (a new circuit is fed by them). */
  heatSources: { id: Id; name: string }[];
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
  /** Counts the checks that came back with problems (the shell scrolls to them). */
  issueRound: number;
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
  /** Kinds ticked on step 1 (the devices may add more). */
  chosen: EmitterChoice[];
  pickedIds: string[];
  /** Area candidates added to another block than the area's guess, by entity id. */
  roles: Record<string, WizardDeviceRole>;
  /** The area whose suggested devices were pre-ticked (so a remount does not re-tick them). */
  preselectedFor: string | null;
  extras: ExtraDevice[];
  floor: Wizard['floor'];
  radiatorCircuitId: Id | null;
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
  chosen: [],
  pickedIds: [],
  roles: {},
  preselectedFor: null,
  extras: [],
  floor: { circuitId: null, setup: { name: '', pumpEntityId: null, mode: 'follow_source', sourceIds: [], runOnMin: 10 } },
  radiatorCircuitId: null,
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
  const [issueRound, setIssueRound] = useState(0);
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

  const { step, name, areaId, demand, chosen, extras, floor, radiatorCircuitId, method, heatTol, coolTol, reaction, strategy, issues, hints, reportId } = d;
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

  // on the device step the area's devices are pre-checked as the server suggests — never what belongs
  // to another room, never the heat pump or a circuit pump that happen to hang in the same area, and
  // not a head or an AC when step 1 said the room is heated otherwise (they are still offered)
  const onDevices = step >= 2;
  useEffect(() => {
    const data = discovery.data;
    if (!data || data.areaId !== areaId || !usesKnown || !onDevices) return;
    patch((x) => {
      if (x.preselectedFor === data.areaId) return {};
      const fits = (c: DiscoveryCandidate) => {
        const kind = ROLE_HEATING_KIND[c.role];
        return !kind || !x.chosen.length || x.chosen.includes(kind);
      };
      const suggested = data.candidates.filter((c) => c.preselected && !c.takenByRoomId && !inUse(c) && fits(c));
      return { preselectedFor: data.areaId, pickedIds: suggested.map((c) => c.entityId), roles: {} };
    });
  }, [discovery.data, areaId, usesKnown, inUse, patch, onDevices]);

  const areas = useMemo(
    () =>
      (areasRes.data ?? []).map((a) => ({
        id: a.areaId,
        name: a.name,
        hint:
          a.areaId === areaId && discovery.data
            ? discovery.data.candidates.length
              ? t('{count} devices found in the area — they are offered on the next step.', { count: discovery.data.candidates.length })
              : t('No devices found in this area — on the next step add them with «{add}».', { add: t('Add a device') })
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
    const set = new Set<EmitterChoice>(chosen);
    for (const dev of devices) {
      const k = ROLE_HEATING_KIND[dev.role];
      if (k) set.add(k);
    }
    return HEATING_KIND_ORDER.filter((k) => set.has(k));
  }, [devices, chosen]);

  const tempCount = devices.filter((d) => d.role === 'temperature' || d.role === 'temp_humidity').length;
  const needsCool = kinds.includes('ac') || kinds.includes('floor');
  const circuits = circuitsRes.data;
  const floorCircuits = useMemo(() => (circuits ?? []).filter((c) => c.config.kind === 'floor'), [circuits]);
  const radiatorCircuits = useMemo(() => (circuits ?? []).filter((c) => c.config.kind === 'radiators'), [circuits]);
  // the house's only floor circuit is the one; with several the user picks, with none it is set up here
  const floorCircuit = floorCircuits.find((c) => c.config.id === floor.circuitId) ?? (floorCircuits.length === 1 ? floorCircuits[0] : null);
  const settingUpFloor = kinds.includes('floor') && circuitsRes.settled && floorCircuits.length === 0;
  const floorZoned = floorCircuit ? floorCircuit.config.mode === 'zoned' : settingUpFloor && floor.setup.mode === 'zoned';
  // several radiator circuits (one per room from 0.1.0): the first one unless the user picks another
  const radiatorCircuit = radiatorCircuits.find((c) => c.config.id === radiatorCircuitId) ?? radiatorCircuits[0] ?? null;
  const heatSources = useMemo(
    () =>
      (sourcesRes.data ?? [])
        .filter((s) => s.config.scope === 'central' && s.config.capabilities.heat)
        .map((s) => ({ id: s.config.id, name: names.sourceLabel(s.config.id) ?? s.config.name })),
    [sourcesRes.data, names],
  );

  const newFloor = useMemo<NewCircuitRequest | null>(
    () =>
      settingUpFloor
        ? {
            name: floor.setup.name.trim() || t('Underfloor heating'),
            pumpEntityId: floor.setup.pumpEntityId,
            sourceIds: floor.setup.sourceIds,
            mode: floor.setup.mode,
            runOnMin: floor.setup.runOnMin,
          }
        : null,
    [settingUpFloor, floor.setup],
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
        radiatorCircuitId: kinds.includes('trv') || kinds.includes('radiator_plain') ? (radiatorCircuit?.config.id ?? null) : null,
        floorCircuitId: kinds.includes('floor') ? (floorCircuit?.config.id ?? null) : null,
        newFloorCircuit: newFloor,
      },
      // with one sensor or none there is nothing to choose: the server takes what fits the count
      method: tempCount >= 2 ? method : null,
      heatTolerance: heatTol ?? defaults?.heat ?? DEFAULT_HEAT,
      coolTolerance: needsCool ? (coolTol ?? defaults?.cool ?? DEFAULT_COOL) : null,
      windowReaction: reaction,
      trvStrategy: strategy,
    }),
    [name, areaId, kinds, demand, devices, newFloor, radiatorCircuit, floorCircuit, method, tempCount, heatTol, coolTol, needsCool, defaults, reaction, strategy],
  );

  // the newest check wins: a slow answer to an older draft must not bring back a fixed problem
  const checkSeq = useRef(0);

  const validate = useCallback(
    async (s: 1 | 2 | 3 | 4): Promise<boolean> => {
      setBusy(true);
      checkSeq.current++;
      try {
        const res = await api.rooms.validate({ step: s, draft: request });
        patch((x) => ({ issues: res.issues.map(plainPath), hints: res.hints ?? x.hints }));
        if (!res.ok) setIssueRound((n) => n + 1);
        return res.ok;
      } catch (e) {
        if (isApiError(e) && e.issues.length) {
          patch({ issues: e.issues.map(plainPath) });
          setIssueRound((n) => n + 1);
        } else toast({ tone: 'err', message: errorText(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request, patch],
  );

  // once a check has found problems they follow the edits: a fixed one goes away without another «Next»
  const hasIssues = issues.length > 0;
  useEffect(() => {
    if (!hasIssues || step > 4) return undefined;
    const s = step as 1 | 2 | 3 | 4;
    const timer = window.setTimeout(() => {
      const seq = ++checkSeq.current;
      const apply = (list: ApiErrorIssue[], next?: ValidationResult['hints']) => {
        if (seq === checkSeq.current) patch((x) => (x.step === s ? { issues: list.map(plainPath), hints: next ?? x.hints } : {}));
      };
      api.rooms
        .validate({ step: s, draft: request })
        .then((res) => apply(res.issues, res.hints))
        .catch((e: unknown) => {
          if (isApiError(e) && e.issues.length) apply(e.issues);
        });
    }, 400);
    return () => window.clearTimeout(timer);
  }, [hasIssues, step, request, patch]);

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const report = await api.rooms.create(request);
      patch({ created: report, reportId: report.reportId, step: 5, issues: [] });
      liveStore.refetchRooms();
      invalidate('overview');
    } catch (e) {
      if (isApiError(e) && e.issues.length) {
        patch({ issues: e.issues.map(plainPath) });
        setIssueRound((n) => n + 1);
      }
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

  const dirty = step < 5 && (name.trim() !== '' || areaId !== null || chosen.length > 0 || extras.length > 0);

  /** The draft without a kind and its devices (a head's own reading as the sensor goes with the last head). */
  const without = useCallback(
    (x: Draft, k: EmitterChoice): Partial<Draft> => {
      const roles = KIND_ROLES(k);
      const extrasLeft = x.extras.filter((y) => !roles.includes(y.role));
      const pickedLeft = x.pickedIds.filter((id) => {
        const c = candidates.find((cc) => cc.entityId === id);
        return !c || !roles.includes(x.roles[id] ?? c.role);
      });
      const heads = new Set([
        ...extrasLeft.filter((y) => y.role === 'trv').map((y) => y.entityId),
        ...pickedLeft.filter((id) => (x.roles[id] ?? candidates.find((c) => c.entityId === id)?.role) === 'trv'),
      ]);
      return {
        chosen: x.chosen.filter((y) => y !== k),
        extras: extrasLeft.filter((y) => !y.ownTemperature || heads.has(y.entityId)),
        pickedIds: pickedLeft,
      };
    },
    [candidates],
  );

  // smart heads and ordinary valves may both be there: some radiators have heads, others not
  const toggleKind = useCallback(
    (k: EmitterChoice) => patch((x) => (kinds.includes(k) ? without(x, k) : { chosen: [...x.chosen, k] })),
    [kinds, without, patch],
  );

  const toOrdinaryValves = useCallback(
    () =>
      patch((x) => {
        const rest = without(x, 'trv');
        const chosen = rest.chosen ?? x.chosen;
        return { ...rest, chosen: chosen.includes('radiator_plain') ? chosen : [...chosen, 'radiator_plain'] };
      }),
    [without, patch],
  );

  const addDevice = useCallback(
    (e: HaEntityDto, role: WizardDeviceRole) =>
      patch((x) => {
        const cand = candidates.find((c) => c.entityId === e.entityId);
        // the same entity once as a device; a head's own reading as the sensor stays beside it; a combined
        // sensor takes the place of its own temperature or humidity added before
        const sameSensor = (y: ExtraDevice) => role === 'temp_humidity' && !!e.deviceId && y.deviceId === e.deviceId && (y.role === 'temperature' || y.role === 'humidity');
        const others = x.extras.filter((y) => (y.entityId !== e.entityId || y.ownTemperature) && !sameSensor(y));
        if (cand) {
          const roles = { ...x.roles };
          if (role === cand.role) delete roles[cand.entityId];
          else roles[cand.entityId] = role;
          return { pickedIds: x.pickedIds.includes(cand.entityId) ? x.pickedIds : [...x.pickedIds, cand.entityId], roles, extras: others };
        }
        const room = e.usedBy.find((u) => u.type === 'room');
        const extra: ExtraDevice = {
          role,
          entityId: e.entityId,
          // a combined sensor is named after its device («Garage sensor»), not after its temperature entity
          name: role === 'temp_humidity' && e.deviceName ? e.deviceName : e.name,
          areaName: e.areaName,
          state: e.available ? e.state : 'unavailable',
          valueC: e.valueC ?? null,
          fromRoom: room ? room.label : null,
          deviceId: e.deviceId,
        };
        return { extras: [...others, extra] };
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
    toggleKind,
    toOrdinaryValves,
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
    removeExtra: (id, role) => patch((x) => ({ extras: x.extras.filter((e) => e.entityId !== id || e.role !== role) })),
    takeOwnTemperature,
    floor,
    setFloor: (f) =>
      patch((x) => ({
        floor: { circuitId: f.circuitId !== undefined ? f.circuitId : x.floor.circuitId, setup: { ...x.floor.setup, ...f.setup } },
      })),
    floorCircuits,
    floorCircuit,
    floorZoned,
    radiatorCircuits,
    radiatorCircuitId: radiatorCircuit?.config.id ?? null,
    setRadiatorCircuit: (id) => patch({ radiatorCircuitId: id }),
    radiatorCircuit,
    heatSources,
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
    issueRound,
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
