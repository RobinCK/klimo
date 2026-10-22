import type { Action, IconName } from '../../types';
import { Button, type ButtonSize, type ButtonVariant } from '../../basic/Button';

/** An Action with an optional look; dialogs and cards default the last action to primary. */
export type KitAction = Action & { variant?: ButtonVariant; icon?: IconName };

export function ActionButton({
  action,
  variant,
  size = 'md',
  fullWidth,
}: {
  action: KitAction;
  variant: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
}) {
  return (
    <Button
      variant={action.variant ?? variant}
      size={size}
      icon={action.icon}
      onClick={action.onClick}
      to={action.to}
      disabled={action.disabled}
      loading={action.loading}
      fullWidth={fullWidth}
    >
      {action.label}
    </Button>
  );
}

/** Footer buttons: every action secondary except the last one, which is the primary. */
export function ActionRow({ actions, className, size }: { actions: KitAction[]; className: string; size?: ButtonSize }) {
  if (!actions.length) return null;
  return (
    <div className={className}>
      {actions.map((a, i) => (
        <ActionButton key={`${a.label}-${i}`} action={a} size={size} variant={i === actions.length - 1 ? 'primary' : 'secondary'} />
      ))}
    </div>
  );
}
