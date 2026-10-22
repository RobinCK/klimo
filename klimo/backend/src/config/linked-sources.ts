import { deepClone, isPlainObject } from '../shared/defaults';
import { SOURCE_LINKABLE_FIELDS } from '../shared/model';
import type { Id, SourceConfig, SourceLinkableField } from '../shared/model';

/* =====================================================================================================
 * Linked sources («як у шаблоні»): three identical ACs follow one template source. A child copies the
 * template's linkable fields; a field the child changed locally is listed in `ownFields` («змінено»).
 * Changing the template still reaches an "own" field wherever the child kept the template's previous
 * value — the child only keeps what it really changed (template min run 5 → 6 reaches a child that
 * edited only its min pause).
 * ===================================================================================================== */

export const LINKABLE: readonly SourceLinkableField[] = SOURCE_LINKABLE_FIELDS;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The shared part of a linkable field: a child's own power meter is its device binding, not a setting. */
function shared(s: SourceConfig, f: SourceLinkableField): unknown {
  return f === 'energy' ? { ...s.energy, powerEntityId: null } : s[f];
}

/** Template value for a child field, keeping the child's device-specific bindings. */
function fromTemplate(template: SourceConfig, child: SourceConfig, f: SourceLinkableField): unknown {
  const v = deepClone(template[f]);
  return f === 'energy' ? { ...(v as SourceConfig['energy']), powerEntityId: child.energy.powerEntityId } : v;
}

/** Three-way merge of one field: leaves the template changed get the new value unless the child diverged. */
export function mergeTemplateChange(oldT: unknown, newT: unknown, child: unknown): unknown {
  if (same(oldT, newT)) return deepClone(child);
  if (same(child, oldT)) return deepClone(newT);
  if (isPlainObject(oldT) && isPlainObject(newT) && isPlainObject(child)) {
    const out: Record<string, unknown> = { ...deepClone(child) };
    for (const k of new Set([...Object.keys(oldT), ...Object.keys(newT)])) {
      out[k] = mergeTemplateChange(oldT[k], newT[k], child[k]);
      if (out[k] === undefined) delete out[k];
    }
    return out;
  }
  // a scalar/array the child changed itself stays the child's
  return deepClone(child);
}

/** Propagates a template edit (`before` → `after`) into a child. Returns the updated child. */
export function propagateToChild(before: SourceConfig, after: SourceConfig, child: SourceConfig): SourceConfig {
  const next = { ...child } as SourceConfig & Record<SourceLinkableField, unknown>;
  for (const f of LINKABLE) {
    next[f] = (child.ownFields.includes(f) ? mergeTemplateChange(shared(before, f), shared(after, f), child[f]) : fromTemplate(after, child, f)) as never;
  }
  next.energy = { ...next.energy, powerEntityId: child.energy.powerEntityId };
  next.ownFields = recomputeOwnFields(next, after);
  return next;
}

/** Copies every linkable field of the template (`ownFields: []` — «Повернути як у шаблоні»). */
export function relinkAll(template: SourceConfig, child: SourceConfig): SourceConfig {
  const next = { ...child } as SourceConfig & Record<SourceLinkableField, unknown>;
  for (const f of LINKABLE) next[f] = fromTemplate(template, child, f) as never;
  next.ownFields = [];
  return next;
}

/** Linkable fields where the child differs from its template. */
export function recomputeOwnFields(child: SourceConfig, template: SourceConfig): SourceLinkableField[] {
  return LINKABLE.filter((f) => !same(shared(child, f), shared(template, f)));
}

/** Fields a PATCH touches among the linkable ones. */
export function touchedLinkable(patch: object): SourceLinkableField[] {
  return LINKABLE.filter((f) => f in patch);
}

/**
 * After a child edit: touched fields that now differ from the template become own; touched fields
 * brought back to the template value are linked again. Untouched own fields stay own.
 */
export function ownFieldsAfterChildEdit(child: SourceConfig, template: SourceConfig, touched: readonly SourceLinkableField[]): SourceLinkableField[] {
  const own = new Set(child.ownFields);
  for (const f of touched) {
    if (same(shared(child, f), shared(template, f))) own.delete(f);
    else own.add(f);
  }
  return LINKABLE.filter((f) => own.has(f));
}

export function childrenOf(sources: Iterable<SourceConfig>, templateId: Id): SourceConfig[] {
  return [...sources].filter((s) => s.linkedTo === templateId);
}

/** The same adapter shape with every HA entity unbound (a copy drives its own device, never the original's). */
export function unbindAdapter(a: SourceConfig['adapter']): SourceConfig['adapter'] {
  const confirm = (c: typeof a.confirm, fallback: typeof a.confirm): typeof a.confirm =>
    c.kind === 'entity_on' || c.kind === 'power_above' || c.kind === 'state_in' ? fallback : c;
  switch (a.type) {
    case 'relay':
      return { ...a, command: null, stages: [], flowSetpoint: null, watchdog: { kind: 'none' }, confirm: confirm(a.confirm, { kind: 'readback' }) };
    case 'climate':
      return { ...a, climate: null, defrostEntityId: null, errorEntityId: null, copEntityId: null, supplyTempEntityId: null, confirm: confirm(a.confirm, { kind: 'hvac_action' }) };
    case 'flow':
      return { ...a, enable: null, flowSetpoint: null, actualFlow: null, modeSelect: null, confirm: confirm(a.confirm, { kind: 'readback' }) };
    case 'script':
      return { ...a, on: {}, off: null, confirm: confirm(a.confirm, { kind: 'none' }) };
    case 'custom':
      return { ...a, confirm: confirm(a.confirm, { kind: 'none' }) };
  }
}

/** «Дублювати»: a disabled copy with unbound entities that optionally follows the original as its template. */
export function duplicateSource(src: SourceConfig, opts: { id: Id; name: string; linked: boolean; roomId?: Id | null; now: number; order: number }): SourceConfig {
  const copy = deepClone(src);
  return {
    ...copy,
    id: opts.id,
    name: opts.name,
    roomId: copy.scope === 'room' ? (opts.roomId === undefined ? copy.roomId : opts.roomId) : null,
    order: opts.order,
    enabled: false,
    adapter: unbindAdapter(copy.adapter),
    energy: { ...copy.energy, powerEntityId: null },
    meters: [],
    linkedTo: opts.linked ? src.linkedTo ?? src.id : null,
    ownFields: [],
    createdAt: opts.now,
    updatedAt: opts.now,
  };
}
