import type { ReactNode } from 'react';
import { Modal } from '@mantine/core';
import s from './shell.module.css';

export interface OverlayPanelProps {
  open: boolean;
  onClose: () => void;
  /** Accessible name of the dialog. */
  label: string;
  maxWidth?: number;
  children: ReactNode;
}

/**
 * A routed page shown as a centred panel over the previous page (the add-room wizard on
 * desktop). The content brings its own header and close button; Escape closes.
 */
export function OverlayPanel({ open, onClose, label, maxWidth = 560, children }: OverlayPanelProps) {
  return (
    <Modal
      opened={open}
      onClose={onClose}
      withCloseButton={false}
      size={maxWidth}
      padding={0}
      closeOnClickOutside={false}
      title={null}
      aria-label={label}
      classNames={{ body: s.overlayBody, content: s.overlayContent }}
    >
      {children}
    </Modal>
  );
}
