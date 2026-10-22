/**
 * Settings for users who may only look (Home Assistant non-admins while «only admins change
 * the configuration» is on): values stay readable, the editors are not offered. The server
 * refuses such writes anyway; this keeps the page from promising a change it will revert.
 */
import { ValuePill, type ValuePillProps } from '@ui';

/** A value pill that opens its editor only when the user may change it. */
export function SettingPill(props: ValuePillProps & { readOnly: boolean }) {
  const { readOnly, ...pill } = props;
  if (readOnly) return <ValuePill text={pill.text} ariaLabel={pill.ariaLabel} />;
  return <ValuePill {...(pill as ValuePillProps)} />;
}

/** Choice options, all disabled for a read-only user (the selected one stays marked). */
export function lockable<O extends object>(options: readonly O[], canEdit: boolean): (O & { disabled?: boolean })[] {
  return canEdit ? [...options] : options.map((o) => ({ ...o, disabled: true }));
}
