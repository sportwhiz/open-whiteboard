import { cacheIdentity } from './auth-client';

/** Return navigation belongs to the current account, including on shared boards. */
export function studioSessionKey(kind: 'return' | 'return-card', userId?: string) {
  return `whiteboard-studio-${kind}:${cacheIdentity(userId)}`;
}
