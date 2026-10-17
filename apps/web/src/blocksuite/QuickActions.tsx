import { UiIcon } from "../UiIcon";
import { useEffect, useRef, useState } from "react";

export type QuickAction = {
  id: string;
  label: string;
  keywords?: string;
  shortcut?: string;
  disabled?: string;
  run(): void | Promise<void>;
};

export function QuickActions({ actions, onClose, onRun }: {
  actions: QuickAction[];
  onClose(): void;
  onRun(action: QuickAction): void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const words = query.trim().toLowerCase().split(/\s+/);
  const results = actions.filter(action => words.every(word =>
    `${action.label} ${action.keywords ?? ""}`.toLowerCase().includes(word)));
  const available = results.filter(action => !action.disabled);
  const active = available[Math.min(index, available.length - 1)];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => {
    ref.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active?.id]);
  return <div className="canvas-modal-backdrop" onPointerDown={event => {
    if (event.target === event.currentTarget) onClose();
  }}>
    <div className="canvas-modal quick-actions" role="dialog" aria-modal="true" aria-label="Quick actions" ref={ref}
      onKeyDown={event => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" || ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k")) {
          event.preventDefault(); event.stopPropagation(); onClose();
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); event.stopPropagation();
          if (available.length) setIndex((available.indexOf(active) + (event.key === "ArrowDown" ? 1 : -1) + available.length) % available.length);
        } else if (event.key === "Enter" && event.target === input.current) {
          event.preventDefault(); event.stopPropagation(); if (active) onRun(active);
        } else if (event.key === "Tab") {
          // The results use a single combobox focus; Tab cycles to Close.
          event.preventDefault();
          if (event.target === input.current) ref.current?.querySelector<HTMLButtonElement>("button")?.focus();
          else input.current?.focus();
        }
      }}>
      <header><h2>Quick actions</h2><button type="button" className="canvas-icon-button" aria-label="Close quick actions" onClick={onClose}><UiIcon name="close" className="canvas-icon" /></button></header>
      <input ref={input} role="combobox" aria-label="Search actions" aria-autocomplete="list" aria-expanded="true"
        aria-controls="quick-action-results" aria-activedescendant={active ? `quick-action-${active.id}` : undefined}
        placeholder="Try ‘tidy’, ‘next note’, or ‘fit selection’…" value={query}
        onChange={event => { setQuery(event.target.value); setIndex(0); }} />
      <div className="quick-action-results" id="quick-action-results" role="listbox" aria-label="Actions">
        {results.map(action => <div key={action.id} id={`quick-action-${action.id}`} role="option"
          aria-selected={active?.id === action.id} aria-disabled={Boolean(action.disabled)}
          onPointerMove={() => { const next = available.indexOf(action); if (next >= 0) setIndex(next); }}
          onMouseDown={event => event.preventDefault()}
          onClick={() => { if (!action.disabled) onRun(action); }}>
          <span>{action.label}{action.disabled && <small>{action.disabled}</small>}</span>
          {action.shortcut && <kbd>{action.shortcut}</kbd>}
        </div>)}
      </div>
      {!results.length && <p className="navigator-empty" role="status">No actions match “{query}”. Try a tool name or “zoom”.</p>}
      <p className="quick-action-hint">↑ ↓ to choose · Enter to run · Esc to close</p>
    </div>
  </div>;
}
