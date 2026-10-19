import type { ReactElement, ReactNode } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Tooltip from '@radix-ui/react-tooltip';
import { X } from 'lucide-react';

export const ICON = { size: 16, strokeWidth: 1.5 } as const;

/** Tooltip around a single focusable child. */
export function Tip({ label, children }: { label: ReactNode; children: ReactElement }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={6}>
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Modal({
  open,
  onOpenChange,
  title,
  children,
  footer,
  width,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-scrim" />
        <Dialog.Content className="dialog" style={width ? { width: Math.min(width, window.innerWidth - 32) } : undefined} aria-describedby={undefined}>
          <div className="dialog__head">
            <Dialog.Title className="dialog__title">{title}</Dialog.Title>
            <Dialog.Close asChild>
              <button className="btn btn--ghost btn--icon" aria-label="Close">
                <X {...ICON} />
              </button>
            </Dialog.Close>
          </div>
          <div className="dialog__body">{children}</div>
          {footer ? <div className="dialog__foot">{footer}</div> : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
