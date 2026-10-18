import { useEffect, useState, type CSSProperties } from "react";
import { avatarInk } from "../avatar-color";
import type { CommentThread } from "../room-collaboration";

type ViewBox = { x: number; y: number; w: number; h: number };
export const PIN_OFFSET = { x: 10, y: 2 };

/** Where a thread's pin points, in canvas view coordinates. Threads on an
 * object follow it (top-right corner, like a sticker on the paper); others
 * stay at their canvas point. */
export function commentPinPoint(
  thread: Pick<CommentThread, "anchor">,
  toView: (x: number, y: number) => [number, number],
  objectBounds: (id: string) => ViewBox | null,
) {
  const object = thread.anchor.objectId ? objectBounds(thread.anchor.objectId) : null;
  // Just outside the top-right corner, clear of the corner resize handle.
  if (object) return { x: object.x + object.w + PIN_OFFSET.x, y: object.y + PIN_OFFSET.y, attached: true };
  const [x, y] = toView(thread.anchor.x, thread.anchor.y);
  return { x, y, attached: false };
}

/** Unresolved comment threads as small pins that follow pan and zoom.
 * Clicking a pin asks the board page to open that thread. */
export function CommentPins({
  threads,
  toView,
  objectBounds,
  hidden,
  width,
  height,
  subscribe,
  selectedIds,
}: {
  /** Re-render when objects move or the viewport changes. */
  subscribe: (onChange: () => void) => () => void;
  /** While an object is selected its handles win over its pins. */
  selectedIds: () => string[];
  threads: CommentThread[];
  toView: (x: number, y: number) => [number, number];
  objectBounds: (id: string) => ViewBox | null;
  hidden: boolean;
  width: number;
  height: number;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [, setRevision] = useState(0);
  useEffect(() => subscribe(() => setRevision((value) => value + 1)), [subscribe]);
  useEffect(() => {
    const highlight = (event: Event) => setActive((event as CustomEvent<{ threadId: string | null }>).detail?.threadId ?? null);
    window.addEventListener("whiteboard-highlight-thread", highlight);
    return () => window.removeEventListener("whiteboard-highlight-thread", highlight);
  }, []);
  if (hidden) return null;
  const open = threads.filter((thread) => !thread.resolvedAt && thread.replies.some((reply) => !reply.deletedAt));
  if (!open.length) return null;
  const selected = new Set(selectedIds());
  return (
    <div className="canvas-comment-pins" role="group" aria-label="Comments on the board">
      {open.map((thread) => {
        const point = commentPinPoint(thread, toView, objectBounds);
        // Keep pins for off-screen anchors out of the way of the chrome.
        if (point.x < -24 || point.y < -24 || point.x > width + 24 || point.y > height + 24) return null;
        const replies = thread.replies.filter((reply) => !reply.deletedAt);
        const first = replies[0];
        const author = first?.author ?? { name: "?", color: "#64748b" };
        const count = replies.length;
        const excerpt = (first?.body ?? "").replace(/\s+/gu, " ").slice(0, 80);
        return (
          <button
            key={thread.id}
            type="button"
            className={"canvas-comment-pin" + (active === thread.id ? " active" : "") + (point.attached ? " attached" : "") +
              (thread.anchor.objectId && selected.has(thread.anchor.objectId) ? " behind-selection" : "")}
            style={{ left: point.x, top: point.y, "--pin-color": author.color, "--pin-ink": avatarInk(author.color) } as CSSProperties}
            aria-label={`Comment by ${author.name}${count > 1 ? `, ${count} messages` : ""}: ${excerpt}`}
            aria-pressed={active === thread.id}
            data-tip={`${author.name}: ${excerpt}${excerpt.length >= 80 ? "…" : ""}`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => {
              setActive(thread.id);
              window.dispatchEvent(new CustomEvent("whiteboard-open-thread", { detail: { threadId: thread.id } }));
            }}
          >
            <span className="pin-avatar" aria-hidden="true">{author.name.trim().slice(0, 1).toUpperCase() || "?"}</span>
            {count > 1 ? <span className="pin-count" aria-hidden="true">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
