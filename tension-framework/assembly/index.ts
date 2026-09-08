// AssemblyScript entry for the tension-framework package (ascMain target).
// Re-exports the std:tension/io ABI bindings and the game abstractions.

export { print, readLine, argCount, arg } from "./io";
export { Room, GameNode, Engine } from "./engine";
