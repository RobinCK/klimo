import { Entity, Index } from 'typeorm';
import type { Actor, ChannelKind, EntityId, Incident, IncidentAction, Reason, ReasonParams, RunSpan, SentMessage } from '../../shared/model';
import { EntityCol, EnumCol, FloatCol, IdCol, IntCol, JsonCol, PkCol, StrCol, TextCol, TsCol } from '../columns';

/* Incidents, sent messages, the decision journal and run spans (uuid ids, never exported). */

@Entity('incident')
export class IncidentRow {
  @PkCol() id: string;
  @EnumCol() kind: string;
  @EnumCol() severity: string;
  @Index() @StrCol(255) dedupKey: string;
  @Index() @EnumCol() status: string;
  @Index() @TsCol() openedAt: number;
  @TsCol() updatedAt: number;
  @TsCol(true) clearSince: number | null;
  @TsCol(true) resolvedAt: number | null;
  @TsCol(true) ackAt: number | null;
  @JsonCol() ackBy: Actor | null;
  @TsCol(true) snoozedUntil: number | null;
  @TsCol(true) dismissedAt: number | null;
  @FloatCol(true) dismissedUntilPct: number | null;
  @Index() @IdCol(true) roomId: string | null;
  @Index() @IdCol(true) sourceId: string | null;
  @EntityCol(true) entityId: string | null;
  @StrCol(255, true) deviceKey: string | null;
  @JsonCol() facts: ReasonParams;
  @JsonCol() progress: Incident['progress'];
  @JsonCol() actions: IncidentAction[];
  @TsCol(true) notifiedAt: number | null;
  @IntCol() repeatCount: number;
  @TsCol(true) escalatedAt: number | null;
}

@Entity('sent_message')
export class SentMessageRow {
  @PkCol() id: string;
  @Index() @IdCol(true) incidentId: string | null;
  @Index() @TsCol() at: number;
  @EnumCol() kind: string;
  @EnumCol(true) eventKind: string | null;
  @EnumCol(true) severity: string | null;
  @StrCol(255) title: string;
  @TextCol() body: string;
  @JsonCol() targets: SentMessage['targets'];
  @TsCol(true) queuedUntil: number | null;
}

@Entity('journal')
@Index(['category', 'ts'])
export class JournalRow {
  @PkCol() id: string;
  @Index() @TsCol() ts: number;
  @EnumCol() category: string;
  @EnumCol() tone: string;
  @StrCol(48) code: string;
  @JsonCol() params: ReasonParams;
  @JsonCol() why: Reason | null;
  @Index() @IdCol(true) roomId: string | null;
  @Index() @IdCol(true) sourceId: string | null;
  @StrCol(255, true) deviceKey: string | null;
  @JsonCol() entityIds: EntityId[];
  @JsonCol() notified: ChannelKind[];
}

@Entity('run_span')
@Index(['subject', 'subjectId', 'startTs'])
export class RunSpanRow {
  @PkCol() id: string;
  @EnumCol() subject: string;
  @IdCol() subjectId: string;
  @EnumCol() kind: string;
  @EnumCol(true) mode: string | null;
  @Index() @TsCol() startTs: number;
  @Index() @TsCol(true) endTs: number | null;
  @JsonCol() meta: RunSpan['meta'];
}
