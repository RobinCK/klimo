import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConditionEval, ConditionNode, ConditionPreviewResult, Cmp, Dow, HaEntityDto, HouseMode, NumCmp, Season } from '@api/model';
import type { Tone } from '../../types';
import type { UiTextFn } from '../../UiTextContext';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { Button } from '../../basic/Button';
import { SegmentedControl } from '../inputs/choice';
import { Select, TextField, NumberField, TimeRangeInput, type SelectOption } from '../inputs/fields';
import { EntityPicker } from '../inputs/EntityPicker';
import { CheckboxRow, ToggleChip } from '../inputs/toggles';
import { DayOfWeekToggle } from '../inputs/pickers';
import { toneVars } from '../internal/util';
import { childEval, defaultNode, emptyWindow, incomplete, isGroup, LEAF_OPS, splitList, type ConditionOp, type LeafNode, type OptionCtx } from './nodes';
import s from './condition.module.css';

// edits settle this long before the live preview asks the server
const PREVIEW_DEBOUNCE_MS = 500;

export interface ConditionEditorProps {
  value: ConditionNode;
  onChange: (node: ConditionNode) => void;
  /** Evaluates the tree against live data (the page calls the preview endpoint). */
  preview: (node: ConditionNode) => Promise<ConditionPreviewResult>;
  /** Entity search for entity-based conditions. */
  search: (q: string) => Promise<HaEntityDto[]>;
  triggers: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  /** Sources for «джерело працює / в аварії» conditions. */
  sources?: { id: string; name: string }[];
  /** Restrict what can be added (a watch rule needs only entity conditions). */
  allowedOps?: LeafNode['op'][];
}

function opLabel(op: ConditionOp, ut: UiTextFn): string {
  const labels: Record<ConditionOp, string> = {
    all: ut('All of'),
    any: ut('Any of'),
    not: ut('Not'),
    state: ut('Entity state'),
    numeric: ut('Entity value'),
    template: ut('Home Assistant template'),
    time: ut('Time of day'),
    sun: ut('Sun'),
    weather: ut('Weather'),
    trigger: ut('Another trigger'),
    outdoor: ut('Outdoor temperature'),
    room_deficit: ut('Rooms are short of the target'),
    room_below_target: ut('A room is below its target'),
    source: ut('A source'),
    season: ut('Season'),
    house_mode: ut('House mode'),
    budget_fits: ut('Energy budget allows'),
    grid: ut('Grid power'),
    const: ut('Always'),
  };
  return labels[op];
}

function cmpOptions(ut: UiTextFn, withEq: boolean): SelectOption<Cmp>[] {
  const base: SelectOption<Cmp>[] = [
    { value: '<', label: ut('below') },
    { value: '<=', label: ut('at most') },
    { value: '>', label: ut('above') },
    { value: '>=', label: ut('at least') },
  ];
  return withEq ? [...base, { value: '==', label: ut('equals') }, { value: '!=', label: ut('is not') }] : base;
}

/* ---------------- live state badge ---------------- */

function EvalBadge({ ev }: { ev?: ConditionEval }) {
  const ut = useUiText();
  if (!ev) return null;
  let tone: Tone = 'off';
  let text = ut('no');
  if (ev.status === 'error') {
    tone = 'err';
    text = ev.error ? ut('error: {why}', { why: ev.error }) : ut('error');
  } else if (ev.status === 'unknown') {
    tone = 'warn';
    text = ut('unknown');
  } else if (ev.met) {
    tone = 'ok';
    text = ut('yes');
  } else if (ev.pendingSec != null && ev.pendingSec > 0) {
    tone = 'event';
    text = ut('yes in {n} s', { n: Math.ceil(ev.pendingSec) });
  }
  const value = ev.value != null && ev.value !== '' ? ` · ${ev.value}` : '';
  return (
    <span className={s.badge} style={toneVars(tone)} role="status">
      {text}
      {value}
    </span>
  );
}

/* ---------------- field helpers ---------------- */

function Labelled({ label, children, wide, narrow }: { label: string; children: ReactNode; wide?: boolean; narrow?: boolean }) {
  return (
    <div className={s.labelled} data-wide={wide ? '' : undefined} data-narrow={narrow ? '' : undefined}>
      <span className={s.fieldLabel}>{label}</span>
      {children}
    </div>
  );
}

function ForSeconds({ value, onChange }: { value?: number; onChange: (v: number | undefined) => void }) {
  const ut = useUiText();
  return (
    <div data-narrow="">
      <NumberField
        label={ut('for at least')}
        value={value ?? 0}
        min={0}
        max={86400}
        step={10}
        unit={ut('s')}
        onChange={(v) => onChange(v > 0 ? v : undefined)}
        hint={ut('It counts as true only after holding this long without a break, and turns false at once. 0 — at once; e.g. 120 s, so a short spike or a Zigbee glitch changes nothing.')}
      />
    </div>
  );
}

function exitAtHint(ut: UiTextFn): string {
  return ut('Once true, it stays true until the value comes back across this second number. E.g. «battery below 30» with 40 here: on at 29 %, off only at 40 %, so a value hovering around 30 % does not flip it.');
}

function OptionalNumber({
  label,
  value,
  onChange,
  min,
  max,
  step,
  unit,
  info,
}: {
  label: string;
  value?: number;
  onChange: (v: number | undefined) => void;
  min: number;
  max: number;
  step: number;
  unit?: string;
  info?: string;
}) {
  const ut = useUiText();
  const on = value != null;
  return (
    <div className={s.labelled}>
      <CheckboxRow checked={on} title={label} info={info} onChange={(c) => onChange(c ? Math.max(min, Math.min(max, 0)) : undefined)} />
      {on ? <NumberField ariaLabel={label} value={value ?? 0} min={min} max={max} step={step} unit={unit} onChange={onChange} /> : <span className={s.fieldLabel}>{ut('off')}</span>}
    </div>
  );
}

/* ---------------- leaf editors ---------------- */

interface LeafProps {
  node: LeafNode;
  onChange: (n: ConditionNode) => void;
  search: ConditionEditorProps['search'];
  ctx: OptionCtx;
}

function LeafFields({ node, onChange, search, ctx }: LeafProps) {
  const ut = useUiText();
  const days = [ut('Mon'), ut('Tue'), ut('Wed'), ut('Thu'), ut('Fri'), ut('Sat'), ut('Sun')];
  const numCmp = cmpOptions(ut, false) as SelectOption<NumCmp>[];
  const pickEntity = (placeholder: string, value: string, set: (id: string) => void, wide = true) => (
    <Labelled label={ut('Entity')} wide={wide}>
      <EntityPicker value={value || null} onChange={(id) => set(id ?? '')} search={search} placeholder={placeholder} ariaLabel={ut('Entity')} />
    </Labelled>
  );

  switch (node.op) {
    case 'state':
      return (
        <div className={s.fields}>
          {pickEntity(ut('Find an entity…'), node.entityId, (entityId) => onChange({ ...node, entityId }))}
          <TextField label={ut('Attribute (optional)')} value={node.attribute ?? ''} mono onChange={(v) => onChange({ ...node, attribute: v.trim() || undefined })} />
          <TextField
            label={ut('Is one of (comma separated)')}
            value={node.equals.join(', ')}
            mono
            onChange={(v) => onChange({ ...node, equals: splitList(v) })}
          />
          <ForSeconds value={node.forSec} onChange={(forSec) => onChange({ ...node, forSec })} />
        </div>
      );
    case 'numeric':
      return (
        <div className={s.fields}>
          {pickEntity(ut('Find a sensor…'), node.entityId, (entityId) => onChange({ ...node, entityId }))}
          <TextField label={ut('Attribute (optional)')} value={node.attribute ?? ''} mono onChange={(v) => onChange({ ...node, attribute: v.trim() || undefined })} />
          <Labelled label={ut('Comparison')} narrow>
            <Select value={node.cmp} options={numCmp} onChange={(cmp) => onChange({ ...node, cmp })} ariaLabel={ut('Comparison')} />
          </Labelled>
          <NumberField label={ut('Value')} value={node.value} min={-100000} max={100000} step={0.1} onChange={(value) => onChange({ ...node, value })} />
          <OptionalNumber
            label={ut('Hysteresis: stays true until')}
            info={exitAtHint(ut)}
            value={node.exitAt}
            min={-100000}
            max={100000}
            step={0.1}
            onChange={(exitAt) => onChange({ ...node, exitAt })}
          />
          <Labelled label={ut('Minus another entity (optional)')} wide>
            <EntityPicker
              value={node.minus ?? null}
              onChange={(id) => onChange({ ...node, minus: id ?? undefined })}
              search={search}
              placeholder={ut('e.g. house load from solar power')}
              clearable
            />
          </Labelled>
          <ForSeconds value={node.forSec} onChange={(forSec) => onChange({ ...node, forSec })} />
        </div>
      );
    case 'template':
      return (
        <div className={s.fields}>
          <div data-wide="">
            <TextField
              label={ut('Template that renders true or false')}
              value={node.template}
              multiline
              mono
              placeholder="{{ states('sensor.pv_power') | float(0) > 1500 }}"
              onChange={(template) => onChange({ ...node, template })}
            />
          </div>
          <ForSeconds value={node.forSec} onChange={(forSec) => onChange({ ...node, forSec })} />
        </div>
      );
    case 'time':
      return (
        <div className={s.fields}>
          <div data-wide="" className={s.labelled}>
            {node.windows.map((w, i) => (
              <div key={i} className={s.window}>
                <TimeRangeInput
                  from={w.from}
                  to={w.to}
                  ariaLabel={ut('Time window {n}', { n: i + 1 })}
                  onChange={(r) => onChange({ ...node, windows: node.windows.map((x, j) => (j === i ? { ...x, ...r } : x)) })}
                />
                <DayOfWeekToggle
                  value={w.days ?? [0, 1, 2, 3, 4, 5, 6]}
                  labels={days}
                  ariaLabel={ut('Days')}
                  onChange={(d) =>
                    onChange({ ...node, windows: node.windows.map((x, j) => (j === i ? { ...x, days: d.length === 7 ? undefined : (d as Dow[]) } : x)) })
                  }
                />
                {node.windows.length > 1 ? (
                  <IconButton
                    icon="trash"
                    label={ut('Remove the window')}
                    size={40}
                    variant="ghost"
                    onClick={() => onChange({ ...node, windows: node.windows.filter((_, j) => j !== i) })}
                  />
                ) : null}
              </div>
            ))}
            <span>
              <Button variant="ghost" size="sm" icon="plus" onClick={() => onChange({ ...node, windows: [...node.windows, emptyWindow()] })}>
                {ut('Add a window')}
              </Button>
            </span>
          </div>
          <Labelled label={ut('Only while a tariff entity is (optional)')} wide>
            <EntityPicker
              value={node.tariffEntityId ?? null}
              onChange={(id) => onChange({ ...node, tariffEntityId: id ?? undefined })}
              search={search}
              placeholder={ut('Find a tariff entity…')}
              clearable
            />
          </Labelled>
          {node.tariffEntityId ? (
            <TextField
              label={ut('Tariff states (comma separated)')}
              value={(node.tariffStates ?? []).join(', ')}
              mono
              onChange={(v) => onChange({ ...node, tariffStates: splitList(v) })}
            />
          ) : null}
        </div>
      );
    case 'sun': {
      const options: SelectOption<typeof node.is>[] = [
        { value: 'above_horizon', label: ut('above the horizon') },
        { value: 'below_horizon', label: ut('below the horizon') },
        { value: 'elevation_above', label: ut('higher than') },
        { value: 'elevation_below', label: ut('lower than') },
      ];
      const needsDeg = node.is === 'elevation_above' || node.is === 'elevation_below';
      return (
        <div className={s.fields}>
          <Labelled label={ut('The sun is')}>
            <Select value={node.is} options={options} onChange={(is) => onChange({ ...node, is })} ariaLabel={ut('The sun is')} />
          </Labelled>
          {needsDeg ? <NumberField label={ut('Elevation')} value={node.degrees ?? 10} min={-90} max={90} step={1} unit="°" onChange={(degrees) => onChange({ ...node, degrees })} /> : null}
          <ForSeconds value={node.forSec} onChange={(forSec) => onChange({ ...node, forSec })} />
        </div>
      );
    }
    case 'weather': {
      const fields: SelectOption<typeof node.field>[] = [
        { value: 'condition', label: ut('condition') },
        { value: 'temperature', label: ut('temperature') },
        { value: 'cloud_coverage', label: ut('cloud coverage') },
        { value: 'forecast_high_today', label: ut('high today') },
        { value: 'forecast_low_today', label: ut('low today') },
        { value: 'forecast_high_tomorrow', label: ut('high tomorrow') },
      ];
      const isText = node.field === 'condition';
      return (
        <div className={s.fields}>
          {pickEntity(ut('Find a weather entity…'), node.entityId, (entityId) => onChange({ ...node, entityId }))}
          <Labelled label={ut('Field')}>
            <Select
              value={node.field}
              options={fields}
              ariaLabel={ut('Field')}
              onChange={(field) => onChange({ ...node, field, cmp: field === 'condition' ? '==' : '<', value: field === 'condition' ? 'sunny' : 0 })}
            />
          </Labelled>
          <Labelled label={ut('Comparison')} narrow>
            <Select value={node.cmp} options={cmpOptions(ut, true).filter((o) => !isText || o.value === '==' || o.value === '!=')} onChange={(cmp) => onChange({ ...node, cmp })} ariaLabel={ut('Comparison')} />
          </Labelled>
          {isText ? (
            <TextField label={ut('Value')} value={String(node.value)} mono onChange={(v) => onChange({ ...node, value: v.trim() })} />
          ) : (
            <NumberField label={ut('Value')} value={typeof node.value === 'number' ? node.value : Number(node.value) || 0} min={-100} max={1000} step={0.5} onChange={(value) => onChange({ ...node, value })} />
          )}
        </div>
      );
    }
    case 'trigger':
      return (
        <div className={s.fields}>
          <Labelled label={ut('Trigger')} wide>
            <Select
              value={node.triggerId}
              options={ctx.triggers.map((t) => ({ value: t.id, label: t.name }))}
              onChange={(triggerId) => onChange({ ...node, triggerId })}
              ariaLabel={ut('Trigger')}
            />
          </Labelled>
        </div>
      );
    case 'outdoor': {
      const basis: SelectOption<NonNullable<typeof node.basis>>[] = [
        { value: 'now', label: ut('now') },
        { value: 'avg10m', label: ut('average of 10 min') },
        { value: 'avg3d', label: ut('average of 3 days') },
      ];
      return (
        <div className={s.fields}>
          <Labelled label={ut('Comparison')} narrow>
            <Select value={node.cmp} options={numCmp} onChange={(cmp) => onChange({ ...node, cmp })} ariaLabel={ut('Comparison')} />
          </Labelled>
          <NumberField label={ut('Temperature')} value={node.value} min={-40} max={45} step={0.5} unit="°" onChange={(value) => onChange({ ...node, value })} />
          <Labelled label={ut('Measured as')}>
            <Select value={node.basis ?? 'now'} options={basis} onChange={(b) => onChange({ ...node, basis: b })} ariaLabel={ut('Measured as')} />
          </Labelled>
          <OptionalNumber
            label={ut('Hysteresis: stays true until')}
            info={exitAtHint(ut)}
            value={node.exitAt}
            min={-40}
            max={45}
            step={0.5}
            unit="°"
            onChange={(exitAt) => onChange({ ...node, exitAt })}
          />
          <ForSeconds value={node.forSec} onChange={(forSec) => onChange({ ...node, forSec })} />
        </div>
      );
    }
    case 'room_deficit': {
      const served = node.roomIds === 'served';
      const chosen = new Set(Array.isArray(node.roomIds) ? node.roomIds : []);
      return (
        <div className={s.fields}>
          <div data-wide="">
            <SegmentedControl
              value={served ? 'served' : 'chosen'}
              options={[
                { value: 'served', label: ut('rooms this source serves') },
                { value: 'chosen', label: ut('chosen rooms') },
              ]}
              onChange={(v) => onChange({ ...node, roomIds: v === 'served' ? 'served' : [] })}
              ariaLabel={ut('Which rooms')}
              size="xs"
              surface="well"
            />
          </div>
          {!served ? (
            <div data-wide="" className={s.chips}>
              {ctx.rooms.map((r) => (
                <ToggleChip
                  key={r.id}
                  pressed={chosen.has(r.id)}
                  icon="home"
                  label={r.name}
                  onToggle={() => {
                    const next = new Set(chosen);
                    if (next.has(r.id)) next.delete(r.id);
                    else next.add(r.id);
                    onChange({ ...node, roomIds: [...next] });
                  }}
                />
              ))}
            </div>
          ) : null}
          <NumberField label={ut('Short by at least')} value={node.deficitC} min={0.1} max={10} step={0.1} unit="°" onChange={(deficitC) => onChange({ ...node, deficitC })} />
          <NumberField label={ut('For at least')} value={node.forMin ?? 0} min={0} max={240} step={5} unit={ut('min')} onChange={(v) => onChange({ ...node, forMin: v > 0 ? v : undefined })} />
        </div>
      );
    }
    case 'room_below_target':
      return (
        <div className={s.fields}>
          <Labelled label={ut('Room')}>
            <Select value={node.roomId} options={ctx.rooms.map((r) => ({ value: r.id, label: r.name }))} onChange={(roomId) => onChange({ ...node, roomId })} ariaLabel={ut('Room')} />
          </Labelled>
          <NumberField label={ut('Plus a margin of')} value={node.plusC} min={-5} max={5} step={0.1} unit="°" onChange={(plusC) => onChange({ ...node, plusC })} />
        </div>
      );
    case 'source': {
      const states: SelectOption<typeof node.is>[] = [
        { value: 'running', label: ut('is running') },
        { value: 'fault', label: ut('has a fault') },
        { value: 'unavailable', label: ut('is unavailable') },
        { value: 'available', label: ut('is available') },
        { value: 'lagging', label: ut('cannot keep up') },
      ];
      return (
        <div className={s.fields}>
          <Labelled label={ut('Source')}>
            <Select value={node.sourceId} options={ctx.sources.map((x) => ({ value: x.id, label: x.name }))} onChange={(sourceId) => onChange({ ...node, sourceId })} ariaLabel={ut('Source')} />
          </Labelled>
          <Labelled label={ut('State')}>
            <Select value={node.is} options={states} onChange={(is) => onChange({ ...node, is })} ariaLabel={ut('State')} />
          </Labelled>
        </div>
      );
    }
    case 'season': {
      const all: { value: Season; label: string; tone?: Tone }[] = [
        { value: 'heating', label: ut('heating season'), tone: 'heat' },
        { value: 'neutral', label: ut('between seasons') },
        { value: 'cooling', label: ut('cooling season'), tone: 'cool' },
      ];
      return (
        <div className={s.chips}>
          {all.map((x) => (
            <ToggleChip
              key={x.value}
              pressed={node.in.includes(x.value)}
              icon={x.value === 'heating' ? 'flame' : x.value === 'cooling' ? 'snow' : 'leaf'}
              accent={x.tone}
              label={x.label}
              onToggle={() => onChange({ ...node, in: node.in.includes(x.value) ? node.in.filter((v) => v !== x.value) : [...node.in, x.value] })}
            />
          ))}
        </div>
      );
    }
    case 'house_mode': {
      const all: { value: HouseMode; label: string }[] = [
        { value: 'auto', label: ut('Auto') },
        { value: 'heat', label: ut('Heating only') },
        { value: 'cool', label: ut('Cooling only') },
        { value: 'off', label: ut('Off') },
      ];
      return (
        <div className={s.chips}>
          {all.map((x) => (
            <ToggleChip
              key={x.value}
              pressed={node.in.includes(x.value)}
              icon={x.value === 'off' ? 'power' : x.value === 'heat' ? 'flame' : x.value === 'cool' ? 'snow' : 'sync'}
              label={x.label}
              onToggle={() => onChange({ ...node, in: node.in.includes(x.value) ? node.in.filter((v) => v !== x.value) : [...node.in, x.value] })}
            />
          ))}
        </div>
      );
    }
    case 'grid':
      return (
        <SegmentedControl
          value={node.is}
          options={[
            { value: 'present', label: ut('is on') },
            { value: 'absent', label: ut('is off (blackout)') },
          ]}
          onChange={(is) => onChange({ ...node, is })}
          ariaLabel={ut('Grid power')}
          size="xs"
          surface="well"
        />
      );
    case 'const':
      return (
        <SegmentedControl
          value={node.value}
          options={[
            { value: true, label: ut('always true') },
            { value: false, label: ut('never') },
          ]}
          onChange={(value) => onChange({ ...node, value })}
          ariaLabel={ut('Always')}
          size="xs"
          surface="well"
        />
      );
    case 'budget_fits':
      return <span className={s.fieldLabel}>{ut('True while the blackout energy budget has room for one more source.')}</span>;
  }
}

/* ---------------- tree ---------------- */

interface NodeProps {
  node: ConditionNode;
  onChange: (n: ConditionNode) => void;
  onRemove?: () => void;
  ev?: ConditionEval;
  search: ConditionEditorProps['search'];
  ctx: OptionCtx;
  ops: LeafNode['op'][];
  depth: number;
}

function AddMenu({ ops, onAdd, allowGroup }: { ops: LeafNode['op'][]; onAdd: (op: ConditionOp) => void; allowGroup: boolean }) {
  const ut = useUiText();
  const [op, setOp] = useState<ConditionOp>(ops[0] ?? 'const');
  const options: SelectOption<ConditionOp>[] = ops.map((o) => ({ value: o, label: opLabel(o, ut) }));
  return (
    <div className={s.addRow}>
      <Select value={op} options={options} onChange={setOp} size="sm" ariaLabel={ut('Condition type')} />
      <Button variant="secondary" size="sm" icon="plus" onClick={() => onAdd(op)}>
        {ut('Add condition')}
      </Button>
      {allowGroup ? (
        <Button variant="ghost" size="sm" icon="layers" onClick={() => onAdd('any')}>
          {ut('Add a group')}
        </Button>
      ) : null}
    </div>
  );
}

function NodeEditor({ node, onChange, onRemove, ev, search, ctx, ops, depth }: NodeProps) {
  const ut = useUiText();
  const removeButton = onRemove ? <IconButton icon="trash" label={ut('Remove the condition')} size={36} variant="ghost" onClick={onRemove} /> : null;

  if (isGroup(node)) {
    const joiner = node.op === 'all' ? ut('and') : ut('or');
    return (
      <div className={s.group} role="group" aria-label={opLabel(node.op, ut)}>
        <div className={s.groupHead}>
          <SegmentedControl
            value={node.op}
            options={[
              { value: 'all', label: ut('all of these') },
              { value: 'any', label: ut('any of these') },
            ]}
            onChange={(op) => onChange({ ...node, op })}
            ariaLabel={ut('How the conditions combine')}
            size="xs"
          />
          <span className={s.grow} />
          <EvalBadge ev={ev} />
          {removeButton}
        </div>
        {node.items.length ? (
          <div className={s.children}>
            {node.items.map((child, i) => (
              <div key={child.id ?? `n${i}`} className={s.labelled}>
                {i > 0 ? <span className={s.joiner}>{joiner}</span> : null}
                <NodeEditor
                  node={child}
                  ev={childEval(ev, i)}
                  search={search}
                  ctx={ctx}
                  ops={ops}
                  depth={depth + 1}
                  onChange={(n) => onChange({ ...node, items: node.items.map((x, j) => (j === i ? n : x)) })}
                  onRemove={() => onChange({ ...node, items: node.items.filter((_, j) => j !== i) })}
                />
              </div>
            ))}
          </div>
        ) : (
          <span className={s.warnText}>
            <Icon name="alert" size={14} />
            {ut('Add at least one condition')}
          </span>
        )}
        <AddMenu ops={ops} allowGroup={depth < 2} onAdd={(op) => onChange({ ...node, items: [...node.items, defaultNode(op, ctx)] })} />
      </div>
    );
  }

  if (node.op === 'not') {
    return (
      <div className={s.not}>
        <div className={s.nodeHead}>
          <span className={s.joiner}>{ut('not')}</span>
          <span className={s.grow} />
          <EvalBadge ev={ev} />
          <Button variant="ghost" size="sm" onClick={() => onChange(node.item)}>
            {ut('Remove the negation')}
          </Button>
          {removeButton}
        </div>
        <NodeEditor node={node.item} ev={childEval(ev, 0)} search={search} ctx={ctx} ops={ops} depth={depth + 1} onChange={(item) => onChange({ ...node, item })} />
      </div>
    );
  }

  const options: SelectOption<ConditionOp>[] = (ops.includes(node.op) ? ops : [node.op, ...ops]).map((o) => ({ value: o, label: opLabel(o, ut) }));
  const missing = incomplete(node);
  return (
    <div className={s.node} data-incomplete={missing ? '' : undefined}>
      <div className={s.nodeHead}>
        <Select value={node.op as ConditionOp} options={options} onChange={(op) => onChange(defaultNode(op, ctx, node.id))} size="sm" ariaLabel={ut('Condition type')} />
        <span className={s.grow} />
        <EvalBadge ev={ev} />
        <IconButton icon="swap" label={ut('Negate')} size={36} variant="ghost" onClick={() => onChange({ op: 'not', item: node })} />
        {removeButton}
      </div>
      <LeafFields node={node} onChange={onChange} search={search} ctx={ctx} />
      {missing ? (
        <span className={s.warnText}>
          <Icon name="alert" size={14} />
          {ut('Not complete yet — it reads as unknown.')}
        </span>
      ) : null}
    </div>
  );
}

/** Visual editor for a condition tree with the live result of every part. */
export function ConditionEditor({ value, onChange, preview, search, triggers, rooms, sources = [], allowedOps }: ConditionEditorProps) {
  const ut = useUiText();
  const ctx: OptionCtx = { triggers, rooms, sources };
  const ops = (allowedOps ?? [...LEAF_OPS]).filter((op) => (op !== 'trigger' || triggers.length > 0) && (op !== 'source' || sources.length > 0) && (op !== 'room_below_target' || rooms.length > 0));
  const [result, setResult] = useState<ConditionPreviewResult | null>(null);
  const [failed, setFailed] = useState(false);
  const previewRef = useRef(preview);
  previewRef.current = preview;
  const key = JSON.stringify(value);

  useEffect(() => {
    let alive = true;
    const t = window.setTimeout(() => {
      previewRef
        .current(value)
        .then((r) => {
          if (!alive) return;
          setResult(r);
          setFailed(false);
        })
        .catch(() => alive && setFailed(true));
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
    // the serialised tree is the dependency: a new object with the same content is no change
  }, [key]);

  // a leaf at the root gets the same «add» affordance by wrapping it into a group
  const root = isGroup(value) || value.op === 'not' ? value : null;

  return (
    <div className={s.editor}>
      <div className={s.summary} aria-live="polite">
        <span className={s.summaryLabel}>{ut('Right now')}</span>
        {failed ? (
          <span className={s.badge} style={toneVars('err')}>
            {ut('preview unavailable')}
          </span>
        ) : result ? (
          <EvalBadge ev={result.eval} />
        ) : (
          <span className={s.summaryLabel}>{ut('checking…')}</span>
        )}
        {result?.entities.length ? (
          <span className={s.summaryEntities}>
            {result.entities.map((e) => (
              <span key={e.entityId}>
                {e.entityId}: {e.available ? e.state ?? '—' : ut('unavailable')}
              </span>
            ))}
          </span>
        ) : null}
      </div>
      {root ? (
        <NodeEditor node={root} ev={result?.eval} search={search} ctx={ctx} ops={ops} depth={0} onChange={onChange} />
      ) : (
        <>
          <NodeEditor node={value} ev={result?.eval} search={search} ctx={ctx} ops={ops} depth={0} onChange={onChange} />
          <AddMenu ops={ops} allowGroup={false} onAdd={(op) => onChange({ op: 'all', items: [value, defaultNode(op, ctx)] })} />
        </>
      )}
    </div>
  );
}
