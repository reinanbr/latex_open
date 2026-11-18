import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useUI, type DialogRequest } from "../store/ui";
import { Icon } from "./Icon";

/** Renders the active confirm/prompt dialog and the toast stack. */
export function Overlays() {
  const dialog = useUI((s) => s.dialog);
  const toasts = useUI((s) => s.toasts);
  const dismiss = useUI((s) => s.dismissToast);
  return (
    <>
      {dialog && <Dialog key={dialog.title} req={dialog} />}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.message}</span>
            <button aria-label="Fechar" onClick={() => dismiss(t.id)}>
              <Icon name="x" />
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Dialog({ req }: { req: DialogRequest }) {
  const setDialog = useUI((s) => s.setDialog);
  const [value, setValue] = useState(req.kind === "prompt" ? req.initial : "");
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (req.kind === "prompt" && inputRef.current) {
      const el = inputRef.current;
      el.focus();
      const [a, b] = req.select ?? [0, req.initial.length];
      el.setSelectionRange(a, b);
    } else {
      confirmRef.current?.focus();
    }
  }, [req]);

  const close = (ok: boolean) => {
    setDialog(null);
    if (req.kind === "confirm") req.resolve(ok);
    else req.resolve(ok ? value.trim() || null : null);
  };

  return (
    <Modal onClose={() => close(false)} labelledBy="dialog-title">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          close(true);
        }}
      >
        <h2 id="dialog-title">{req.title}</h2>
        {req.message && <p>{req.message}</p>}
        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            className="input"
            value={value}
            placeholder={req.placeholder}
            onChange={(e) => setValue(e.target.value)}
          />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => close(false)}>
            Cancelar
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={req.kind === "confirm" && req.danger ? "btn btn-danger" : "btn btn-primary"}
            disabled={req.kind === "prompt" && !value.trim()}
          >
            {req.confirmLabel ?? "OK"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function Modal({ children, onClose, labelledBy }: { children: ReactNode; onClose: () => void; labelledBy?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </div>
  );
}

/** A button that toggles a dropdown menu; closes on outside click / Escape. */
export function MenuButton({
  label,
  button,
  children,
  align = "left",
  className = "btn btn-ghost",
  title,
  disabled,
}: {
  label: string;
  button: ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  className?: string;
  title?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    // A fixed menu would detach from its button: close when the button
    // moves (window resize, or scrolling of something that contains it — not
    // the PDF viewer or the menu's own scrolling).
    const onMove = (e: Event) => {
      const t = e.target;
      if (e.type === "resize" || t === document || (t instanceof Node && ref.current && t.contains(ref.current))) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    document.addEventListener("scroll", onMove, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onMove);
      document.removeEventListener("scroll", onMove, true);
    };
  }, [open]);
  // The menu is rendered in <body> with fixed coordinates, so toolbars with
  // overflow (the PDF bar scrolls horizontally) cannot clip it.
  useLayoutEffect(() => {
    if (!open || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const top = r.bottom + 4;
    setPos({
      top,
      maxHeight: `calc(100vh - ${Math.round(top) + 8}px)`,
      ...(align === "right" ? { right: Math.max(8, window.innerWidth - r.right) } : { left: Math.max(8, r.left) }),
    });
  }, [open, align]);
  return (
    <div className="menu-wrap" ref={ref}>
      <button
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={title ?? label}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {button}
      </button>
      {open &&
        pos &&
        createPortal(
          <div ref={menuRef} className="menu menu-floating" role="menu" style={pos}>
            {children(() => setOpen(false))}
          </div>,
          document.body,
        )}
    </div>
  );
}
