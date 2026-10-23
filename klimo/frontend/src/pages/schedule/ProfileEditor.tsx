/**
 * One profile: name, colour and icon, the default heat and cool targets, what every room does
 * in it (inherit / own targets / off) and the rules that switch it on by itself. Every field
 * saves on its own; deleting asks which profile takes over its places in schedules and rules.
 */
import { useState } from 'react';
import type { ActivationRule, Id, ProfileDto, ProfilePatch, RoomProfileMode, RoomSummary, Schedule } from '@api/model';
import { api } from '@api/endpoints';
import { useAutosave, useLayout, useMutation } from '@data';
import {
  Button,
  CheckboxRow,
  ColorSwatchPicker,
  ConfirmDialog,
  DataTable,
  IconButton,
  IconPicker,
  KeyValueList,
  ProfileIconTile,
  Row,
  RuleCard,
  Section,
  SegmentedControl,
  Select,
  Stack,
  Stepper,
  StatusBanner,
  TextField,
  AutoGrid,
  ValuePill,
  type DataRow,
} from '@ui';
import { fmtTemp, profileKindLabel, t } from '@i18n';
import type { ScheduleContext } from './data';
import { PROFILE_ICONS, PROFILE_PALETTE } from './palette';
import { RuleDialog } from './RuleDialog';
import { roomScheduleNote, ruleCopy, ruleTag, scheduleSummary } from './texts';

interface Props {
  c: ScheduleContext;
  profile: ProfileDto;
  schedules: readonly Schedule[];
  /** Another profile was created or this one removed: select that one. */
  onSelect: (id: Id) => void;
}

export function ProfileEditor({ c, profile, schedules, onSelect }: Props) {
  const { put } = c.profiles;
  const limits = c.settings.data?.general.targetLimits ?? { heatMinC: 5, heatMaxC: 30, coolMinC: 16, coolMaxC: 32, stepC: 0.5 };
  const gap = c.minGapC;
  const patch = (p: ProfilePatch) => api.profiles.patch(profile.id, p).then(put);
  const name = useAutosave(profile.name, (v) => (v.trim() ? patch({ name: v.trim() }) : Promise.resolve()), { debounceMs: 600 });
  const heat = useAutosave(profile.heatC, (v) => patch({ heatC: v }));
  const cool = useAutosave(profile.coolC, (v) => patch({ coolC: v }));
  const look = useMutation((p: ProfilePatch) => patch(p), { onError: () => void c.profiles.reload() });
  const frostOnly = useAutosave(profile.frostOnly, (v) => patch({ frostOnly: v }));
  const duplicate = useMutation(() => api.profiles.duplicate(profile.id), {
    onSuccess: (p) => {
      put(p);
      onSelect(p.id);
    },
    okToast: (p) => t('Created «{name}»', { name: p.name }),
  });
  const [deleting, setDeleting] = useState(false);
  const fallbackId = c.settings.data?.general.defaultProfileId ?? 'home';
  const [replaceWith, setReplaceWith] = useState<Id>(
    profile.id === fallbackId ? (c.profiles.data?.find((p) => p.id !== profile.id)?.id ?? fallbackId) : fallbackId,
  );
  const remove = useMutation(() => api.profiles.remove(profile.id, { replaceWith }), {
    onSuccess: () => {
      setDeleting(false);
      c.profiles.setData((prev) => (prev ?? []).filter((p) => p.id !== profile.id));
      onSelect(replaceWith);
    },
    okToast: t('Profile deleted'),
  });

  const editable = c.canEdit;
  const kind = profileKindLabel(profile.kind);
  const others = (c.profiles.data ?? []).filter((p) => p.id !== profile.id);
  const usages = profile.usages.map((u) => u.label).filter(Boolean);

  return (
    <Section ariaLabel={t('Profile «{name}»', { name: profile.name })}>
      <Stack gap="xl">
        <Row gap="md" align="end" wrap>
          <ProfileIconTile icon={profile.icon} color={profile.color} ink={profile.ink} name={profile.name} size={48} />
          <Stack grow align="stretch">
            <TextField
              label={t('Profile name · {kind}', { kind })}
              value={name.value}
              onChange={(v) => name.set(v)}
              size="lg"
              maxLength={24}
              disabled={!editable}
              error={name.value.trim() ? undefined : t('Give the profile a name')}
            />
          </Stack>
          <Row gap="sm">
            <Button variant="secondary" onClick={() => void duplicate.run()} loading={duplicate.pending} disabled={!editable}>
              {t('Duplicate')}
            </Button>
            <Button variant="danger" onClick={() => setDeleting(true)} disabled={!editable || profile.kind === 'system'}>
              {t('Delete')}
            </Button>
          </Row>
        </Row>

        <Row gap="2xl" wrap align="start">
          <Section variant="plain" level={3} subtitle={t('Colour')}>
            <ColorSwatchPicker
              ariaLabel={t('Colour')}
              value={profile.color}
              palette={PROFILE_PALETTE.map((p, i) => ({ ...p, label: t('Colour {n}', { n: i + 1 }) }))}
              onChange={(color, ink) => {
                if (!editable) return;
                put({ ...profile, color, ink });
                void look.run({ color, ink });
              }}
            />
          </Section>
          <Section variant="plain" level={3} subtitle={t('Icon')}>
            <IconPicker
              ariaLabel={t('Icon')}
              value={profile.icon}
              icons={PROFILE_ICONS()}
              onChange={(icon) => {
                if (!editable) return;
                put({ ...profile, icon });
                void look.run({ icon });
              }}
            />
          </Section>
        </Row>

        <AutoGrid min={260} gap="md">
          <Stepper
            variant="big"
            label={t('Heating · default target')}
            labelTone="heat"
            value={heat.value}
            text={fmtTemp(heat.value)}
            min={limits.heatMinC}
            max={Math.min(limits.heatMaxC, cool.value - gap)}
            step={limits.stepC}
            disabled={!editable}
            onChange={(v) => heat.set(v)}
            ariaDec={t('Lower the heating target')}
            ariaInc={t('Raise the heating target')}
          />
          <Stepper
            variant="big"
            label={t('Cooling · default target')}
            labelTone="cool"
            value={cool.value}
            text={fmtTemp(cool.value)}
            min={Math.max(limits.coolMinC, heat.value + gap)}
            max={limits.coolMaxC}
            step={limits.stepC}
            disabled={!editable}
            onChange={(v) => cool.set(v)}
            ariaDec={t('Lower the cooling target')}
            ariaInc={t('Raise the cooling target')}
          />
        </AutoGrid>

        <CheckboxRow
          variant="well"
          checked={frostOnly.value}
          disabled={!editable}
          title={t('Frost protection only')}
          hint={t('Rooms do not heat or cool in this profile; below {t} the house is still kept warm.', { t: fmtTemp(c.settings.data?.safety.frostC ?? 7) })}
          onChange={(v) => frostOnly.set(v)}
        />

        <RoomsTable c={c} profile={profile} editable={editable} />

        <ActivationRules c={c} profile={profile} schedules={schedules} editable={editable} />
      </Stack>

      <ConfirmDialog
        open={deleting}
        title={t('Delete «{name}»?', { name: profile.name })}
        body={
          <Stack gap="md">
            <Select
              label={t('Replace it with')}
              ariaLabel={t('Replace it with')}
              value={replaceWith}
              options={others.map((p) => ({ value: p.id, label: p.name }))}
              onChange={setReplaceWith}
            />
            {profile.live ? (
              <StatusBanner tone="warn" icon="alert" text={t('The house is in this profile right now — it switches to the replacement at once.')} />
            ) : null}
          </Stack>
        }
        consequences={
          usages.length
            ? [
                t('Schedule blocks, rules and rooms that use it switch to «{name}»: {list}', {
                  name: others.find((p) => p.id === replaceWith)?.name ?? '',
                  list: usages.join(', '),
                }),
              ]
            : [t('Nothing uses this profile.')]
        }
        confirm={{ label: t('Delete profile'), tone: 'danger', onClick: () => void remove.run(), loading: remove.pending }}
        onCancel={() => setDeleting(false)}
      />
    </Section>
  );
}

/* ---------------- rooms in the profile ---------------- */

function RoomsTable({ c, profile, editable }: { c: ScheduleContext; profile: ProfileDto; editable: boolean }) {
  const { put } = c.profiles;
  const limits = c.settings.data?.general.targetLimits ?? { heatMinC: 5, heatMaxC: 30, coolMinC: 16, coolMaxC: 32, stepC: 0.5 };
  const frost = c.settings.data?.safety.frostC ?? 7;
  const phone = useLayout() === 'phone';
  const save = useMutation(
    (roomId: Id, mode: RoomProfileMode, heatC: number | null, coolC: number | null) => api.profiles.setRoom(profile.id, roomId, { mode, heatC, coolC }),
    { onSuccess: put, onError: () => void c.profiles.reload() },
  );

  const setRoom = (room: RoomSummary, mode: RoomProfileMode, heatC: number | null, coolC: number | null) => {
    // show it at once; the server's copy replaces it when it answers
    const rest = profile.roomTargets.filter((r) => r.roomId !== room.id);
    const roomTargets = mode === 'inherit' ? rest : [...rest, { profileId: profile.id, roomId: room.id, mode, heatC, coolC, writtenAt: null }];
    put({ ...profile, roomTargets, ownCount: roomTargets.length });
    void save.run(room.id, mode, heatC, coolC);
  };

  const items = c.rooms.map((room) => {
    const rt = profile.roomTargets.find((r) => r.roomId === room.id);
    const mode: RoomProfileMode = rt?.mode ?? 'inherit';
    const heatC = rt?.heatC ?? null;
    const coolC = rt?.coolC ?? null;
    const heatCell =
      mode === 'off' ? (
        t('— · frost {t}', { t: fmtTemp(frost, { decimals: 0 }) })
      ) : mode === 'own' && editable ? (
        <ValueStep
          value={heatC ?? profile.heatC}
          min={limits.heatMinC}
          max={limits.heatMaxC}
          step={limits.stepC}
          label={t('Heating in {room}', { room: room.name })}
          onChange={(v) => setRoom(room, 'own', v, coolC)}
        />
      ) : (
        fmtTemp(mode === 'own' ? (heatC ?? profile.heatC) : profile.heatC)
      );
    const coolCell = !room.canCool ? (
      t('none')
    ) : mode === 'off' ? (
      '—'
    ) : mode === 'own' && editable ? (
      <ValueStep
        value={coolC ?? profile.coolC}
        min={limits.coolMinC}
        max={limits.coolMaxC}
        step={limits.stepC}
        label={t('Cooling in {room}', { room: room.name })}
        onChange={(v) => setRoom(room, 'own', heatC, v)}
      />
    ) : (
      fmtTemp(mode === 'own' ? (coolC ?? profile.coolC) : profile.coolC)
    );
    const modeControl = (full: boolean) => (
      <SegmentedControl<RoomProfileMode>
        size="xs"
        surface="well"
        full={full}
        ariaLabel={t('Mode of {room}', { room: room.name })}
        value={mode}
        options={[
          { value: 'inherit', label: t('from profile'), disabled: !editable },
          { value: 'own', label: t('own'), disabled: !editable },
          { value: 'off', label: t('off'), disabled: !editable },
        ]}
        onChange={(m) => setRoom(room, m, m === 'own' ? heatC : null, m === 'own' ? coolC : null)}
      />
    );
    return { key: room.id, name: room.name, modeControl, heat: heatCell, cool: coolCell };
  });

  const own = profile.roomTargets.length;
  const rows: DataRow[] = items.map((it) => ({ key: it.key, cells: { room: it.name, mode: it.modeControl(false), heat: it.heat, cool: it.cool } }));
  return (
    <Section
      variant="plain"
      level={3}
      title={t('Rooms in this profile')}
      tag={own ? t('{count} with their own setting', { count: own }) : t('all take the profile target')}
    >
      {phone ? (
        // a phone has no room for four columns: one block per room, the mode across its width
        <Stack gap="sm">
          {items.map((it) => (
            <Section key={it.key} variant="well" level={3} title={it.name}>
              <Stack gap="sm">
                {it.modeControl(true)}
                <KeyValueList
                  rows={[
                    { key: t('Heat'), value: it.heat },
                    { key: t('Cool'), value: it.cool },
                  ]}
                />
              </Stack>
            </Section>
          ))}
        </Stack>
      ) : (
        <DataTable
          minWidth={540}
          ariaLabel={t('Rooms in this profile')}
          columns={[
            { key: 'room', label: t('Room'), width: 'minmax(7rem, 1fr)' },
            { key: 'mode', label: t('Mode'), width: 'minmax(14.5rem, 1.7fr)' },
            { key: 'heat', label: t('Heat'), width: '6.5rem' },
            { key: 'cool', label: t('Cool'), width: '6.5rem' },
          ]}
          rows={rows}
        />
      )}
    </Section>
  );
}

/** A room's own target in the table: tap to change it with a small stepper. */
function ValueStep({
  value,
  min,
  max,
  step,
  label,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  label: string;
  onChange: (v: number) => void;
}) {
  // presses of the stepper are gathered and saved once
  const v = useAutosave(value, async (x: number) => onChange(x));
  return <ValuePill text={fmtTemp(v.value)} ariaLabel={label} editor={{ kind: 'number', min, max, step, format: (x) => fmtTemp(x) }} value={v.value} onChange={(x: number) => v.set(x)} />;
}

/* ---------------- activation rules ---------------- */

function ActivationRules({ c, profile, schedules, editable }: { c: ScheduleContext; profile: ProfileDto; schedules: readonly Schedule[]; editable: boolean }) {
  const { put } = c.profiles;
  const [dialog, setDialog] = useState<{ rule: ActivationRule | null } | null>(null);
  const toggle = useMutation((rule: ActivationRule, enabled: boolean) => api.activationRules.patch(rule.id, { enabled }), {
    onSuccess: put,
    onError: () => void c.profiles.reload(),
  });
  const house = schedules.find((s) => s.scope === 'house') ?? null;
  const summary = scheduleSummary(profile.id, house);
  const roomNote = roomScheduleNote(profile.id, schedules, c.rooms);
  const isEco = c.settings.data?.general.ecoProfileId === profile.id;
  const profiles = c.profiles.data ?? [];

  return (
    <Section
      variant="plain"
      level={3}
      title={t('When it switches on by itself')}
      action={
        editable ? (
          <Button variant="secondary" size="sm" icon="plus" onClick={() => setDialog({ rule: null })}>
            {t('Add a condition')}
          </Button>
        ) : undefined
      }
    >
      <Stack gap="sm">
        {summary ? (
          <RuleCard
            tag={t('Schedule')}
            title={summary.title}
            text={[summary.text, roomNote].filter(Boolean).join(' ') || t('From the weekly schedule below.')}
          />
        ) : null}
        {!summary && roomNote ? <RuleCard tag={t('Schedule')} title={t('Room schedules')} text={roomNote} /> : null}
        {isEco ? (
          <RuleCard
            tag={t('Window')}
            title={t('Reaction to an open window')}
            text={t('Rooms whose window reaction is «Switch to {profile}».', { profile: profile.name })}
          />
        ) : null}
        {profile.rules.map((rule) => {
          const copy = ruleCopy(rule, profiles, c.settings.data ?? null);
          return (
            <Row key={rule.id} gap="sm" align="center">
              <Stack grow align="stretch">
                <RuleCard
                  tag={ruleTag(rule)}
                  title={copy.title}
                  text={copy.text}
                  enabled={rule.enabled}
                  onToggle={editable ? () => void toggle.run(rule, !rule.enabled) : undefined}
                />
              </Stack>
              {editable ? <IconButton icon="pencil" label={t('Edit the condition')} variant="ghost" onClick={() => setDialog({ rule })} /> : null}
            </Row>
          );
        })}
        {!summary && !roomNote && !isEco && !profile.rules.length ? (
          <StatusBanner tone="event" icon="info" text={t('Nothing switches this profile on by itself — only a manual change or the schedule.')} />
        ) : null}
      </Stack>
      {dialog ? <RuleDialog c={c} profile={profile} rule={dialog.rule} onClose={() => setDialog(null)} /> : null}
    </Section>
  );
}
