import { useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useDialogFocus } from "../useDialogFocus";
import "./admin-confirm.css";

/**
 * A confirmation that states the consequences of an administrative change.
 * Cancel comes first and takes focus, so a stray Enter never confirms.
 * Escape cancels; focus returns to the control that opened it.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const id = useId();
  useDialogFocus(dialog, true, onCancel);
  return createPortal(
    <div className="leave-confirm-backdrop">
      <div
        ref={dialog}
        tabIndex={-1}
        className="leave-confirm admin-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-description`}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <div id={`${id}-description`} className="admin-confirm-body">
          {children}
        </div>
        <div className="leave-confirm-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? "identity-danger" : "identity-primary"}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
