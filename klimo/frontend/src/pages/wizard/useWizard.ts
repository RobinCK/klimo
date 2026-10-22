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

export function useWizard(): Wizard {
  const settings = useResource('settings', api.settings.get, { reloadOn: ['settings'] });
  const areasRes = useResource('ha-areas', api.ha.areas);
  const circuitsRes = useResource('names:circuits', api.circuits.list, { reloadOn: ['circuit', 'pump'] });
  const defaults = settings.data?.general.defaults.tolerance;

  const [step, setStep] = useState<WizardStep>(1);
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [areaId, setAreaId] = useState<string | null>(null);
  const [kinds, setKinds] = useState<EmitterChoice[]>(['trv']);
  const [demand, setDemand] = useState<SourceDemandPolicy>('call');
  const [pickedIds, setPickedIds] = useState<Set<string>>(new Set());
  const [extras, setExtras] = useState<ExtraDevice[]>([]);
  const [floor, setFloorState] = useState<Wizard['floor']>({ circuitId: null, newName: '', pumpEntityId: null });
  const [method, setMethodState] = useState<AggregationMethod | null>(null);
  const [heatTol, setHeatTol] = useState<Band | null>(null);
  const [coolTol, setCoolTol] = useState<Band | null>(null);
  const [reaction, setReaction] = useState<WindowReaction>('pause');
  const [strategy, setStrategyState] = useState<TrvStrategy | null>(null);
  const [issues, setIssues] = useState<ApiErrorIssue[]>([]);
  const [hints, setHints] = useState<ValidationResult['hints']>(undefined);
  const [busy, setBusy] = useState(false);
  const [reportId, setReportId] = useState<Id | null>(null);
  const [created, setCreated] = useState<CreateRoomReport | null>(null);
  const [retrying, setRetrying] = useState<CreateRoomStepKind | null>(null);

  const discovery = useResource(areaId ? `area-discovery:${areaId}` : null, () => api.ha.discoverArea(areaId as string));
  const candidates = useMemo(() => discovery.data?.candidates ?? [], [discovery.data]);

  // the area's devices arrive: pre-check what the server suggests (never what belongs to another room)
  useEffect(() => {
    if (!discovery.data) return;
    setPickedIds(new Set(discovery.data.candidates.filter((c) => c.preselected && !c.takenByRoomId).map((c) => c.entityId)));
    if (discovery.data.candidates.some((c) => c.role === 'ac' && c.preselected)) setKinds((k) => (k.includes('ac') ? k : [...k, 'ac']));
  }, [discovery.data]);

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
      setAreaId(id);
      // the room is usually called like its area
      const area = areasRes.data?.find((a) => a.areaId === id);
      if (area && (!nameTouched || !name.trim())) setName(area.name);
    },
    [areasRes.data, nameTouched, name],
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
        setIssues(res.issues);
        if (res.hints) setHints(res.hints);
        return res.ok;
      } catch (e) {
        if (isApiError(e) && e.issues.length) setIssues(e.issues);
        else toast({ tone: 'err', message: errorText(e) });
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request],
  );

  const create = useCallback(async () => {
    setBusy(true);
    try {
      const report = await api.rooms.create(request);
      setCreated(report);
      setReportId(report.reportId);
      setStep(5);
      liveStore.refetchRooms();
      invalidate('overview');
    } catch (e) {
      if (isApiError(e) && e.issues.length) setIssues(e.issues);
      toast({ tone: 'err', message: t('The room was not created: {reason}', { reason: errorText(e) }) });
    } finally {
      setBusy(false);
    }
  }, [request]);

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
      if (await validate(step)) {
        setIssues([]);
        setStep((step + 1) as WizardStep);
      }
    })();
  }, [busy, step, validate, create]);

  const back = useCallback(() => {
    setIssues([]);
    setStep((s) => (s > 1 && s < 5 ? ((s - 1) as WizardStep) : s));
  }, []);

  const goTo = useCallback((s: 1 | 2 | 3 | 4) => {
    setIssues([]);
    setStep(s);
  }, []);

  const live = useWizardReport(reportId);
  const report = live ?? created;

  const retry = useCallback(
    (kind: CreateRoomStepKind) => {
      if (!reportId) return;
      setRetrying(kind);
      api.rooms
        .retryStep(reportId, kind)
        .then(setCreated)
        .catch((e: unknown) => toast({ tone: 'err', message: errorText(e) }))
        .finally(() => setRetrying(null));
    },
    [reportId],
  );

  const reset = useCallback(() => {
    setStep(1);
    setName('');
    setNameTouched(false);
    setAreaId(null);
    setKinds(['trv']);
    setDemand('call');
    setPickedIds(new Set());
    setExtras([]);
    setFloorState({ circuitId: null, newName: '', pumpEntityId: null });
    setMethodState(null);
    setHeatTol(null);
    setCoolTol(null);
    setReaction('pause');
    setStrategyState(null);
    setIssues([]);
    setHints(undefined);
    setReportId(null);
    setCreated(null);
  }, []);

  const dirty = step < 5 && (name.trim() !== '' || areaId !== null || extras.length > 0);

  return {
    step,
    goTo,
    name,
    setName: (v) => {
      setName(v);
      setNameTouched(true);
    },
    areaId,
    setArea,
    areas,
    kinds,
    toggleKind: (k) => setKinds((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k])),
    demand,
    setDemand,
    candidates,
    discovering: discovery.loading && !discovery.data,
    integrations: discovery.data?.integrations ?? [],
    areaName: discovery.data?.areaName ?? areasRes.data?.find((a) => a.areaId === areaId)?.name ?? null,
    picked: (c) => pickedIds.has(c.entityId),
    togglePick: (c) =>
      setPickedIds((s) => {
        const n = new Set(s);
        if (n.has(c.entityId)) n.delete(c.entityId);
        else n.add(c.entityId);
        return n;
      }),
    extras,
    addExtra: (d) => setExtras((xs) => [...xs.filter((x) => x.entityId !== d.entityId), d]),
    removeExtra: (id) => setExtras((xs) => xs.filter((x) => x.entityId !== id)),
    floor,
    setFloor: (f) => setFloorState((x) => ({ ...x, ...f })),
    floorCircuits,
    method: method ?? methodForCount(tempCount),
    setMethod: setMethodState,
    methodValues: hints?.methodValues,
    heatTol: request.heatTolerance,
    setHeatTol,
    coolTol: request.coolTolerance ?? coolTol ?? defaults?.cool ?? DEFAULT_COOL,
    setCoolTol,
    needsCool,
    reaction,
    setReaction,
    strategy,
    setStrategy: setStrategyState,
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
