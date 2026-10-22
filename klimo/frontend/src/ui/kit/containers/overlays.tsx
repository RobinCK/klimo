import { useRef, useState, type PointerEvent, type ReactNode } from 'react';
import { Drawer as MantineDrawer, Modal } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { Action } from '../../types';
import { useUiText } from '../../UiTextContext';
import { Icon } from '../../basic/Icon';
import { ActionButton, ActionRow, type KitAction } from '../internal/ActionButton';
import { cx } from '../internal/util';
import { StatusBanner } from '../feedback/status';
import s from './containers.module.css';

const PHONE = '(max-width: 699px)';

// Styles go through the Root's classNames: a className on Modal.Content / Drawer.Content is
// also applied to Mantine's full-screen inner wrapper, which would paint over the scrim.
const DIALOG_CLASSES = {
  overlay: s.overlay,
  content: cx(s.overlayContent, s.dialogContent),
  header: s.dialogHeader,
  title: s.dialogTitle,
  body: s.dialogBody,
};
const DRAWER_CLASSES = {
  overlay: s.overlay,
  content: cx(s.overlayContent, s.drawerContent),
  header: s.drawerHeader,
  title: s.dialogTitle,
  body: s.drawerBody,
};
const SHEET_CLASSES = {
  overlay: s.overlay,
  content: cx(s.overlayContent, s.sheetContent),
  title: s.sheetTitle,
};

function CloseButton({ onClose }: { onClose: () => void }) {
  const ut = useUiText();
  const label = ut('Close');
  return (
    <button type="button" className={s.closeButton} aria-label={label} title={label} onClick={onClose}>
      <Icon name="close" size={18} />
    </button>
  );
}

/* ---------------- Dialog ---------------- */

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Footer buttons, the last one is the primary («Скасувати», «Зберегти»). */
  actions: KitAction[];
  /** Width: sm 420 · md 520 · lg 680. */
  size?: 'sm' | 'md' | 'lg';
  /** Why the last attempt failed, in words, shown above the buttons (what no field of the dialog shows). */
  error?: string | null;
}

const DIALOG_WIDTH = { sm: 420, md: 520, lg: 680 } as const;

/** Centred modal: Escape and the scrim close it, focus stays inside until it closes. */
export function Dialog({ open, onClose, title, children, actions, size = 'md', error }: DialogProps) {
  return (
    <Modal.Root opened={open} onClose={onClose} size={DIALOG_WIDTH[size]} centered radius={18} zIndex={300} classNames={DIALOG_CLASSES}>
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
          <CloseButton onClose={onClose} />
        </Modal.Header>
        <Modal.Body>
          {children}
          {error ? <StatusBanner tone="err" icon="alert" text={error} /> : null}
          <ActionRow actions={actions} className={s.footer} />
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

/* ---------------- ConfirmDialog ---------------- */

export interface ConfirmDialogProps {
  open: boolean;
  title: ReactNode;
  body?: ReactNode;
  /** What will happen, one line each («Головки повернуться до власного режиму з ціллю 20°»). */
  consequences?: string[];
  confirm: Action & { tone?: 'danger' };
  onCancel: () => void;
  cancelLabel?: string;
}

/** «Are you sure?» with the consequences spelled out; Cancel is always there. */
export function ConfirmDialog({ open, title, body, consequences, confirm, onCancel, cancelLabel }: ConfirmDialogProps) {
  const ut = useUiText();
  return (
    <Modal.Root opened={open} onClose={onCancel} size={460} centered radius={18} zIndex={300} classNames={DIALOG_CLASSES}>
      <Modal.Overlay />
      <Modal.Content>
        <Modal.Header>
          <Modal.Title>{title}</Modal.Title>
          <CloseButton onClose={onCancel} />
        </Modal.Header>
        <Modal.Body>
          {typeof body === 'string' ? <p className={s.dialogText}>{body}</p> : body}
          {consequences?.length ? (
            <ul className={s.consequences}>
              {consequences.map((c, i) => (
                <li key={i}>
                  <Icon name="alert" size={16} />
                  <span>{c}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={s.footer}>
            <ActionButton action={{ label: cancelLabel ?? ut('Cancel'), onClick: onCancel }} variant="secondary" />
            <ActionButton action={confirm} variant={confirm.tone === 'danger' ? 'danger' : 'primary'} />
          </div>
        </Modal.Body>
      </Modal.Content>
    </Modal.Root>
  );
}

/* ---------------- Drawer ---------------- */

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  /** Sticky footer (Save / Cancel). */
  footer?: ReactNode;
  /** Width on tablets and desktops; phones always get the full width. */
  width?: number;
}

/** Side panel from the right (device details, trigger and rule editors). */
export function Drawer({ open, onClose, title, children, footer, width = 520 }: DrawerProps) {
  // read synchronously: a drawer mounted already open must not slide in at the tablet width first
  const phone = useMediaQuery(PHONE, undefined, { getInitialValueInEffect: false }) ?? false;
  return (
    <MantineDrawer.Root opened={open} onClose={onClose} position="right" size={phone ? '100%' : width} zIndex={300} classNames={DRAWER_CLASSES}>
      <MantineDrawer.Overlay />
      <MantineDrawer.Content>
        <MantineDrawer.Header>
          <MantineDrawer.Title>{title}</MantineDrawer.Title>
          <CloseButton onClose={onClose} />
        </MantineDrawer.Header>
        <MantineDrawer.Body>{children}</MantineDrawer.Body>
        {footer ? <div className={s.drawerFooter}>{footer}</div> : null}
      </MantineDrawer.Content>
    </MantineDrawer.Root>
  );
}

/* ---------------- BottomSheet ---------------- */

export interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
}

// a pull of this many px on the grabber dismisses the sheet
const DISMISS_PX = 80;

/** Phone sheet from the bottom: grabber, title, close; pull the grabber down to dismiss. */
export function BottomSheet({ open, onClose, title, subtitle, children, footer }: BottomSheetProps) {
  const [drag, setDrag] = useState(0);
  const start = useRef<number | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    start.current = e.clientY;
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (start.current == null) return;
    setDrag(Math.max(0, e.clientY - start.current));
  };
  const onPointerEnd = () => {
    if (start.current == null) return;
    start.current = null;
    if (drag > DISMISS_PX) onClose();
    setDrag(0);
  };

  return (
    <MantineDrawer.Root opened={open} onClose={onClose} position="bottom" size="auto" zIndex={300} classNames={SHEET_CLASSES}>
      <MantineDrawer.Overlay />
      <MantineDrawer.Content
        // `translate` is independent of the transform Mantine animates, so the pull follows the finger
        style={drag ? { translate: `0 ${drag}px` } : undefined}
      >
        <div
          className={s.sheetGrab}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          <span className={s.grabber} aria-hidden="true" />
          <div className={s.sheetHead}>
            <div className={s.sheetTitles}>
              <MantineDrawer.Title>{title}</MantineDrawer.Title>
              {subtitle != null ? <span className={s.sheetSub}>{subtitle}</span> : null}
            </div>
            <CloseButton onClose={onClose} />
          </div>
        </div>
        <div className={s.sheetBody}>{children}</div>
        {footer ? <div className={s.sheetFooter}>{footer}</div> : null}
      </MantineDrawer.Content>
    </MantineDrawer.Root>
  );
}
