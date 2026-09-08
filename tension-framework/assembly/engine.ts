// Game abstractions for the TensionCore text engine.
//
// Provides the node/edge world-graph model (`GameNode`), the location variant
// (`Room`), and the interactive loop (`Engine`). All I/O goes through the
// std:tension/io ABI surfaced by `./io`.

import { print, readLine } from "./io";

/** A location in the world graph: a description plus named exits. */
export class Room {
  name: string;
  description: string;
  exits: Map<string, string>;

  constructor(name: string, description: string) {
    this.name = name;
    this.description = description;
    this.exits = new Map<string, string>();
  }

  addExit(direction: string, target: string): this {
    this.exits.set(direction, target);
    return this;
  }

  describe(): void {
    print(this.name);
    print(this.description);
    print("Exits: " + this.exitList());
  }

  private exitList(): string {
    let dirs = this.exits.keys();
    let out = "";
    for (let i = 0; i < dirs.length; i++) {
      if (out.length > 0) out += ", ";
      out += dirs[i];
    }
    return out;
  }
}

/** The world graph: rooms (vertices) and named exits (edges). */
export class GameNode {
  rooms: Map<string, Room>;
  start: string;

  constructor(start: string) {
    this.start = start;
    this.rooms = new Map<string, Room>();
  }

  addRoom(room: Room): this {
    this.rooms.set(room.name, room);
    return this;
  }
}

/** Interactive text loop over a GameNode. */
export class Engine {
  node: GameNode;
  current: string;

  constructor(node: GameNode) {
    this.node = node;
    this.current = node.start;
  }

  private room(): Room | null {
    if (!this.node.rooms.has(this.current)) return null;
    return this.node.rooms.get(this.current);
  }

  look(): void {
    let r = this.room();
    if (r != null) r.describe();
  }

  go(direction: string): void {
    let room = this.room();
    if (room == null) return;
    if (!room.exits.has(direction)) {
      print("You can't go that way.");
      return;
    }
    let target = room.exits.get(direction);
    if (target != null && this.node.rooms.has(target)) {
      this.current = target;
      let r = this.room();
      if (r != null) r.describe();
    } else {
      print("You can't go that way.");
    }
  }

  run(): void {
    while (true) {
      print("> ");
      let line = readLine();
      if (line.length == 0 || line == "quit") {
        print("Bye.");
        break;
      }
      let trimmed = line.trim();
      let parts = trimmed.split(" ");
      let verb = parts[0];
      let rest = parts.length > 1 ? parts[1] : "";
      if (verb == "look" || verb == "l") this.look();
      else if (verb == "go" || verb == "move") this.go(rest);
      else print("I don't understand \"" + trimmed + "\".");
    }
  }
}
