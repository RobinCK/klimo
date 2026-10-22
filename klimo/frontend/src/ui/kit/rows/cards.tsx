import type { ReactNode } from 'react';
import type { IconName, Tone } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { IconButton } from '../../basic/IconButton';
import { CodeBlock } from '../display/text';
import { SegmentedControl, type ChoiceValue, type SegmentedControlProps } from '../inputs/choice';
import { Stepper, type StepperProps } from '../inputs/steppers';
import { TestButton, type TestButtonProps } from '../inputs/actions';
import { toneVars } from '../internal/util';
import s from './rows.module.css';

/** «увімкнено» checkbox of a card; a locked one shows why. */
function EnableToggle({ checked, onToggle, locked }: { checked: boolean; onToggle: () => void; locked?: string }) {
  const ut = useUiText();
  return (
    <label className={s.enable} data-locked={locked ? '' : undefined} title={locked}>
      <input type="checkbox" checked={checked} disabled={Boolean(locked)} onChange={onToggle} />
      {locked ? <Icon name="lock" size={14} /> : null}
      {ut('enabled')}
    </label>
  );
}

function ToneChip({ tone, label, size }: { tone: Tone; label: string; size?: 'sm' }) {
  return (
    <span className={s.toneChip} style={toneVars(tone)} data-size={size}>
      {label}
    </span>
  );
}

/* ---------------- TriggerCard ---------------- */

export interface TriggerCardProps {
  icon: IconName;
  name: string;
  /** «стан сутності», «шаблон HA», «час». */
  kindLabel: string;
  /** Live state: «так · мережі немає», «ні · 4.2°». */
  live: { text: string; active: boolean; disabled: boolean; unavailable?: boolean };
  /** The definition in one or two lines (mono). */
  code: string;
  /** Who relies on it («ланцюжок опалення», «Передгрів електрикою»). */
  usages: string[];
  /** «використовують:». */
  usedByLabel: string;
  enabled: boolean;
  /** Built-in trigger: cannot be switched off (the reason). */
  locked?: string;
  onToggle: () => void;
  onEdit?: () => void;
}

/** A Home Assistant condition with its live state and its users. */
export function TriggerCard({ icon, name, kindLabel, live, code, usages, usedByLabel, enabled, locked, onToggle, onEdit }: TriggerCardProps) {
  const ut = useUiText();
  const liveState = live.disabled ? 'disabled' : live.unavailable ? 'unavailable' : live.active ? 'active' : 'idle';
  return (
    <div className={s.wellCard} data-bordered="" data-active={live.active && !live.disabled ? '' : undefined}>
      <div className={s.cardHead}>
        <span className={s.cardWho}>
          <span className={s.iconBox}>
            <Icon name={icon} size={18} />
          </span>
          <span>
            <span className={s.name}>{name}</span>
            <span className={s.muted}>{kindLabel}</span>
          </span>
        </span>
        <span className={s.cardRight}>
          <span className={s.live} data-state={liveState} role="status">
            {live.unavailable ? <Icon name="offline" size={14} /> : null}
            {live.text}
          </span>
          {onEdit ? <IconButton icon="pencil" label={ut('Edit «{name}»', { name })} size={36} variant="ghost" onClick={onEdit} /> : null}
        </span>
      </div>
      <CodeBlock code={code} wrap />
      <div className={s.cardFoot}>
        <span className={s.usages}>
          <span className={s.muted}>{usedByLabel}</span>
          {usages.map((u, i) => (
            <span key={`${u}-${i}`} className={s.softChip}>
              {u}
            </span>
          ))}
        </span>
        <EnableToggle checked={enabled} onToggle={onToggle} locked={locked} />
      </div>
    </div>
  );
}

/* ---------------- RuleCard ---------------- */

export interface RuleCardProps {
  /** «ПРИСУТНІСТЬ», «КАЛЕНДАР». */
  tag: string;
  title: string;
  text: string;
  enabled?: boolean;
  onToggle?: () => void;
}

/** A profile activation rule («Коли вмикається сам»). */
export function RuleCard({ tag, title, text, enabled, onToggle }: RuleCardProps) {
  return (
    <div className={s.ruleRow} data-off={enabled === false ? '' : undefined}>
      <span className={s.ruleTag}>{tag}</span>
      <span className={s.ruleText}>
        <span className={s.ruleTitle}>{title}</span>
        <span className={s.ruleSub}>{text}</span>
      </span>
      {onToggle && enabled != null ? <EnableToggle checked={enabled} onToggle={onToggle} /> : null}
    </div>
  );
}

/* ---------------- ActionRuleCard ---------------- */

export interface ActionRuleCardProps {
  /** Trigger name («Блекаут»). */
  when: string;
  /** «Економити». */
  action: string;
  /** What changes while active, one line each. */
  effects: string[];
  /** «Останній раз: учора 18:20–21:05». */
  last: string;
  enabled: boolean;
  /** The trigger is on right now. */
  active?: boolean;
  onToggle: () => void;
  onEdit?: () => void;
}

/** «коли «Блекаут» → Економити»: what a trigger changes while it is active. */
export function ActionRuleCard({ when, action, effects, last, enabled, active, onToggle, onEdit }: ActionRuleCardProps) {
  const ut = useUiText();
  return (
    <div className={s.wellCard} data-off={enabled ? undefined : ''} data-active={active && enabled ? '' : undefined}>
      <div className={s.whenLine}>
        <span className={s.whenPill}>{ut('when «{name}»', { name: when })}</span>
        <span className={s.whenArrow}>
          <Icon name="arrowRight" size={16} />
        </span>
        <span className={s.whenAction}>{action}</span>
        {active && enabled ? <ToneChip tone="event" label={ut('active now')} size="sm" /> : null}
        <span className={s.whenEnd}>
          {onEdit ? <IconButton icon="pencil" label={ut('Edit «{name}»', { name: action })} size={36} variant="ghost" onClick={onEdit} /> : null}
          <EnableToggle checked={enabled} onToggle={onToggle} />
        </span>
      </div>
      {effects.length ? (
        <ul className={s.effects}>
          {effects.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      ) : null}
      <span className={s.muted}>{last}</span>
    </div>
  );
}

/* ---------------- CircuitCard ---------------- */

export interface CircuitCardProps<T extends ChoiceValue> {
  name: string;
  pumpEntity: string;
  /** «Zigbee-реле · LQI 128». */
  extra?: string;
  /** Pump state («працює», «вибіг 3 хв»). */
  chip: { tone: Tone; label: string };
  /** When the pump runs; `hint` of the control is the caption above it. */
  rule: SegmentedControlProps<T>;
  /** Run-on after stop (always drawn as the compact row; a variant passed here is ignored). */
  runOn: Omit<StepperProps, 'variant'> & { variant?: StepperProps['variant'] };
  /** Feeds and rooms («від ТН і котла», «Вітальня»…); a tone tints what a feed means. */
  chips: { label: string; tone?: Tone }[];
  note?: string;
  /** Caption above the rule control («Насос вмикається, коли»). */
  ruleLabel?: string;
}

/** A heating circuit and its pump: when it runs, how long it runs on, what it serves. */
export function CircuitCard<T extends ChoiceValue>({ name, pumpEntity, extra, chip, rule, runOn, chips, note, ruleLabel }: CircuitCardProps<T>) {
  const ut = useUiText();
  return (
    <div className={s.wellCard}>
      <div className={s.cardHead}>
        <span className={s.cardWho}>
          <span>
            <span className={s.circuitTitle}>{name}</span>
            <span className={s.muted}>
              {ut('pump')} <span className={s.mono}>{pumpEntity}</span>
              {extra ? ` · ${extra}` : ''}
            </span>
          </span>
        </span>
        <ToneChip tone={chip.tone} label={chip.label} />
      </div>
      <div className={s.circuitBlock}>
        {ruleLabel ? <span className={s.circuitBlockLabel}>{ruleLabel}</span> : null}
        <SegmentedControl {...rule} size={rule.size ?? 'xs'} surface="well" />
      </div>
      <Stepper {...runOn} variant="compact" />
      {chips.length ? (
        <div className={s.chipRow}>
          {chips.map((c, i) => (
            <span key={`${c.label}-${i}`} className={s.softChip} style={c.tone ? toneVars(c.tone, 'chip') : undefined}>
              {c.label}
            </span>
          ))}
        </div>
      ) : null}
      {note ? <span className={s.muted}>{note}</span> : null}
    </div>
  );
}

/* ---------------- ChannelCard ---------------- */

export interface ChannelCardProps {
  icon: IconName;
  title: string;
  sub: string;
  status: { tone: Tone; label: string };
  children?: ReactNode;
  test?: TestButtonProps;
}

/** A notification channel: status, its settings (children) and a test button. */
export function ChannelCard({ icon, title, sub, status, children, test }: ChannelCardProps) {
  return (
    <div className={s.channel}>
      <div className={s.channelHead}>
        <span className={s.channelIcon}>
          <Icon name={icon} size={18} />
        </span>
        <span className={s.channelText}>
          <span className={s.name}>{title}</span>
          <span className={s.muted}>{sub}</span>
        </span>
        <ToneChip tone={status.tone} label={status.label} size="sm" />
      </div>
      {children}
      {test ? (
        <span className={s.channelTest}>
          <TestButton {...test} />
        </span>
      ) : null}
    </div>
  );
}
