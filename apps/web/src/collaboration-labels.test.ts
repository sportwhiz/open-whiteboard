import { describe, expect, it } from 'vitest';
import { anchorLabel, describeAnchor, objectAt, uniqueParticipants, type SemanticBoard } from './collaboration-labels';
import type { RoomParticipant } from './room-collaboration';

const board: SemanticBoard = {
  notes: [
    { id: 'note:1', text: 'Faster onboarding', xywh: '[0,0,208,208]' },
    { id: 'note:2', text: '', xywh: '[260,0,208,208]' },
    { id: 'note:3', text: 'A very long sticky note that keeps going well past what fits in a label', xywh: '[520,0,208,208]' },
  ],
  frames: [{ id: 'frame:1', title: 'Ideas', xywh: '[-100,-100,900,500]' }],
  shapes: [{ id: 'shape:1', text: 'Decision', xywh: '[2000,0,100,100]' }],
};

describe('comment anchor labels', () => {
  it('names the object instead of showing coordinates', () => {
    expect(anchorLabel('note:1', board)).toBe('On sticky “Faster onboarding”');
    expect(anchorLabel('note:2', board)).toBe('On a sticky note');
    expect(anchorLabel('frame:1', board)).toBe('On frame “Ideas”');
    expect(anchorLabel('shape:1', board)).toBe('On shape “Decision”');
    expect(anchorLabel(null, board)).toBe('Board comment');
    expect(anchorLabel('missing', board)).toBe('On a board object');
    expect(anchorLabel('note:3', board)).toMatch(/^On sticky “A very long sticky note .*…”$/u);
  });

  it('finds the sticky under a pin before the frame around it', () => {
    expect(objectAt({ x: 100, y: 112 }, board)).toBe('note:1');
    expect(objectAt({ x: 240, y: 300 }, board)).toBe('frame:1');
    expect(objectAt({ x: 5000, y: 5000 }, board)).toBeNull();
    expect(describeAnchor({ x: 100, y: 112, objectId: null }, board)).toBe('On sticky “Faster onboarding”');
    expect(describeAnchor({ x: 100, y: 112, objectId: 'shape:1' }, board)).toBe('On shape “Decision”');
  });
});

describe('presence', () => {
  const person = (id: string, connectionId: string, idle = false): RoomParticipant => ({ id, connectionId, name: id, avatarUrl: null, color: '#123456', role: 'editor', idle });
  it('shows each person once however many tabs they have open', () => {
    const people = uniqueParticipants([person('ana', 'a1', true), person('bo', 'b1'), person('ana', 'a2')]);
    expect(people.map(item => item.id)).toEqual(['ana', 'bo']);
    expect(people[0].connections).toBe(2);
    expect(people[0].idle).toBe(false);
  });
});
