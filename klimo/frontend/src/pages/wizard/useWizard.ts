/**
 * The add-room wizard: a draft that grows step by step, devices offered from the chosen Home
 * Assistant area, server-side validation before every «Далі» (the server knows which entities
 * exist and belong elsewhere), and after «Створити кімнату» a live report of what the room's
 * devices confirmed.
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
  Id,
  SourceDemandPolicy,
  TrvStrategy,
  ValidationResult,
  WindowReaction,
  WizardDeviceRole,
} from '@api/model';
import { api } from '@api/endpoints';
import { isApiError } from '@api/client';
import { invalidate, liveStore, useResource, useWizardReport } from '@data';
import { currentRoute } from '@app';
import { errorText, t } from '@i18n';
import { toast } from '@ui';

export type EmitterChoice = CreateRoomRequest['emitterKinds'][number];
export type WizardStep = 1 | 2 | 3 | 4 | 5;

/** A device the user added by hand with «+ Знайти інший пристрій». */
export interface ExtraDevice {
  role: WizardDeviceRole;
  entityId: string;
  name: string;
}

/** Which device roles each emitter choice brings into step 2. */
export const ROLE_NEEDS: Partial<Record<WizardDeviceRole, EmitterChoice>> = {
  trv: 'trv',
  ac: 'ac',
  heater: 'local',
  floor_zone: 'floor',
  floor_probe: 'floor',
};

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
  kinds: EmitterChoice[];
  toggleKind: (k: EmitterChoice) => void;
  demand: SourceDemandPolicy;
  setDemand: (p: SourceDemandPolicy) => void;
  candidates: DiscoveryCandidate[];
  discovering: boolean;
  integrations: string[];
  areaName: string | null;
  picked: (c: DiscoveryCandidate) => boolean;
  togglePick: (c: DiscoveryCandidate) => void;
  extras: ExtraDevice[];
  addExtra: (d: ExtraDevice) => void;
  removeExtra: (entityId: string) => void;
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
  kinds: EmitterChoice[];
  demand: SourceDemandPolicy;
  pickedIds: string[];
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
  kinds: ['trv'],
  demand: 'call',
  pickedIds: [],
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

  const { step, name, areaId, kinds, demand, extras, floor, method, heatTol, coolTol, reaction, strategy, issues, hints, reportId } = d;
  const pickedIds = useMemo(() => new Set(d.pickedIds), [d.pickedIds]);

  const discovery = useResource(areaId ? `area-discovery:${areaId}` : null, () => api.ha.discoverArea(areaId as string));
  const candidates = useMemo(() => discovery.data?.candidates ?? [], [discovery.data]);

  // the area's devices arrive: pre-check what the server suggests (never what belongs to another room)
  useEffect(() => {
    const data = discovery.data;
    if (!data || data.areaId !== areaId) return;
    patch((x) => {
      if (x.preselectedFor === data.areaId) return {};
      const ac = data.candidates.some((c) => c.role === 'ac' && c.preselected) && !x.kinds.includes('ac');
      return {
        preselectedFor: data.areaId,
        pickedIds: data.candidates.filter((c) => c.preselected && !c.takenByRoomId).map((c) => c.entityId),
        kinds: ac ? [...x.kinds, 'ac'] : x.kinds,
      };
    });
  }, [discovery.data, areaId, patch]);

  const areas = useMemo(
    () =>
      (areasRes.data ?? []).map((a) => ({
        id: a.areaId,
        name: a.name,
        hint:
          a.areaId === areaId && discovery.data
            ? discovery.data.candidates.length
              ? t('{count} devices found in the area — they are offered on the next step.', { count: discovery.data.candidates.length })
              : t('No devices found in this area — you can pick them by hand.')
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

  const roleAllowed = useCallback(
    (role: WizardDeviceRole) => {
      const need = ROLE_NEEDS[role];
      return !need || kinds.includes(need);
    },
    [kinds],
  );

  const devices = useMemo<CreateRoomRequest['devices']>(() => {
    const out: CreateRoomRequest['devices'] = [];
    for (const c of candidates) {
      if (!pickedIds.has(c.entityId) || !roleAllowed(c.role)) continue;
      out.push({ role: c.role, entityId: c.entityId, name: c.name, move: c.takenByRoomId ? true : undefined });
    }
    for (const x of extras) if (roleAllowed(x.role)) out.push({ role: x.role, entityId: x.entityId, name: x.name || undefined });
    return out;
  }, [candidates, pickedIds, extras, roleAllowed]);

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

  const dirty = step < 5 && (name.trim() !== '' || areaId !== null || extras.length > 0);

  return {
    step,
    goTo,
    name,
    setName: (v) => patch({ name: v, nameTouched: true }),
    areaId,
    setArea,
    areas,
    kinds,
    toggleKind: (k) => patch((x) => ({ kinds: x.kinds.includes(k) ? x.kinds.filter((y) => y !== k) : [...x.kinds, k] })),
    demand,
    setDemand: (v) => patch({ demand: v }),
    candidates,
    discovering: discovery.loading && !discovery.data,
    integrations: discovery.data?.integrations ?? [],
    areaName: discovery.data?.areaName ?? areasRes.data?.find((a) => a.areaId === areaId)?.name ?? null,
    picked: (c) => pickedIds.has(c.entityId),
    togglePick: (c) =>
      patch((x) => ({ pickedIds: x.pickedIds.includes(c.entityId) ? x.pickedIds.filter((id) => id !== c.entityId) : [...x.pickedIds, c.entityId] })),
    extras,
    addExtra: (dev) => patch((x) => ({ extras: [...x.extras.filter((e) => e.entityId !== dev.entityId), dev] })),
    removeExtra: (id) => patch((x) => ({ extras: x.extras.filter((e) => e.entityId !== id) })),
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
