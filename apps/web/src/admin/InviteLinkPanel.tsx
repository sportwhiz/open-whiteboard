import { forwardRef, useEffect, useId, useImperativeHandle, useRef, useState } from "react";
import "./invite-link.css";

export const INVITE_LINK_NOTE =
  "For security, links are shown only once. A new link replaces this one; the old link stops working.";

/**
 * A just-created invitation link, attached to its invitation. Tokens are
 * stored hashed, so this is the only time the link can be copied.
 */
export const InviteLinkPanel = forwardRef<
  { focus: () => void },
  { link: string; title: string; note?: string; onDone: () => void }
>(function InviteLinkPanel({ link, title, note = INVITE_LINK_NOTE, onDone }, ref) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const copy = useRef<HTMLButtonElement>(null);
  const [state, setState] = useState<"idle" | "copied" | "manual">("idle");
  useImperativeHandle(ref, () => ({
    focus: () => {
      copy.current?.focus({ preventScroll: true });
      copy.current?.closest(".invite-link")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
  }));
  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);
  const copyLink = () => {
    void navigator.clipboard
      .writeText(link)
      .then(() => setState("copied"))
      .catch(() => {
        input.current?.focus();
        input.current?.select();
        setState("manual");
      });
  };
  return (
    <div className="invite-link">
      <label className="invite-link-title" htmlFor={`${id}-link`}>{title}</label>
      <div className="invite-link-field">
          <input
            id={`${id}-link`}
            aria-describedby={`${id}-note`}
            ref={input}
            readOnly
            value={link}
            spellCheck={false}
            onFocus={(event) => event.currentTarget.select()}
          />
          <button
            ref={copy}
            type="button"
            className={state === "copied" ? "copied" : undefined}
            onClick={copyLink}
          >
            {state === "copied" ? "Copied" : "Copy link"}
          </button>
      </div>
      <span className="sr-only" role="status">
        {state === "copied" ? "Link copied" : state === "manual" ? "Link selected. Press Control+C or Command+C to copy it." : ""}
      </span>
      <p id={`${id}-note`}>
        {state === "manual"
          ? "Copying isn’t available here. The link is selected; press Ctrl+C (⌘C on Mac) to copy it. "
          : ""}
        {note}
      </p>
      <button type="button" className="identity-link" onClick={onDone}>
        Done
      </button>
    </div>
  );
});
