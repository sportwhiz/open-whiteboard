import { describe, expect, it } from 'vitest';
import { mentionedIds, mentionMatches, mentionQuery } from './MentionPicker';

const people = [
  { id: 'mia', name: 'Mia Member', username: 'mia', color: '#222222' },
  { id: 'max', name: 'Max Power', username: null, color: '#333333' },
  { id: 'olive', name: 'Olive Owner', username: 'olive', color: '#111111' },
];

describe('@mention picker', () => {
  it('finds the query being typed before the caret', () => {
    expect(mentionQuery('Hi @mi', 6)).toEqual({ query: 'mi', start: 3 });
    expect(mentionQuery('Hi @Mia Me', 10)).toEqual({ query: 'Mia Me', start: 3 });
    expect(mentionQuery('mail me@example', 15)).toBeNull();
    expect(mentionQuery('no mention', 10)).toBeNull();
  });
  it('matches names and usernames, best first', () => {
    expect(mentionMatches(people, 'm').map(person => person.id)).toEqual(['max', 'mia']);
    expect(mentionMatches(people, 'power').map(person => person.id)).toEqual(['max']);
    expect(mentionMatches(people, 'oli').map(person => person.id)).toEqual(['olive']);
  });
  it('reads who was mentioned by name or username', () => {
    expect(mentionedIds('Thanks @Mia Member and @olive', people).sort()).toEqual(['mia', 'olive']);
  });
});

describe('whole-name mentions', () => {
  const people = [
    { id: 'mia', name: 'Mia', username: null, color: '#000000' },
    { id: 'miam', name: 'Mia Member', username: null, color: '#000000' },
    { id: 'al', name: 'Al', username: null, color: '#000000' },
  ];
  it('prefers the longest name and ignores partial words', () => {
    expect(mentionedIds('Thanks @Mia Member', people)).toEqual(['miam']);
    expect(mentionedIds('Ask @Alice', people)).toEqual([]);
    expect(mentionedIds('@Mia, and @Al.', people).sort()).toEqual(['al', 'mia']);
  });
});

describe('email boundaries', () => {
  it('does not send mention recipients for addresses or handles inside words', () => {
    const people = [{ id: 'alice', name: 'Alice', color: '#000' }];
    expect(mentionedIds('Email hello@alice.example or é@Alice, not a mention', people)).toEqual([]);
    expect(mentionedIds('Ask (@Alice) or @Alice.', people)).toEqual(['alice']);
  });
});
