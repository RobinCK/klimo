import type { EpochMs, ProfileDto, RoomDetailDto, RoomState } from '@api/model';
import {
  BigReadout,
  Button,
  ExplainCallout,
  Page,
  PendingChangePanel,
  RoomStateChip,
  Section,
  Split,
  Stack,
  TargetSourceLine,
  TargetStepper,
  Temperature,
  TrendIndicator,
  UndoBar,
} from '@ui';
import { paths } from '@app';
import { fmtDelta, fmtRate, fmtTemp, roomStateLabel, t, type CodeContext } from '@i18n';
import { isControllable, RoomControlBar } from './Control';
import { QuickActions } from './QuickActions';
import { RoomToday } from './RoomToday';
import { readoutCaption, sourceText, whyText, whyTitle } from './texts';
import type { EditDuration, TargetEditor } from './useTargetEditor';

function TargetBlock({ ed, state }: { ed: TargetEditor; state: RoomState }) {
  const v = ed.value;
  const editing = ed.phase === 'pending';
  if (v == null) {
    return <BigReadout caption={t('Target')} value={fmtTemp(state.target.displayC)} />;
  }
  if (typeof v === 'object') {
    // dual band: the selected bound is the one −/+ change
    const bound = ed.selected;
    return (
      <BigReadout
        caption={editing ? t('New range · not sent yet') : t('Range {lo}–{hi}', { lo: fmtTemp(v.lo), hi: fmtTemp(v.hi) })}
        value={
          <TargetStepper
            value={v[bound]}
            text={bound === 'lo' ? t('from {t}', { t: fmtTemp(v.lo) }) : t('to {t}', { t: fmtTemp(v.hi) })}
            onChange={(x) => ed.set({ ...v, [bound]: x }, bound)}
            min={bound === 'lo' ? ed.min : v.lo + ed.gap}
            max={bound === 'lo' ? v.hi - ed.gap : ed.max}
            step={ed.stepC}
            disabled={!ed.canEdit}
            editing={editing}
            label={bound === 'lo' ? t('Not colder than') : t('Not warmer than')}
            ariaDec={t('Lower by {d}', { d: fmtDelta(ed.stepC) })}
            ariaInc={t('Raise by {d}', { d: fmtDelta(ed.stepC) })}
          />
        }
      />
    );
  }
  return (
    <BigReadout
      caption={editing ? t('New target · not sent yet') : t('Target')}
      value={
        <TargetStepper
          value={v}
          text={fmtTemp(v)}
          onChange={(x) => ed.set(x)}
          min={ed.min}
          max={ed.max}
          step={ed.stepC}
          disabled={!ed.canEdit}
          editing={editing}
          label={t('Target')}
          ariaDec={t('Lower the target by {d}', { d: fmtDelta(ed.stepC) })}
          ariaInc={t('Raise the target by {d}', { d: fmtDelta(ed.stepC) })}
        />
      }
    />
  );
}

/** The left column of the hero: name, state, temperature and target, the change in progress, why. */
function HeroMain({ room, state, ed, ctx, now }: { room: RoomDetailDto; state: RoomState; ed: TargetEditor; ctx: CodeContext; now: EpochMs }) {
  const why = whyText(state, ctx);
  const trend = state.trendCPerH;
  return (
    <Page
      title={
        <>
          {room.config.name} <RoomStateChip state={state.state} label={roomStateLabel(state.state)} tone={state.tone} size={30} />
        </>
      }
      actions={
        <Button variant="secondary" size="sm" icon="pencil" to={paths.roomSettings(room.config.id, 'setup')}>
          {t('Edit room')}
        </Button>
      }
    >
      <Stack gap="lg">
        <BigReadout
          caption={readoutCaption(state)}
          value={<Temperature value={state.tempC} text={fmtTemp(state.tempC)} size="hero" />}
          aside={<TargetBlock ed={ed} state={state} />}
        />
        <Stack gap="xs">
          {isControllable(room, state) ? (
            <RoomControlBar room={room} state={state} ctx={ctx} now={now} editing={ed.phase === 'pending' ? t('New target · not sent yet') : null} />
          ) : ed.phase === 'pending' ? (
            <TargetSourceLine kind="pending" text={t('New target · not sent yet')} />
          ) : (
            <TargetSourceLine
              kind={state.target.display}
              text={sourceText(state, ctx, now)}
              tone={state.target.display === 'boost' && state.target.mode === 'cool' ? 'cool' : undefined}
            />
          )}
          {trend != null ? <TrendIndicator cPerH={trend} text={t('{rate} over the last 30 min', { rate: fmtRate(trend) })} /> : null}
        </Stack>
        {ed.phase === 'pending' && ed.consequence ? (
          <PendingChangePanel<EditDuration>
            consequence={ed.consequence}
            duration={
              ed.holds ? undefined : { value: ed.duration, options: ed.durationOptions(false), onChange: ed.setDuration, onFocusChange: ed.setDurationFocus }
            }
            durationNote={ed.holds ? t('Manual control: holds until you resume the schedule') : undefined}
            countdown={{ remaining: ed.countdown.remaining, total: ed.countdown.total, frozen: ed.countdown.frozen, text: ed.countdown.text(false) }}
            onCancel={ed.cancel}
            cancelLabel={t('Cancel')}
            editingLabel={t('New target · not sent yet')}
          />
        ) : null}
        {ed.applied ? (
          <UndoBar text={ed.applied.text} sync={ed.applied.sync} remaining={ed.applied.remaining} undoLabel={t('Undo')} onUndo={ed.applied.undo} />
        ) : null}
        <ExplainCallout title={whyTitle(state)} text={why.text || t('Nothing to explain right now.')} eta={why.eta} />
        {ed.phase === 'view' ? <QuickActions room={room} state={state} /> : null}
      </Stack>
    </Page>
  );
}

/** Desktop hero: the room's state on the left, today's chart on the right (below it when narrow). */
export function Hero({
  room,
  state,
  ed,
  ctx,
  now,
  profiles,
}: {
  room: RoomDetailDto;
  state: RoomState;
  ed: TargetEditor;
  ctx: CodeContext;
  now: EpochMs;
  profiles: readonly ProfileDto[] | undefined;
}) {
  return (
    <Section ariaLabel={t('{room} now', { room: room.config.name })}>
      <Split
        asideFirst
        asideBasis={480}
        mainBasis={520}
        aside={<HeroMain room={room} state={state} ed={ed} ctx={ctx} now={now} />}
        main={<RoomToday room={room} state={state} profiles={profiles} now={now} />}
      />
    </Section>
  );
}
