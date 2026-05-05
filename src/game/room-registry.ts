// Room registry — declarative metadata about each room in the world.
//
// The actual tile layouts live in src/game/zones.ts (and src/game/rooms.ts
// is the shim that exposes the interior zone's tiles). This file adds the
// bits that the UI needs: display label, one-line description, and tags
// that categorize what kind of behaviors route there.
//
// To add a new room:
//   1. Add layout tiles + anchors in src/game/zones.ts
//   2. Add a `RoomId` literal in src/events/types.ts
//   3. Append a RoomDef entry below
//   4. Reference the room from any behavior in src/game/behaviors.ts
//
// Tags are non-authoritative — they document the intent of each room, so
// a dev adding a behavior can do `findRoomByTag("editing")` rather than
// hard-coding "coding_room".

import type { RoomId } from "../events/types";

export interface RoomDef {
  id: RoomId;
  label: string;
  description: string;
  // Free-form tags. Behaviors can look up rooms by tag.
  tags: string[];
}

export const ROOMS: RoomDef[] = [
  {
    id: "desk",
    label: "Ops Center",
    description:
      "Central terminal bay. Agents come here to think, plan, or wait on the user.",
    tags: ["idle", "thinking", "planning", "home"],
  },
  {
    id: "coding_room",
    label: "IDE",
    description:
      "Editing stations. Where agents go to write or modify code.",
    tags: ["editing", "writing", "code"],
  },
  {
    id: "library",
    label: "Knowledge Base",
    description:
      "Search stacks. Where agents read files and grep through the codebase.",
    tags: ["reading", "searching", "research", "code"],
  },
  {
    id: "tool_workshop",
    label: "Build Bay",
    description:
      "Bench rack. Where agents go to run shell commands or spin up tools.",
    tags: ["bash", "tool", "web", "api"],
  },
  {
    id: "testing_lab",
    label: "Test Rig",
    description:
      "Verification rig. Where agents come to run tests and confirm behavior.",
    tags: ["testing", "trials", "verify"],
  },
  {
    id: "cinema",
    label: "Lounge",
    description:
      "Off-duty. Agents chill here when they have nothing to do, waiting to be called.",
    tags: ["idle", "rest", "chill"],
  },
];

export function roomById(id: RoomId): RoomDef | undefined {
  return ROOMS.find((r) => r.id === id);
}

export function roomsByTag(tag: string): RoomDef[] {
  return ROOMS.filter((r) => r.tags.includes(tag));
}

/**
 * Find the first room that carries a given tag. Used by behaviors that want
 * to say "any 'editing' room" without hard-coding an id — so if we later
 * rename `coding_room` to `scriptorium_room`, or split it across two rooms,
 * the behavior keeps working.
 */
export function findRoomByTag(tag: string): RoomId | undefined {
  const match = ROOMS.find((r) => r.tags.includes(tag));
  return match?.id;
}
