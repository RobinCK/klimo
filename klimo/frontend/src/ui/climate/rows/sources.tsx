import type { CSSProperties } from 'react';
import type { ConditionEval } from '@api/model';
import type { IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { useUiNav } from '../../UiNavContext';
import { useRouteClick } from '../../shell/Link';
import { Icon } from '../../basic/Icon';
import { cx } from '../../viz/internal/util';
import s from './rows.module.css';

function chipStyle(tone: Tone): CSSProperties {
  return { '--chip-bg': toneVar(tone, 'bg'), '--chip-fg': toneVar(tone, 'fg') } as CSSProperties;
}

/* ---------------------------------- SourceListItem ---------------------------------- */

export interface SourceListItemProps {
  icon: IconName;
  name: string;
  /** «тепловий насос · основне». */
  sub: string;
  chip: { tone: Tone; label: string };
  selected: boolean;
  onClick: () => void;
}

/** A source in the sources list (left column); the icon tile takes the state's tone. */
export function SourceListItem({ icon, name, sub, chip, selected, onClick }: SourceListItemProps) {
  return (
    <button type="button" className={s.pick} aria-pressed={selected} onClick={onClick} style={chipStyle(chip.tone)}>
      <span className={s.pickIcon}>
        <Icon name={icon} size={20} />
      </span>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{name}</span>
        <span className={s.rowSub}>{sub}</span>
      </span>
      <span className={s.pill} data-size="26">
        {chip.label}
      </span>
    </button>
  );
}

/* ---------------------------------- TypePickerCard ---------------------------------- */

export interface TypePickerCardProps {
  icon: IconName;
  name: string;
  /** «гріє й охолоджує». */
  can: string;
  /** «climate або інтеграція». */
  how: string;
  selected: boolean;
  onClick: () => void;
}

/** A source template to start from. */
export function TypePickerCard({ icon, name, can, how, selected, onClick }: TypePickerCardProps) {
  return (
    <button type="button" className={s.typeCard} aria-pressed={selected} onClick={onClick}>
      <span className={s.typeIcon}>
        <Icon name={icon} size={20} />
      </span>
      <span className={s.rowTitle}>{name}</span>
      <span className={s.typeCan}>{can}</span>
      <span className={s.rowSub}>{how}</span>
    </button>
  );
}

/* ---------------------------------- ChainRow ---------------------------------- */

export interface ChainRowProps {
  rank: number;
  name: string;
  /** When this source heats («основне, поки надворі не нижче −10°»). */
  when: string;
  chip: { tone: Tone; label: string };
  /** Show the drag grip (the row sits in a reorderable list). */
  grip?: boolean;
}

/** One step of the heating or cooling chain. */
export function ChainRow({ rank, name, when, chip, grip }: ChainRowProps) {
  return (
    <div className={s.chain} style={chipStyle(chip.tone)}>
      <span className={s.rank}>{rank}</span>
      <span className={s.rowText}>
        <span className={s.rowTitle}>{name}</span>
        <span className={s.rowSubLg}>{when}</span>
      </span>
      <span className={s.pill} data-size="26">
        {chip.label}
      </span>
      {grip ? (
        <span className={s.grip} aria-hidden="true">
          <Icon name="grip" size={18} />
        </span>
      ) : null}
    </div>
  );
}

/* ---------------------------------- FeedRow ---------------------------------- */

export interface FeedRowProps {
  /** «Опалення →». */
  label: string;
  tone: Tone;
  chips: readonly { label: string; to?: string }[];
  /** Shown when there are no chips («не гріє»). */
  empty: string;
}

function FeedChip({ label, to }: { label: string; to?: string }) {
  const nav = useUiNav();
  const onClick = useRouteClick(to);
  return to ? (
    <a className={cx(s.feedChip, s.feedLink)} href={nav.href(to)} onClick={onClick}>
      {label}
    </a>
  ) : (
    <span className={s.feedChip}>{label}</span>
  );
}

/** Where a source delivers in one mode (circuits, rooms). */
export function FeedRow({ label, tone, chips, empty }: FeedRowProps) {
  return (
    <div className={s.feed} style={{ '--feed-fg': toneVar(tone, 'fg') } as CSSProperties}>
      <span className={s.feedLabel}>{label}</span>
      {chips.map((c, i) => (
        <FeedChip key={`${c.label}-${i}`} label={c.label} to={c.to} />
      ))}
      {chips.length === 0 ? <span className={s.rowSub}>{empty}</span> : null}
    </div>
  );
}

/* ---------------------------------- GuardList ---------------------------------- */

export interface GuardListProps {
  items: readonly { icon: IconName; title: string; text: string; warn?: boolean }[];
}

/** The safety rules that always apply (frost, failover, overheat, relay watchdog …). */
export function GuardList({ items }: GuardListProps) {
  return (
    <ul className={s.guards}>
      {items.map((g, i) => (
        <li key={`${g.title}-${i}`} className={s.guard} data-warn={g.warn ? '' : undefined}>
          <span className={s.guardIcon}>
            <Icon name={g.icon} size={16} />
          </span>
          <span className={s.rowText}>
            <span className={s.guardTitle}>{g.title}</span>
            <span className={s.rowSubLg}>{g.text}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/* ---------------------------------- ConditionRow ---------------------------------- */

export interface ConditionRowProps {
  /** null: unknown right now (an input is unavailable). */
  met: boolean | null;
  text: string;
  sub?: string;
  /** «виконується», «ні», «невідомо». */
  badge: string;
}

/** One condition with its live result. */
export function ConditionRow({ met, text, sub, badge }: ConditionRowProps) {
  const state = met == null ? 'unknown' : met ? 'met' : 'not';
  return (
    <div className={s.cond} data-state={state}>
      <span className={s.condDot} aria-hidden="true" />
      <span className={s.rowText}>
        <span className={s.condText}>{text}</span>
        {sub ? <span className={s.rowSubLg}>{sub}</span> : null}
      </span>
      <span className={s.condBadge}>{badge}</span>
    </div>
  );
}

/* ---------------------------------- ConditionTreeView ---------------------------------- */

export interface ConditionTreeViewProps {
  eval: ConditionEval;
  /** Words for a node of the tree (by its id): «Надворі нижче −10°», «Усі з:». */
  render: (id: string) => string;
}

function TreeNode({ node, render, depth }: { node: ConditionEval; render: (id: string) => string; depth: number }) {
  const ut = useUiText();
  const state = node.status === 'error' ? 'error' : node.status === 'unknown' ? 'unknown' : node.met ? 'met' : 'not';
  const badge =
    state === 'error'
      ? ut('error')
      : state === 'unknown'
        ? ut('unknown')
        : node.pendingSec != null && node.pendingSec > 0
          ? ut('in {sec} s', { sec: Math.ceil(node.pendingSec) })
          : node.met
            ? ut('met')
            : ut('not met');
  return (
    <li className={s.treeItem} data-depth={depth}>
      <span className={s.treeRow} data-state={state}>
        <span className={s.condDot} aria-hidden="true" />
        <span className={s.treeText}>{render(node.id)}</span>
        {node.value != null && node.value !== '' ? <span className={s.treeValue}>{String(node.value)}</span> : null}
        <span className={s.condBadge}>{badge}</span>
      </span>
      {node.error ? <span className={s.treeError}>{node.error}</span> : null}
      {node.children?.length ? (
        <ul className={s.treeChildren}>
          {node.children.map((c) => (
            <TreeNode key={c.id} node={c} render={render} depth={depth + 1} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A condition tree with each node's live result (trigger editor preview, source conditions). */
export function ConditionTreeView({ eval: root, render }: ConditionTreeViewProps) {
  return (
    // nested lists, not an ARIA tree: the view is read-only, so list levels are all a reader needs
    <ul className={s.tree}>
      <TreeNode node={root} render={render} depth={0} />
    </ul>
  );
}
