import type { ConditionEval, ConditionNode, Dow, TimeWindow } from '@api/model';

export type ConditionOp = ConditionNode['op'];
export type LeafNode = Exclude<ConditionNode, { op: 'all' | 'any' | 'not' }>;
export type GroupNode = Extract<ConditionNode, { op: 'all' | 'any' }>;

export interface OptionCtx {
  triggers: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  sources: { id: string; name: string }[];
}

/** The ops a user can add, in menu order (logic first, then the house, then Home Assistant). */
export const LEAF_OPS = [
  'outdoor',
  'room_deficit',
  'room_below_target',
  'source',
  'season',
  'house_mode',
  'trigger',
  'grid',
  'budget_fits',
  'time',
  'sun',
  'state',
  'numeric',
  'weather',
  'template',
  'const',
] as const satisfies readonly LeafNode['op'][];

export const isGroup = (n: ConditionNode): n is GroupNode => n.op === 'all' || n.op === 'any';

/** A fresh node of `op` with sensible defaults; the id of the node it replaces is kept. */
export function defaultNode(op: ConditionOp, ctx: OptionCtx, id?: string): ConditionNode {
  const withId = <T extends ConditionNode>(n: T): T => (id ? { ...n, id } : n);
  switch (op) {
    case 'all':
    case 'any':
      return withId({ op, items: [] });
    case 'not':
      return withId({ op: 'not', item: { op: 'const', value: true } });
    case 'state':
      return withId({ op: 'state', entityId: '', equals: ['on'] });
    case 'numeric':
      return withId({ op: 'numeric', entityId: '', cmp: '<', value: 0 });
    case 'template':
      return withId({ op: 'template', template: '' });
    case 'time':
      return withId({ op: 'time', windows: [{ from: '23:00', to: '07:00' }] });
    case 'sun':
      return withId({ op: 'sun', is: 'above_horizon' });
    case 'weather':
      return withId({ op: 'weather', entityId: '', field: 'condition', cmp: '==', value: 'sunny' });
    case 'trigger':
      return withId({ op: 'trigger', triggerId: ctx.triggers[0]?.id ?? '' });
    case 'outdoor':
      return withId({ op: 'outdoor', cmp: '<', value: 0 });
    case 'room_deficit':
      return withId({ op: 'room_deficit', roomIds: 'served', deficitC: 1 });
    case 'room_below_target':
      return withId({ op: 'room_below_target', roomId: ctx.rooms[0]?.id ?? '', plusC: 0 });
    case 'source':
      return withId({ op: 'source', sourceId: ctx.sources[0]?.id ?? '', is: 'running' });
    case 'season':
      return withId({ op: 'season', in: ['heating'] });
    case 'house_mode':
      return withId({ op: 'house_mode', in: ['auto'] });
    case 'budget_fits':
      return withId({ op: 'budget_fits' });
    case 'grid':
      return withId({ op: 'grid', is: 'absent' });
    case 'const':
      return withId({ op: 'const', value: true });
  }
}

/** The evaluation of the n-th child: the preview tree mirrors the node tree. */
export function childEval(ev: ConditionEval | undefined, index: number): ConditionEval | undefined {
  return ev?.children?.[index];
}

/** What is missing before the node can be evaluated (an empty entity, no room …). */
export function incomplete(n: ConditionNode): boolean {
  switch (n.op) {
    case 'state':
    case 'numeric':
    case 'weather':
      return !n.entityId;
    case 'template':
      return !n.template.trim();
    case 'trigger':
      return !n.triggerId;
    case 'room_below_target':
      return !n.roomId;
    case 'source':
      return !n.sourceId;
    case 'time':
      return n.windows.length === 0;
    case 'season':
    case 'house_mode':
      return n.in.length === 0;
    case 'room_deficit':
      return Array.isArray(n.roomIds) && n.roomIds.length === 0;
    case 'all':
    case 'any':
      return n.items.length === 0 || n.items.some(incomplete);
    case 'not':
      return incomplete(n.item);
    default:
      return false;
  }
}

export const ALL_DAYS: Dow[] = [0, 1, 2, 3, 4, 5, 6];

export function emptyWindow(): TimeWindow {
  return { from: '08:00', to: '18:00' };
}

/** "on, heat" → ["on", "heat"]. */
export function splitList(text: string): string[] {
  return text
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}
