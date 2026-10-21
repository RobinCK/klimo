import type { ReactNode } from 'react';
import type { RoomStateKind, TargetDisplayKind } from '@api/model';
import { ROOM_STATES } from '@api/model';
import {
  AutoGrid,
  BASE_TONES,
  Button,
  CountBadge,
  ICON_NAMES,
  Icon,
  IconButton,
  IconTile,
  IssueChip,
  KitGallerySection,
  MetaRow,
  MiniTag,
  Page,
  Row,
  SchemeScope,
  Stack,
  StatusChip,
  StatusDot,
  TargetSourceLine,
  Temperature,
  ToneBadge,
  TrendIndicator,
  VizGallerySection,
  RoomStateChip,
  type ButtonVariant,
} from '@ui';
import { LogoMark, Wordmark } from '@brand';
import { fmtRate, fmtTemp, roomStateLabel, t, targetDisplayLabel } from '@i18n';

const SOURCE_KINDS: (TargetDisplayKind | 'pending')[] = [
  'schedule', 'profile_updated', 'manual', 'range', 'boost', 'window', 'airing', 'off', 'monitor', 'frost', 'presence',
  'calendar', 'room_profile', 'preheat', 'no_data', 'pending',
];
const VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'outline', 'ghost', 'danger', 'link'];

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm" as="section" ariaLabel={title}>
      <h2>{title}</h2>
      {children}
    </Stack>
  );
}

/** The shell and basic components in every state, rendered once per scheme. */
function Basics() {
  return (
    <Stack gap="2xl">
      <Block title={t('Logo')}>
        <Row gap="lg" wrap align="end">
          {([24, 28, 32, 48, 96, 128] as const).map((size) => (
            <LogoMark key={size} size={size} />
          ))}
          <Wordmark size={19} />
          <Wordmark size={54} withMark background="page" />
        </Row>
      </Block>

      <Block title={t('Room states')}>
        <Row gap="sm" wrap>
          {ROOM_STATES.map((s: RoomStateKind) => (
            <RoomStateChip key={s} state={s} label={roomStateLabel(s)} />
          ))}
        </Row>
        <Row gap="sm" wrap>
          {ROOM_STATES.map((s: RoomStateKind) => (
            <RoomStateChip key={s} state={s} label={roomStateLabel(s)} size={30} />
          ))}
        </Row>
      </Block>

      <Block title={t('Tones')}>
        <Row gap="sm" wrap>
          {BASE_TONES.map((tone) => (
            <StatusChip key={tone} tone={tone} label={tone} size={24} />
          ))}
        </Row>
        <Row gap="sm" wrap>
          {BASE_TONES.map((tone) => (
            <ToneBadge key={tone} tone={tone}>
              {tone}
            </ToneBadge>
          ))}
        </Row>
        <Row gap="md" wrap>
          <CountBadge count={3} tone="warn" />
          <CountBadge count={12} tone="err" />
          <CountBadge count={4} tone="neutral" />
          <CountBadge count={3} tone="warn" variant="solid" />
          <CountBadge count={120} tone="err" variant="solid" />
          <MiniTag>{t('now')}</MiniTag>
          <MiniTag tone="ok">ok</MiniTag>
          <MiniTag tone="heat">heat</MiniTag>
          <MiniTag tone="cool">cool</MiniTag>
          {BASE_TONES.map((tone) => (
            <StatusDot key={tone} tone={tone} size={10} />
          ))}
          <StatusDot tone="ok" size={12} glow />
          <StatusDot tone="warn" size={12} ring />
        </Row>
        <Row gap="sm" wrap>
          <IssueChip tone="warn" icon="sync" text={t('A radiator valve did not confirm · retry {attempt}/{of}', { attempt: 2, of: 3 })} />
          <IssueChip tone="err" icon="offline" text={t('{off} of {total} sensors offline', { off: 1, total: 3 })} />
        </Row>
        <Row gap="sm" wrap>
          {BASE_TONES.map((tone) => (
            <IconTile key={tone} icon="flame" tone={tone} size={36} />
          ))}
          <IconTile icon="home" color={{ bg: 'var(--ui-profile-1)', fg: 'var(--ui-profile-1-ink)' }} size={40} />
          <IconTile icon="moon" color={{ bg: 'var(--ui-profile-4)', fg: 'var(--ui-profile-4-ink)' }} size={48} />
        </Row>
      </Block>

      <Block title={t('Temperatures')}>
        <Row gap="xl" wrap align="end">
          <Temperature value={19.8} text={fmtTemp(19.8)} size="sm" />
          <Temperature value={19.8} text={fmtTemp(19.8)} size="md" />
          <Temperature value={19.8} text={fmtTemp(19.8)} size="lg" />
          <Temperature value={-2.5} text={fmtTemp(-2.5)} size="xl" />
          <Temperature value={21.5} text={fmtTemp(21.5)} size="hero" />
          <Temperature value={20.5} text={fmtTemp(20.5)} size="dial" />
          <Temperature value={null} text="" size="lg" />
        </Row>
        <Row gap="lg" wrap>
          <TrendIndicator cPerH={0.4} text={fmtRate(0.4)} />
          <TrendIndicator cPerH={-2.8} text={fmtRate(-2.8)} />
          <TrendIndicator cPerH={0.02} text={fmtRate(0)} />
        </Row>
        <AutoGrid min={260} gap="sm">
          {SOURCE_KINDS.map((k) => (
            <TargetSourceLine key={k} kind={k} text={k === 'pending' ? t('New target · not sent yet') : targetDisplayLabel(k)} />
          ))}
        </AutoGrid>
        <MetaRow
          items={[
            { icon: 'droplet', text: '46%' },
            { icon: 'windowOpen', text: t('Window'), tone: 'warn' },
            { icon: 'radiator', text: '2/2' },
          ]}
        />
      </Block>

      <Block title={t('Buttons')}>
        {(['sm', 'md', 'lg', 'xl'] as const).map((size) => (
          <Row key={size} gap="sm" wrap>
            {VARIANTS.map((v) => (
              <Button key={v} variant={v} size={size} icon={v === 'primary' ? 'check' : undefined}>
                {v}
              </Button>
            ))}
          </Row>
        ))}
        <Row gap="sm" wrap>
          <Button variant="primary" loading>
            {t('Save')}
          </Button>
          <Button variant="secondary" disabled>
            {t('Save')}
          </Button>
          <IconButton icon="settings" label={t('Settings')} />
          <IconButton icon="close" label={t('Close')} variant="ghost" />
          <IconButton icon="minus" label="−" variant="round" size={48} />
          <IconButton icon="plus" label="+" variant="round" size={48} />
          <IconButton icon="trash" label={t('Delete')} disabled />
        </Row>
      </Block>

      <Block title={t('Icons')}>
        <AutoGrid min={120} gap="xs">
          {ICON_NAMES.map((name) => (
            <Row key={name} gap="xs">
              <Icon name={name} size={24} />
              <span>{name}</span>
            </Row>
          ))}
        </AutoGrid>
      </Block>

      <KitGallerySection />
      <VizGallerySection />
    </Stack>
  );
}

/** `#/dev/ui`: every component of the kit in the dark and the light scheme. */
export default function GalleryPage() {
  return (
    <Page title={t('Components')} subtitle={t('Every component in its states, in both colour schemes.')}>
      <AutoGrid min={560} gap="lg">
        <SchemeScope scheme="dark">
          <Basics />
        </SchemeScope>
        <SchemeScope scheme="light">
          <Basics />
        </SchemeScope>
      </AutoGrid>
    </Page>
  );
}
