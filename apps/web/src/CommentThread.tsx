import { useRef } from 'react';
import { mentionedIds, useMentionPicker, type MentionPerson } from './MentionPicker';
import type { CommentThread as Thread } from './room-collaboration';
import type { PublicCollaborationState } from './room-collaboration';
import { avatarInk } from './avatar-color';
import { anchorLabel, type SemanticBoard } from './collaboration-labels';
import { DetailsMenu } from './DetailsMenu';
import { UiIcon } from './UiIcon';
import type { CommandResult, CommandValues } from './collaboration-commands';

const when = (value: string) => new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const firstLine = (value: string) => value.replace(/\s+/gu, ' ').trim();

/**
 * One conversation. Collapsed it is a single summary (who, where, first
 * line, replies); expanded it shows replies, the reply box and actions, with
 * secondary actions in a menu.
 */
export function CommentThreadCard({ thread, state, semantic, expanded, mentioned, muted, isGuest, reply, onReply, onSent, onSelect, onToggle, onShow, onCopyLink, onMute, onResolve, command, mentionPeople, editing, onEdit }: {
  thread: Thread;
  state: PublicCollaborationState;
  semantic: SemanticBoard;
  expanded: boolean;
  mentioned: boolean;
  muted: boolean;
  isGuest: boolean;
  reply: string;
  onReply: (value: string) => void;
  onSent?: () => void;
  onSelect: () => void;
  onToggle: () => void;
  onShow: () => void;
  onCopyLink: () => void;
  onMute: () => void;
  onResolve: () => void;
  command: (action: string, values?: CommandValues) => Promise<CommandResult | null>;
  mentionPeople: MentionPerson[];
  editing: { replyId: string; body: string } | null;
  onEdit: (value: { replyId: string; body: string } | null) => void;
}) {
  const replies = thread.replies.filter(item => !item.deletedAt);
  const opener = thread.replies[0];
  const count = thread.replies.length - 1;
  const place = anchorLabel(thread.anchor.objectId, semantic);
  const replyRef = useRef<HTMLInputElement>(null);
  const mentions = useMentionPicker({ value: reply, onValue: onReply, people: mentionPeople, field: replyRef });
  const mentionsFor = (text: string) => mentionedIds(text, mentionPeople);
  return <article id={thread.id} tabIndex={-1} data-focus-group={thread.id} aria-current={expanded ? 'true' : undefined}
    aria-label={`${place}, started by ${opener?.author.name ?? 'someone'}`}
    className={`comment-thread ${thread.resolvedAt ? 'resolved' : ''} ${expanded ? 'active expanded' : 'compact'}`}
    onFocus={onSelect}>
    <button type="button" className="thread-summary" aria-expanded={expanded} onClick={onToggle}>
      {opener ? <span className="thread-avatar" style={{ background: opener.author.color, color: avatarInk(opener.author.color) }} aria-hidden="true">{opener.author.name.slice(0, 1).toUpperCase()}</span> : null}
      <span className="thread-summary-body">
        <span className="thread-meta"><strong>{opener?.author.name ?? 'Someone'}</strong><span>{opener ? when(opener.createdAt) : ''}</span></span>
        <span className="thread-place">{thread.anchor.objectId ? <UiIcon name="comment" /> : null}{place}</span>
        {!expanded ? <span className="thread-first-line">{opener?.deletedAt ? 'Comment deleted' : firstLine(opener?.body ?? '')}</span> : null}
        <span className="thread-tags">
          {thread.resolvedAt ? <span className="comment-state resolved">Resolved</span> : null}
          {mentioned ? <span className="comment-state mention">@ you</span> : null}
          {!expanded && count > 0 ? <span className="thread-count">{count} {count === 1 ? 'reply' : 'replies'}</span> : null}
        </span>
      </span>
      <UiIcon name="chevron" className="thread-chevron" />
    </button>
    {expanded ? <div className="thread-body">
      {thread.replies.map((item, index) => <div className="comment-reply" key={item.id}>
        {index ? <span style={{ background: item.author.color, color: avatarInk(item.author.color) }} aria-hidden="true">{item.author.name.slice(0, 1).toUpperCase()}</span> : null}
        <div>
          {index ? <strong>{item.author.name}{item.author.id.startsWith('guest:') ? ' · guest' : ''} <small>{when(item.createdAt)}</small></strong> : null}
          {editing?.replyId === item.id ? <form className="inline-reply reply-editor" onSubmit={event => { event.preventDefault(); void command('edit_reply', { threadId: thread.id, replyId: item.id, body: editing.body }).then(result => { if (result) onEdit(null); }); }}>
            <input autoFocus data-draft aria-label="Edit reply" value={editing.body} onChange={event => onEdit({ replyId: item.id, body: event.target.value })} />
            <button type="submit">Save</button><button type="button" onClick={() => onEdit(null)}>Cancel</button>
          </form> : <p>{item.deletedAt ? <em>Reply deleted</em> : item.body}</p>}
        </div>
        {!item.deletedAt && item.author.id === state.currentUserId && editing?.replyId !== item.id ? <DetailsMenu className="reply-menu">
          <summary aria-label={`Actions for your ${index ? 'reply' : 'comment'}`} title="More" data-reply-edit={item.id}><UiIcon name="more" /></summary>
          <div className="reply-menu-popover">
            <button type="button" onClick={() => onEdit({ replyId: item.id, body: item.body })}>Edit</button>
            <button type="button" className="danger-text" onClick={() => void command('delete_reply', { threadId: thread.id, replyId: item.id })}>Delete</button>
          </div>
        </DetailsMenu> : null}
      </div>)}
      {!replies.length ? <p className="panel-hint">Every message in this thread was deleted.</p> : null}
      {state.capabilities.comment && !thread.resolvedAt ? <form className="inline-reply" onSubmit={event => { event.preventDefault(); if (!reply.trim()) return; void command('reply_comment', { threadId: thread.id, body: reply, mentions: mentionsFor(reply) }).then(result => { if (result) { onReply(''); onSent?.(); } }); }}>
        <span className="mention-field">
          <input ref={replyRef} data-draft value={reply} {...mentions.fieldProps} onChange={mentions.onChange} onKeyDown={event => { mentions.onKeyDown(event); }} aria-label="Reply" placeholder="Reply or type @ to mention" />
          {mentions.list}
        </span>
        <button type="submit" disabled={!reply.trim()}>Send</button>
      </form> : null}
      <div className="thread-actions">
        {state.capabilities.comment ? <button className="text-action" type="button" onClick={onResolve}>{thread.resolvedAt ? 'Reopen' : 'Resolve'}</button> : null}
        <button className="text-action" type="button" onClick={onShow}>Show on board</button>
        <DetailsMenu className="thread-menu">
          <summary aria-label="More thread actions" title="More"><UiIcon name="more" /></summary>
          <div className="reply-menu-popover">
            {isGuest ? null : <button type="button" onClick={onCopyLink}>Copy link</button>}
            <button type="button" onClick={onMute}>{muted ? 'Unmute replies' : 'Mute replies'}</button>
          </div>
        </DetailsMenu>
      </div>
    </div> : null}
  </article>;
}
