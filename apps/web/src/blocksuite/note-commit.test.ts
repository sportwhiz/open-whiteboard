import { describe, expect, it } from "vitest";
import { createNoteCommitTracker } from "./note-commit";

describe("note committed after creation", () => {
  it("reports a note I created on its first edit end, once", () => {
    const tracker = createNoteCommitTracker();
    tracker.added("a", true);
    expect(tracker.ended("a", "Idea")).toBe(true);
    expect(tracker.ended("a", "Idea, edited")).toBe(false);
  });
  it("ignores collaborators' notes and notes loaded with the board", () => {
    const tracker = createNoteCommitTracker();
    tracker.added("remote", false);
    tracker.added("loaded", true, true);
    expect(tracker.ended("remote", "Theirs")).toBe(false);
    expect(tracker.ended("loaded", "Old")).toBe(false);
    expect(tracker.ended("never-added", "Old")).toBe(false);
  });
  it("waits for text when the first edit ends empty", () => {
    const tracker = createNoteCommitTracker();
    tracker.added("a", true);
    expect(tracker.ended("a", "  ")).toBe(false);
    expect(tracker.ended("a", "Now with words")).toBe(true);
  });
  it("does not report again when undo and redo bring the note back", () => {
    const tracker = createNoteCommitTracker();
    tracker.added("a", true);
    expect(tracker.ended("a", "Idea")).toBe(true);
    tracker.added("a", true);
    expect(tracker.ended("a", "Idea")).toBe(false);
  });
});
