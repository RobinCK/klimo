import type { CSSProperties, ReactNode } from 'react';
import { useMediaQuery } from '@mantine/hooks';
import type { IconName, Tone } from '../../types';
import { toneVar } from '../../tokens/vars';
import { useUiText } from '../../UiTextContext';
import { ScrollX } from '../../shell/Layout';
import { Icon } from '../../basic/Icon';
import { StatusDot } from '../../basic/Badges';
import { DataTable, type DataColumn } from '../display/DataTable';
import { toneVars } from '../internal/util';
import s from './rows.module.css';

/* ---------------- EntityBindingTable ---------------- */

export type BindingStatus = 'ok' | 'info' | 'empty' | 'warn' | 'err';

export interface EntityBindingRow {
  /** «Увімкнення / режим», «Температура подачі». */
  role: string;
  /** The bound entity id, or a placeholder («оберіть сутність»). */
  value: string;
  mono: boolean;
  /** Its live value («38.2°», «heat»). */
  live?: string;
  status: BindingStatus;
  /** Badge text («на зв’язку», «оберіть»); none for info rows. */
  statusLabel?: string;
  /** Opens the entity picker for this role. */
  onPick?: () => void;
}

const BINDING_TONE: Record<BindingStatus, Tone | null> = { ok: 'ok', info: null, empty: 'warn', warn: 'warn', err: 'err' };

/** How a source is wired to Home Assistant: one role per row, empty roles stand out. */
export function EntityBindingTable({ rows, ariaLabel }: { rows: EntityBindingRow[]; ariaLabel?: string }) {
  const ut = useUiText();
  return (
    <div className={s.binding} role="list" aria-label={ariaLabel}>
      {rows.map((r, i) => {
        const tone = BINDING_TONE[r.status];
        const value = r.onPick ? (
          <button
            type="button"
            className={s.bindingValue}
            data-mono={r.mono ? '' : undefined}
            onClick={r.onPick}
            aria-label={`${r.role}: ${r.value} — ${ut('choose an entity')}`}
          >
            <span>{r.value}</span>
            <Icon name="pencil" size={14} />
          </button>
        ) : (
          <span className={s.bindingValue} data-mono={r.mono ? '' : undefined} title={r.value}>
            {r.value}
          </span>
        );
        return (
          <div key={`${r.role}-${i}`} className={s.bindingRow} data-status={r.status} role="listitem">
            <span className={s.bindingRole}>{r.role}</span>
            {value}
            {r.live ? <span className={s.bindingLive}>{r.live}</span> : null}
            {r.statusLabel ? (
              <span className={s.badge} style={tone ? toneVars(tone) : undefined} data-plain={tone ? undefined : ''}>
                {r.statusLabel}
              </span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- WatchTable ---------------- */

export interface WatchRow {
  name: string;
  role: string;
  entityId: string;
  /** «недоступний > 10 хв». */
  rule: string;
  severity: { tone: Tone; label: string };
  status: { tone: Tone; text: string };
  onClick?: () => void;
}

/** Entities under watch: rule, severity and the current state. */
export function WatchTable({ rows, ariaLabel }: { rows: WatchRow[]; ariaLabel?: string }) {
  const ut = useUiText();
  const label = ariaLabel ?? ut('Watched entities');
  // a table on wide screens; in a narrow column every row becomes a small card (rows.module.css), so
  // the scroller only scrolls while the table is shown
  return (
    <div className={s.watchWrap}>
      <div className={s.watchScroll} role="region" aria-label={label} tabIndex={0}>
        <div className={s.watch} role="table" aria-label={label}>
          <div className={`${s.watchRow} ${s.watchHead}`} role="row">
            <span role="columnheader">{ut('Entity')}</span>
            <span role="columnheader">{ut('ID')}</span>
            <span role="columnheader">{ut('Rule')}</span>
            <span role="columnheader">{ut('Severity')}</span>
            <span role="columnheader">{ut('Now')}</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.entityId}
              className={s.watchRow}
              role="row"
              data-clickable={r.onClick ? '' : undefined}
              onClick={r.onClick}
            >
              <span className={`${s.cellStack} ${s.watchName}`} role="cell">
                {r.onClick ? (
                  // the keyboard path; a pointer can click anywhere on the row
                  <button
                    type="button"
                    className={s.rowLink}
                    onClick={(e) => {
                      e.stopPropagation();
                      r.onClick?.();
                    }}
                  >
                    {r.name}
                  </button>
                ) : (
                  <span className={s.name}>{r.name}</span>
                )}
                <span className={s.muted}>{r.role}</span>
              </span>
              <span className={s.watchEntity} role="cell" title={r.entityId}>
                {r.entityId}
              </span>
              <span className={s.watchRule} role="cell">
                {r.rule}
              </span>
              <span className={s.watchSeverity} role="cell">
                <span className={s.toneChip} data-size="sm" style={toneVars(r.severity.tone)}>
                  {r.severity.label}
                </span>
              </span>
              <span className={`${s.statusText} ${s.watchNow}`} role="cell" data-tone={r.status.tone} style={toneVars(r.status.tone)}>
                <StatusDot tone={r.status.tone} size={8} />
                <span>{r.status.text}</span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- DeviceTable ---------------- */

export interface DeviceTableRow {
  key: string;
  icon: IconName;
  name: string;
  entityId: string;
  room: string;
  model: string;
  state: { tone: Tone; label: string };
  /** A battery meter (or «мережа»). */
  battery: ReactNode;
  /** A signal meter (LQI) or a transport label. */
  signal: ReactNode;
  /** «4 хв тому»; warn/err tone when stale. */
  seen: { text: string; title?: string; tone?: Tone };
  /** «Z2M #1», «інтеграція HA». */
  via: string;
  /** A device with an open problem: tinted, sorted first by the page. */
  problem?: boolean;
  onClick?: () => void;
}

export interface DeviceTableProps {
  rows: DeviceTableRow[];
  /** Below this width the table scrolls sideways (cards are used under 768 px anyway). */
  minWidth?: number;
  ariaLabel?: string;
  empty?: ReactNode;
}

function DeviceName({ r }: { r: DeviceTableRow }) {
  return (
    <span className={s.deviceCell}>
      <span className={s.deviceIcon}>
        <Icon name={r.icon} size={16} />
      </span>
      <span>
        <span className={s.name}>{r.name}</span>
        <span className={s.mono}>{r.entityId}</span>
      </span>
    </span>
  );
}

function Seen({ seen }: { seen: DeviceTableRow['seen'] }) {
  return (
    <span className={s.seen} title={seen.title} style={seen.tone ? ({ '--seen-color': toneVar(seen.tone, 'fg') } as CSSProperties) : undefined}>
      {seen.text}
    </span>
  );
}

/** All devices with their health; a table on wide screens, cards on phones and small tablets. */
export function DeviceTable({ rows, minWidth = 1080, ariaLabel, empty }: DeviceTableProps) {
  const ut = useUiText();
  const narrow = useMediaQuery('(max-width: 767px)') ?? false;
  const label = ariaLabel ?? ut('All devices');

  if (narrow) {
    return (
      <ul className={s.deviceCards} aria-label={label}>
        {rows.length === 0 && empty ? <li className={s.muted}>{empty}</li> : null}
        {rows.map((r) => {
          const body = (
            <>
              <span className={s.deviceCardHead}>
                <DeviceName r={r} />
                <span className={s.toneChip} data-size="sm" style={toneVars(r.state.tone)}>
                  {r.state.label}
                </span>
              </span>
              <span className={s.deviceFacts}>
                {r.battery}
                {r.signal}
                <Seen seen={r.seen} />
              </span>
              <span className={s.muted}>{[r.room, r.model, r.via].filter((x) => x && x !== '—').join(' · ')}</span>
            </>
          );
          return (
            <li key={r.key}>
              {r.onClick ? (
                <button type="button" className={s.deviceCard} data-tone={r.problem ? 'warn' : undefined} onClick={r.onClick}>
                  {body}
                </button>
              ) : (
                <div className={s.deviceCard} data-tone={r.problem ? 'warn' : undefined}>
                  {body}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  const columns: DataColumn[] = [
    { key: 'device', label: ut('Device'), width: 'minmax(220px, 1.6fr)' },
    { key: 'room', label: ut('Room'), width: 'minmax(100px, 0.8fr)' },
    { key: 'model', label: ut('Model'), width: 'minmax(120px, 1fr)' },
    { key: 'state', label: ut('State'), width: 'minmax(170px, 1.1fr)' },
    { key: 'battery', label: ut('Battery'), width: '96px' },
    { key: 'signal', label: ut('Signal'), width: '96px' },
    { key: 'seen', label: ut('Last seen'), width: '100px' },
    { key: 'via', label: ut('Via'), width: '116px' },
  ];
  return (
    <DataTable
      columns={columns}
      minWidth={minWidth}
      ariaLabel={label}
      empty={empty}
      rows={rows.map((r) => ({
        key: r.key,
        tone: r.problem ? 'warn' : undefined,
        onClick: r.onClick,
        ariaLabel: r.onClick ? `${r.name}, ${r.state.label}` : undefined,
        cells: {
          device: <DeviceName r={r} />,
          room: <span className={s.cellText}>{r.room}</span>,
          model: <span className={s.cellQuiet}>{r.model}</span>,
          state: (
            // a long state («Немає зв’язку 12 год 40 хв») is cut inside its column, never over the next one
            <span className={`${s.toneChip} ${s.cellChip}`} data-size="sm" style={toneVars(r.state.tone)} title={r.state.label}>
              <span className={s.cellChipText}>{r.state.label}</span>
            </span>
          ),
          battery: r.battery,
          signal: r.signal,
          seen: <Seen seen={r.seen} />,
          via: <span className={s.cellQuiet}>{r.via}</span>,
        },
      }))}
    />
  );
}
