/**
 * Room requests marked as background (for example, reading note text for
 * search) yield to live editing. On Cloudflare each board is its own Durable
 * Object, so the header is informational; the Node runtime serializes every
 * room operation on one connection and turns background reads away when that
 * queue is already busy.
 */
export const ROOM_PRIORITY_HEADER = 'x-whiteboard-room-priority';

export function isBackgroundRoomRequest(input: Request | string | URL, init?: RequestInit) {
  const headers = init?.headers !== undefined ? new Headers(init.headers) : input instanceof Request ? input.headers : null;
  return headers?.get(ROOM_PRIORITY_HEADER) === 'background';
}
