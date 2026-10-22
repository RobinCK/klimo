/**
 * One source: what it is doing now, what it can do, its energy, how it is wired to Home
 * Assistant (and how the add-on knows it really runs), where it delivers, its guards and run
 * conditions. A two-minute test and «switch off for a while» are at the top.
 */
import { useEffect, useMemo, useState } from 'react';
import type { AdapterType, ConditionEval, CurvePoint, SourceConditionItem, SourceDto, SourcePatch, SourceTestResult, WeatherCurve } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useLiveEvent, useMutation } from '@data';
import { brand } from '@brand';
import { navigate, paths } from '@app';
import {
  AutoGrid,
  Button,
  CheckboxRow,
  ConditionRow,
  EntityBindingTable,
  FeedRow,
  GuardList,
  IconButton,
  KeyValueList,
  Row,
  Section,
  SegmentedControl,
  Stack,
  StateBanner,
  StatusBanner,
  ToggleChip,
  ToneBadge,
  WeatherCurveChart,
  type EntityBindingRow,
} from '@ui';
import { adapterLabel, energyCarrierLabel, fmtDur, fmtDurSec, fmtKw, fmtPct, fmtTemp, fmtUntil, fmtClock, renderReason, t } from '@i18n';
import { conditionText } from '../conditions';
import { isRunning, SOURCE_ICON, sourceChip, type SystemData } from '../shared';
import { applySiblings, mainEntity, modeMapText, rolePreset, roleLabel, setpointText, setRole, withOptionalRows, emptyAdapter } from './bindings';
import { ConditionDrawer, DeleteDialog, DuplicateDialog, EditDialog, EnergyDialog, GuardsDialog, LockDialog, PickEntityDialog } from './SourceDialogs';
import { bindingHint, controlHint, hvacProofHint, modesHint, setpointHint, type HintSource } from './hints';

type DialogKind = 'lock' | 'edit' | 'duplicate' | 'delete' | 'energy' | 'guards';

const ADAPTERS: readonly AdapterType[] = ['relay', 'climate', 'flow', 'script'];

const STATUS_LABEL = (s: string) =>
  s === 'ok' ? t('online') : s === 'unavailable' ? t('unavailable') : s === 'missing' ? t('missing') : s === 'wrong_domain' ? t('wrong kind') : t('choose');

function testText(r: SourceTestResult, now: number): { tone: 'ok' | 'warn' | 'err' | 'event'; text: string } {
  const left = Math.max(0, Math.round((r.until - now) / 1000));
  switch (r.status) {
    case 'running':
      return { tone: 'event', text: t('Test run: {left} left · waiting for the proof that it runs', { left: fmtDurSec(left) }) };
    case 'ok':
      return { tone: 'ok', text: r.confirmAfterSec != null ? t('Test passed: confirmed in {dur}.', { dur: fmtDurSec(r.confirmAfterSec) }) : t('Test passed.') };
    case 'no_confirm':
      return { tone: 'err', text: t('Test failed: no proof that it runs. Check the confirmation entity and the device.') };
    case 'blocked':
      return { tone: 'warn', text: t('The test could not start now.') };
    case 'error':
      return { tone: 'err', text: t('The test stopped with an error.') };
  }
}

export function SourceDetail({ d, dto, phone }: { d: SystemData; dto: SourceDto; phone: boolean }) {
  const cfg = dto.config;
  const state = d.liveState(cfg.id) ?? dto.state;
  const [dialog, setDialog] = useState<DialogKind | null>(null);
  const [picking, setPicking] = useState<string | null>(null);
  const [condition, setCondition] = useState<{ item: SourceConditionItem | null } | null>(null);
  const [draftAdapter, setDraftAdapter] = useState<AdapterType | null>(null);
  const [test, setTest] = useState<SourceTestResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const replace = (s: SourceDto) => d.sources.setData((prev) => (prev ?? []).map((x) => (x.config.id === s.config.id ? s : x)));
  const patch = useMutation((p: SourcePatch) => api.sources.patch(cfg.id, p), { onSuccess: replace, onError: () => void d.sources.reload() });
  const editable = d.canEdit;

  // the live test status comes over the socket; the banner keeps the final result
  useLiveEvent('source.test', (r) => r.sourceId === cfg.id && setTest(r));
  useEffect(() => {
    if (state.test && !test)
      setTest({
        sourceId: cfg.id,
        status: state.test.result ?? 'running',
        startedAt: state.test.startedAt,
        until: state.test.until,
        confirmAfterSec: state.test.confirmAfterSec,
        blockedBy: null,
        readings: {},
      });
  }, [state.test, test, cfg.id]);
  const runTest = useMutation(() => api.sources.test(cfg.id, { durationSec: 120 }), { onSuccess: setTest });
  const stopTest = useMutation(() => api.sources.stopTest(cfg.id), { onSuccess: (r) => setTest(r ?? null) });
  const unlock = useMutation(() => api.sources.unlock(cfg.id), { onSuccess: replace, okToast: t('{source} is back in use', { source: d.nameOf(cfg.id) }) });

  const role = renderReason(state.roleReason, d.ctx);
  const running = isRunning(state);
  const tel = state.telemetry;
  const stateDetail = [
    renderReason(state.detail, d.ctx),
    running && tel.powerKw != null ? fmtKw(tel.powerKw) : null,
    running && tel.cop != null ? t('COP {cop}', { cop: tel.cop.toFixed(1) }) : null,
    tel.defrost ? t('defrosting') : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const chip = sourceChip(state);
  const testing = test?.status === 'running';

  /* ---- bindings ---- */
  const adapterType = draftAdapter ?? cfg.adapter.type;
  const adapter = draftAdapter && draftAdapter !== cfg.adapter.type ? emptyAdapter(draftAdapter) : cfg.adapter;
  const rows = draftAdapter && draftAdapter !== cfg.adapter.type ? [] : withOptionalRows(state.bindings, cfg.adapter);
  const hintSource: HintSource = { kind: cfg.kind, adapter, energy: cfg.energy, guards: cfg.guards };
  const pick = async (role: string, entityId: string | null) => {
    setPicking(null);
    let next = setRole(adapter, cfg.energy, role, entityId);
    // the device of the main entity often has the other roles too (power, error, defrost, COP)
    const main = mainEntity(next.adapter);
    if (entityId && main === entityId) {
      try {
        const detail = await api.ha.entity(entityId);
        const filled = applySiblings(next.adapter, next.energy, detail);
        next = filled;
        if (filled.filled.length) setNotice(t('Also filled from the same device: {list}', { list: filled.filled.map(roleLabel).join(', ') }));
      } catch {
        // suggestions are a convenience; the pick itself stands
      }
    }
    const res = await patch.run({ adapter: next.adapter, energy: next.energy });
    if (res) setDraftAdapter(null);
  };

  const bindingRows: EntityBindingRow[] = [
    ...rows.map((b) => ({
      role: roleLabel(b.role),
      value: b.entityId ?? t('choose an entity'),
      mono: Boolean(b.entityId),
      live: b.live ?? undefined,
      status: (b.status === 'ok'
        ? 'ok'
        : b.status === 'unset'
          ? b.required
            ? 'empty'
            : 'info'
          : b.status === 'unavailable'
            ? 'warn'
            : 'err') as EntityBindingRow['status'],
      statusLabel: b.status === 'unset' && !b.required ? undefined : STATUS_LABEL(b.status),
      onPick: editable ? () => setPicking(b.role) : undefined,
      hint: bindingHint(b.role, hintSource),
    })),
  ];
  if (draftAdapter && draftAdapter !== cfg.adapter.type) {
    for (const r of ['command', 'climate', 'enable', 'flow', 'off'].filter(
      (x) =>
        (x === 'command' && draftAdapter === 'relay') ||
        (x === 'climate' && draftAdapter === 'climate') ||
        ((x === 'enable' || x === 'flow') && draftAdapter === 'flow') ||
        (x === 'off' && draftAdapter === 'script'),
    )) {
      bindingRows.push({
        role: roleLabel(r),
        value: t('choose an entity'),
        mono: false,
        status: 'empty',
        statusLabel: t('choose'),
        onPick: () => setPicking(r),
        hint: bindingHint(r, hintSource),
      });
    }
  }
  const modes = modeMapText(adapter);
  if (modes) bindingRows.push({ role: t('Modes'), value: modes, mono: false, status: 'info', hint: modesHint() });
  const setpoint = setpointText(adapter);
  if (setpoint) bindingRows.push({ role: t('What it is given'), value: setpoint, mono: false, status: 'info', hint: setpointHint(adapter) });
  if (adapter.confirm.kind === 'hvac_action')
    bindingRows.push({ role: t('Proof it runs'), value: t('the thermostat reports heating or cooling'), mono: false, status: 'info', hint: hvacProofHint() });
  if (adapter.confirm.kind === 'readback' && !rows.some((r) => r.role === 'confirm' && r.entityId)) {
    bindingRows.push({
      role: t('Proof it runs'),
      value: t('only that the switch reads back on — weak'),
      mono: false,
      status: 'warn',
      statusLabel: t('weak proof'),
      // a new way of control has no binding row of its own to explain it yet
      hint: rows.some((r) => r.role === 'confirm') ? undefined : bindingHint('confirm', hintSource),
    });
  }

  /* ---- weather curve ---- */
  const usesCurve =
    cfg.curves.heat != null &&
    ((cfg.adapter.type === 'climate' && cfg.adapter.setpoint === 'flow_curve') ||
      cfg.adapter.type === 'flow' ||
      (cfg.adapter.type === 'relay' && cfg.adapter.flowSetpoint?.useCurve));
  const curve = useAutosave<WeatherCurve | null>(cfg.curves.heat, (c) => patch.run({ curves: { ...cfg.curves, heat: c } }), { debounceMs: 600 });
  const outdoor = d.house?.season.outdoor10C ?? d.house?.season.outdoorC ?? null;
  const flowNow = useMemo(() => (curve.value && outdoor != null ? flowAt(curve.value.points, outdoor) : null), [curve.value, outdoor]);

  /* ---- capabilities ---- */
  const caps = cfg.capabilities;
  const setCap = (k: keyof typeof caps) => editable && void patch.run({ capabilities: { ...caps, [k]: !caps[k] } });

  /* ---- feeds ---- */
  const feedChips = (list: SourceDto['feeds']['heat']) =>
    list.map((f) => ({
      label: f.type === 'circuit' ? (d.circuits.data?.find((c) => c.config.id === f.id)?.config.name ?? f.id) : (d.roomName(f.id) ?? f.id),
      to: f.type === 'room' ? paths.room(f.id) : `${paths.system()}`,
    }));

  /* ---- guards ---- */
  const g = cfg.guards;
  const guards = [
    { icon: 'shield' as const, title: t('Minimum run — {dur}', { dur: fmtDur(g.minRunMin) }), text: '' },
    { icon: 'shield' as const, title: t('Minimum pause — {dur}', { dur: fmtDur(g.minOffMin) }), text: '' },
    ...(g.maxStartsPerHour ? [{ icon: 'shield' as const, title: t('At most {n} starts per hour', { n: g.maxStartsPerHour }), text: '' }] : []),
    ...(cfg.kind === 'heat_pump' && g.defrostIsNotFault ? [{ icon: 'shield' as const, title: t('Defrosting is not a fault'), text: '' }] : []),
    {
      icon: 'swap' as const,
      title: t('Not running after {dur} → fault → the next source', { dur: fmtDur(g.startConfirmTimeoutMin) }),
      text: t('Unavailable for {dur} counts as a fault too; a retry after {retry}.', { dur: fmtDur(g.unavailableAfterMin), retry: fmtDur(g.faultRetryMin) }),
    },
    ...(g.roomMaxC != null
      ? [{ icon: 'thermometer' as const, title: t('Above {t} in the room — switch off', { t: fmtTemp(g.roomMaxC, { decimals: 0 }) }), text: '' }]
      : []),
  ];

  /* ---- conditions ---- */
  const evals = new Map<string, ConditionEval>(state.conditions.map((c) => [c.itemId, c.eval]));
  const joinText =
    cfg.conditions.join === 'all'
      ? t('runs when all conditions hold')
      : cfg.conditions.join === 'any'
        ? t('runs when any condition holds')
        : t('every mode has its own condition');

  const energyText = `${energyCarrierLabel(cfg.energy.carrier)} · ${t('up to {kw}', { kw: fmtKw(cfg.energy.maxPowerKw) })}`;
  const energyHint = [
    cfg.energy.countsInBlackoutBudget ? t('counts in the blackout budget') : t('not in the blackout budget'),
    cfg.energy.nightTariffEligible ? t('may use the night tariff') : null,
    cfg.energy.minBatteryPct != null ? t('in a blackout while the battery is above {pct}', { pct: fmtPct(cfg.energy.minBatteryPct) }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const template = cfg.linkedTo ? (d.sources.data ?? []).find((s) => s.config.id === cfg.linkedTo) : null;

  return (
    <Section
      icon={SOURCE_ICON[cfg.kind]}
      title={phone ? undefined : d.nameOf(cfg.id)}
      subtitle={[cfg.subtype, role].filter(Boolean).join(' · ')}
      action={
        <Row gap="sm" wrap justify={phone ? 'start' : 'end'}>
          {testing ? (
            <Button variant="secondary" size="sm" icon="close" onClick={() => void stopTest.run()} loading={stopTest.pending}>
              {t('Stop the test')}
            </Button>
          ) : (
            <Button variant="secondary" size="sm" icon="play" onClick={() => void runTest.run()} loading={runTest.pending} disabled={!editable || !cfg.enabled}>
              {t('Test for 2 min')}
            </Button>
          )}
          {state.lock ? (
            <Button variant="outline" size="sm" onClick={() => void unlock.run()} loading={unlock.pending} disabled={!editable}>
              {t('Switch back on')}
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setDialog('lock')} disabled={!editable || !cfg.enabled}>
              {t('Off for a while…')}
            </Button>
          )}
          {editable ? (
            <>
              <IconButton icon="pencil" label={t('Name and place')} variant="ghost" onClick={() => setDialog('edit')} />
              <IconButton icon="copy" label={t('Duplicate')} variant="ghost" onClick={() => setDialog('duplicate')} />
              <IconButton icon="trash" label={t('Delete')} variant="ghost" onClick={() => setDialog('delete')} />
            </>
          ) : null}
        </Row>
      }
    >
      <Stack gap="xl">
        <StateBanner
          tone={chip.tone}
          label={cfg.enabled ? chip.label : t('Not in use')}
          detail={cfg.enabled ? stateDetail : t('The add-on does not switch it until it is put in use.')}
        />
        {!cfg.enabled ? (
          <StatusBanner
            tone="warn"
            icon="power"
            text={t('Not in use yet. Choose its entities below, then put it in use.')}
            action={editable ? { label: t('Put in use'), onClick: () => void patch.run({ enabled: true }) } : undefined}
          />
        ) : null}
        {state.lock ? (
          <StatusBanner
            tone="warn"
            icon="pause"
            text={t('Switched off {until} — the next source in the chain covers.', { until: fmtUntil(state.lock.until, d.now) })}
          />
        ) : null}
        {test ? (
          <StatusBanner
            tone={testText(test, d.now).tone}
            icon={test.status === 'ok' ? 'checkCircle' : 'play'}
            text={testText(test, d.now).text + (test.blockedBy ? ` ${renderReason(test.blockedBy, d.ctx)}` : '')}
          />
        ) : null}
        {state.fault ? (
          <StatusBanner
            tone="err"
            icon="alert"
            text={t('Fault since {since} — next try at {at}.', { since: fmtClock(state.fault.since, d.now), at: fmtClock(state.fault.retryAt, d.now) })}
          />
        ) : null}
        {template ? (
          <StatusBanner
            tone="event"
            icon="layers"
            text={
              cfg.ownFields.length
                ? t('Like «{name}»; changed here: {list}.', { name: d.nameOf(template.config.id), list: cfg.ownFields.join(', ') })
                : t('Like «{name}»: guards, energy and conditions follow it.', { name: d.nameOf(template.config.id) })
            }
            action={{ label: t('Open'), to: paths.source(template.config.id) }}
          />
        ) : null}
        {dto.linkedChildren.length ? (
          <StatusBanner
            tone="event"
            icon="layers"
            text={t('{count} copies follow this source: {list}.', { count: dto.linkedChildren.length, list: dto.linkedChildren.map(d.nameOf).join(', ') })}
          />
        ) : null}

        <AutoGrid min={260} gap="lg">
          <Section variant="plain" level={3} title={t('What it can do')}>
            <Row gap="sm" wrap>
              <ToggleChip pressed={caps.heat} icon="flame" label={t('Heat')} accent="heat" onToggle={() => setCap('heat')} />
              <ToggleChip pressed={caps.cool} icon="snow" label={t('Cool')} accent="cool" onToggle={() => setCap('cool')} />
              <ToggleChip pressed={caps.dry} icon="droplet" label={t('Dry')} onToggle={() => setCap('dry')} />
              <ToggleChip pressed={caps.fan} icon="fan" label={t('Fan')} onToggle={() => setCap('fan')} />
            </Row>
          </Section>
          <Section
            variant="plain"
            level={3}
            title={t('Energy')}
            action={
              editable ? (
                <Button variant="link" size="sm" onClick={() => setDialog('energy')}>
                  {t('Change')}
                </Button>
              ) : undefined
            }
          >
            <KeyValueList rows={[{ key: energyText, value: energyHint }]} />
          </Section>
        </AutoGrid>

        <Section
          variant="plain"
          level={3}
          title={t('Control from Home Assistant')}
          subtitle={t('how {product} switches this source and how it knows it really runs', { product: brand.productName })}
          hint={controlHint()}
        >
          <Stack gap="md">
            <SegmentedControl<AdapterType>
              ariaLabel={t('Way of control')}
              value={adapterType}
              options={(cfg.adapter.type === 'custom' ? [...ADAPTERS, 'custom' as const] : ADAPTERS).map((a) => ({
                value: a,
                label: adapterLabel(a),
                disabled: !editable,
              }))}
              onChange={(a) => setDraftAdapter(a === cfg.adapter.type ? null : a)}
            />
            {draftAdapter && draftAdapter !== cfg.adapter.type ? (
              <StatusBanner
                tone="warn"
                icon="swap"
                text={t('A new way of control: choose its entities. The current wiring stays until the first entity is chosen.')}
              />
            ) : null}
            <EntityBindingTable ariaLabel={t('Entities of the source')} rows={bindingRows} />
            {notice ? <StatusBanner tone="ok" icon="sparkle" text={notice} /> : null}
            {usesCurve && curve.value ? (
              <Section
                variant="well"
                level={3}
                title={t('Weather curve of the flow')}
                tag={
                  outdoor != null && flowNow != null
                    ? t('now {out} outdoor → flow {flow}', { out: fmtTemp(outdoor), flow: fmtTemp(flowNow, { decimals: 0 }) })
                    : undefined
                }
              >
                <WeatherCurveChart
                  points={curve.value.points.map((p) => ({ x: p.outdoorC, y: p.flowC }))}
                  now={outdoor}
                  editable={editable}
                  range={[curve.value.minFlowC, curve.value.maxFlowC]}
                  step={1}
                  unit="°"
                  onChange={(pts) => curve.set({ ...(curve.value as WeatherCurve), points: pts.map((p): CurvePoint => ({ outdoorC: p.x, flowC: p.y })) })}
                  ariaLabel={curveAria(curve.value)}
                />
              </Section>
            ) : null}
          </Stack>
        </Section>

        <AutoGrid min={300} gap="lg">
          <Section variant="plain" level={3} title={t('Where it delivers')}>
            <Stack gap="sm">
              <FeedRow label={t('Heating →')} tone="heat" chips={feedChips(dto.feeds.heat)} empty={t('does not heat')} />
              <FeedRow label={t('Cooling →')} tone="cool" chips={feedChips(dto.feeds.cool)} empty={t('does not cool')} />
            </Stack>
          </Section>
          <Section
            variant="plain"
            level={3}
            title={t('Guards')}
            action={
              editable ? (
                <Button variant="link" size="sm" onClick={() => setDialog('guards')}>
                  {t('Change')}
                </Button>
              ) : undefined
            }
          >
            <GuardList items={guards} />
          </Section>
        </AutoGrid>

        <Section
          variant="plain"
          level={3}
          title={t('When it may run')}
          tag={joinText}
          action={
            editable ? (
              <SegmentedControl<'all' | 'any' | 'perMode'>
                size="xs"
                ariaLabel={t('How the conditions combine')}
                value={cfg.conditions.join}
                options={[
                  { value: 'all', label: t('all') },
                  { value: 'any', label: t('any') },
                  { value: 'perMode', label: t('per mode') },
                ]}
                onChange={(join) => void patch.run({ conditions: { ...cfg.conditions, join } })}
              />
            ) : undefined
          }
        >
          <Stack gap="sm">
            {cfg.conditions.items.map((it) => {
              const ev = evals.get(it.id);
              const met = ev ? (ev.status === 'ok' ? ev.met : null) : null;
              return (
                <Row key={it.id} gap="sm" align="center">
                  <Stack grow align="stretch">
                    <ConditionRow
                      met={it.enabled ? met : false}
                      text={conditionText(it.node, d.ctx)}
                      sub={
                        [it.mode ? (it.mode === 'heat' ? t('for heating') : t('for cooling')) : null, it.enabled ? null : t('switched off')]
                          .filter(Boolean)
                          .join(' · ') || undefined
                      }
                      badge={!it.enabled ? t('off') : met == null ? t('unknown') : met ? t('holds') : t('no')}
                    />
                  </Stack>
                  {editable ? <IconButton icon="pencil" label={t('Edit the condition')} variant="ghost" onClick={() => setCondition({ item: it })} /> : null}
                </Row>
              );
            })}
            {!cfg.conditions.items.length ? (
              <StatusBanner tone="event" icon="info" text={t('No own conditions — it follows the strategy and its triggers.')} />
            ) : null}
            {editable ? (
              <Row>
                <Button variant="secondary" size="sm" icon="plus" onClick={() => setCondition({ item: null })}>
                  {t('Condition or trigger')}
                </Button>
              </Row>
            ) : null}
          </Stack>
        </Section>

        <Section variant="plain" level={3} title={t('Notifications about this source')}>
          <Stack gap="sm">
            <Row gap="xs" wrap>
              <ToneBadge tone="err">{t('Fault or did not start')}</ToneBadge>
              <ToneBadge tone="err">{t('Entity unavailable')}</ToneBadge>
              <ToneBadge tone="hold">{t('Switched to the reserve')}</ToneBadge>
              {cfg.adapter.type === 'relay' ? <ToneBadge tone="warn">{t('The relay did not follow')}</ToneBadge> : null}
            </Row>
            <Row>
              <Button variant="link" size="sm" to={paths.notifications()}>
                {t('Channels and notification rules')}
              </Button>
            </Row>
          </Stack>
        </Section>

        {editable && cfg.enabled ? (
          <CheckboxRow
            variant="well"
            checked={cfg.enabled}
            title={t('In operation')}
            hint={t('Switched off, the add-on never starts it; the strategy skips it.')}
            onChange={(enabled) => void patch.run({ enabled })}
          />
        ) : null}
      </Stack>

      {dialog === 'lock' ? <LockDialog d={d} dto={dto} onClose={() => setDialog(null)} /> : null}
      {dialog === 'edit' ? <EditDialog d={d} dto={dto} onClose={() => setDialog(null)} /> : null}
      {dialog === 'duplicate' ? (
        <DuplicateDialog
          d={d}
          dto={dto}
          onClose={() => setDialog(null)}
          onCreated={(id) => {
            void d.sources.reload();
            navigate(paths.source(id));
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <DeleteDialog d={d} dto={dto} onClose={() => setDialog(null)} onDeleted={() => navigate(paths.sources(), { replace: true })} />
      ) : null}
      {dialog === 'energy' ? <EnergyDialog d={d} dto={dto} onClose={() => setDialog(null)} /> : null}
      {dialog === 'guards' ? <GuardsDialog d={d} dto={dto} onClose={() => setDialog(null)} /> : null}
      {picking ? (
        <PickEntityDialog
          role={picking}
          preset={rolePreset(picking)}
          value={rows.find((r) => r.role === picking)?.entityId ?? null}
          onClose={() => setPicking(null)}
          onPick={(id) => void pick(picking, id)}
        />
      ) : null}
      {condition ? <ConditionDrawer d={d} dto={dto} item={condition.item} onClose={() => setCondition(null)} /> : null}
    </Section>
  );
}

/** Flow temperature of a piecewise-linear curve at `x` (clamped at the ends). */
export function flowAt(points: readonly CurvePoint[], x: number): number | null {
  const p = [...points].sort((a, b) => a.outdoorC - b.outdoorC);
  if (!p.length) return null;
  if (x <= p[0].outdoorC) return p[0].flowC;
  if (x >= p[p.length - 1].outdoorC) return p[p.length - 1].flowC;
  for (let i = 1; i < p.length; i++) {
    if (x <= p[i].outdoorC) {
      const a = p[i - 1];
      const b = p[i];
      return a.flowC + ((b.flowC - a.flowC) * (x - a.outdoorC)) / (b.outdoorC - a.outdoorC);
    }
  }
  return null;
}

function curveAria(c: WeatherCurve): string {
  const p = [...c.points].sort((a, b) => a.outdoorC - b.outdoorC);
  if (p.length < 2) return t('Weather curve of the flow');
  const cold = p[0];
  const warm = p[p.length - 1];
  return t('The colder outside, the hotter the flow: from {warmFlow} at {warmOut} to {coldFlow} at {coldOut}', {
    warmFlow: fmtTemp(warm.flowC, { decimals: 0 }),
    warmOut: fmtTemp(warm.outdoorC, { decimals: 0 }),
    coldFlow: fmtTemp(cold.flowC, { decimals: 0 }),
    coldOut: fmtTemp(cold.outdoorC, { decimals: 0 }),
  });
}
