// Second demo: exercises the framework's world-graph abstractions (Room,
// GameNode, Engine). Pipe commands on stdin: look, go <dir>, quit.

import { Engine, GameNode, Room, print } from "tension-framework";

export function _start_game(): void {
  let node = new GameNode("hall");
  node.addRoom(
    new Room("hall", "You are in a dusty hall.")
      .addExit("kitchen", "kitchen")
      .addExit("cellar", "cellar")
  );
  node.addRoom(
    new Room("kitchen", "A warm kitchen; a kettle whistles.")
      .addExit("hall", "hall")
  );
  node.addRoom(
    new Room("cellar", "Dark and cold. Something rustles.")
      .addExit("hall", "hall")
  );
  let engine = new Engine(node);
  print("Welcome to the TensionCore engine demo.");
  engine.run();
}
