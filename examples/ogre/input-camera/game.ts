// A camera you can fly: the first example whose input comes from a capability.
//
// WASD moves in the facing plane, the mouse turns (yaw and pitch, clamped so
// the camera cannot roll over), escape quits. The whole input path is Tension's
// own: SDL -> tension-input (a DSO) -> the session -> this file ->
// ogre::submitCamera -> the screen. Nothing here uses OGRE's input handling or
// its tutorial framework — the renderer is given a camera record per frame and
// knows nothing else.
//
// The window handle is the guest-mediated exchange INPUT.md §3 Q1 describes:
// `ogre.windowHandle()` answers the XID, and the guest hands it to
// `input.attachToken`, so neither capability learns the other exists.
//
//   ./run.sh                            a window: WASD + mouse, escape quits
//   TENSION_OGRE_HEADLESS=1 ./run.sh    refuses: no window means no input

// The session: the loop, the arena, the event ring, the frame handshake.
import { ConfigBuilder, arg, argCount, makeCallbacks, print, RuntimeSession } from "tension-framework";
// The OGRE SDK under its own path — its ConfigBuilder is a different one.
import * as ogre from "tension-framework/assembly/ogre";
// The input capability's SDK: the six verbs and the state record.
import * as input from "tension-framework/assembly/input";

const WINDOWED_RENDERER = "gl3plus";
const WIDTH = 960;
const HEIGHT = 600;

/// SDL scancodes (the state record's key set is indexed by scancode).
const SCANCODE_ESCAPE = 41;
const SCANCODE_W = 26;
const SCANCODE_A = 4;
const SCANCODE_S = 22;
const SCANCODE_D = 7;

/// Metres per second, and radians per mouse count.
const MOVE_SPEED: f32 = 5.0;
const TURN_SENSITIVITY: f32 = 0.0022;
const PITCH_LIMIT: f32 = 1.35; // ~77 degrees, so the camera never flips
/// The loop waits 16 ms per epoch, so this is the frame's clock — the guest
/// has none of its own (there is no wall clock in the arena).
const FRAME_DT: f32 = 0.016;

function fail(what: string): void {
  print("input-camera: " + what);
  assert(false, what);
}

class Options {
  renderer: string = "null";
  get windowed(): bool { return this.renderer == WINDOWED_RENDERER; }
}

function parseArgs(): Options {
  const options = new Options();
  for (let i: i32 = 0; i < argCount(); i++) {
    const value = arg(i);
    if (value.startsWith("--renderer=")) options.renderer = value.slice(11);
  }
  return options;
}

class Game {
  private options: Options;
  private handle: i32 = 0;
  private stateBuffer: usize = 0;

  // The camera's own state: where it is, and where it looks.
  private x: f32 = 0.0;
  private y: f32 = 2.5;
  private z: f32 = 14.0;
  private yaw: f32 = 0.0;
  private pitch: f32 = -0.15;

  constructor(options: Options) {
    this.options = options;
  }

  run(): void {
    this.openSession();
    this.openRenderer();

    if (!this.options.windowed) {
      // No window, so no surface to attach: the example refuses rather than
      // pretending. This is the headless shape the other examples use.
      print("input-camera: renderer=null — there is no window to attach input to.");
      print("input-camera: run WITHOUT TENSION_OGRE_HEADLESS to fly the camera.");
      return;
    }

    this.buildScene();
    this.attachInput();
    this.loop();
  }

  private openSession(): void {
    const callbacks = makeCallbacks(null, null);
    if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
      fail("session_open refused");
    }
  }

  private openRenderer(): void {
    const windowed = this.options.windowed;
    const config = new ogre.ConfigBuilder()
      .renderer(windowed ? ogre.Renderer.Gl3Plus : ogre.Renderer.Null)
      .headless(!windowed)
      .vsync(false)
      .frameHz(60)
      .windowSize(WIDTH, HEIGHT);
    const started = ogre.init(config);
    if (started != 0) fail("ogre::init refused the config (" + started.toString() + ")");
  }

  /// A grid of coloured markers to fly through. One triangle mesh (built from
  /// nine numbers, like hello-triangle) is reused by every renderable, and two
  /// unlit materials alternate so the grid reads as structure rather than noise.
  private buildScene(): void {
    const mesh = ogre.MeshBuilder.triangle(0.0, -1.0, 0.0, 0.9, 1.0, 0.0, -0.9, 1.0, 0.0);
    if (mesh <= 0) fail("MeshBuilder.triangle refused (" + mesh.toString() + ")");
    while (ogre.resourceState(mesh) != ogre.RES_STATE_READY) {
      if (ogre.resourceState(mesh) == ogre.RES_STATE_FAILED) fail("the marker mesh was never built");
      RuntimeSession.wait(5);
    }

    const warm = ogre.Material.unlit(0.95, 0.45, 0.15);
    warm.materialId = 1;
    if (ogre.submitMaterial(warm) != 0) fail("submitMaterial refused (warm)");
    const cool = ogre.Material.unlit(0.15, 0.45, 0.95);
    cool.materialId = 2;
    if (ogre.submitMaterial(cool) != 0) fail("submitMaterial refused (cool)");

    // 4 columns x 3 rows, 2.5 m apart, markers 1.6 m tall, floating at 0.8 m.
    let id: u32 = 1;
    for (let row: i32 = 0; row < 3; row++) {
      for (let col: i32 = 0; col < 4; col++) {
        const material = (<u32>(row + col) & 1) == 0 ? 1 : 2;
        const marker = ogre.Renderable.at(
          mesh, material, <f32>(col * 2.5 - 3.75), 0.8, <f32>(-row * 2.5 + 2.5), 1.0);
        marker.renderableId = id++;
        if (ogre.submitRenderable(marker) != 0) fail("submitRenderable refused");
      }
    }
  }

  /// The guest-mediated handoff: the renderer's XID from `ogre.windowHandle()`,
  /// handed to the input capability. The window comes up on the render thread,
  /// so the handle is polled for a bounded time rather than assumed.
  private attachInput(): void {
    let token: u64 = 0;
    for (let waited: i32 = 0; waited < 600 && token == 0; waited++) {
      token = ogre.windowHandle();
      if (token == 0) RuntimeSession.wait(16);
    }
    if (token == 0) fail("no window handle arrived within ~10 s");

    const handle = input.open(0);
    if (handle <= 0) fail("input_open refused (" + handle.toString() + ")");
    this.handle = handle;

    const attached = input.attachToken(handle, input.Kind.X11Window, token);
    if (attached != 0) fail("input_attach refused (" + attached.toString() + ")");
    const relative = input.setRelative(handle, true);
    if (relative != 0) fail("input_set_relative refused (" + relative.toString() + ")");

    this.stateBuffer = heap.alloc(input.STATE_SIZE);
    print("input-camera: flying. WASD moves, the mouse turns, escape quits.");
  }

  /// One epoch per frame: wait, read the state, move and turn, submit.
  private loop(): void {
    let frames: u32 = 0;
    while (true) {
      RuntimeSession.wait(16);
      if (input.state(this.handle, this.stateBuffer) <= 0) {
        fail("input_state refused — is the capability still attached?");
      }
      const state = input.InputState.read(this.stateBuffer);

      // Turning first: the mouse delta is per-epoch, so this consumes exactly
      // the motion since the last frame and nothing else.
      this.yaw -= state.mouseDxf * TURN_SENSITIVITY;
      this.pitch -= state.mouseDyf * TURN_SENSITIVITY;
      if (this.pitch > PITCH_LIMIT) this.pitch = PITCH_LIMIT;
      else if (this.pitch < -PITCH_LIMIT) this.pitch = -PITCH_LIMIT;

      // WASD in the facing plane: forward is the yaw direction, right is it
      // rotated a quarter turn, and the pitch does not lift the walk.
      const sy: f32 = <f32>Math.sin(<f64>this.yaw);
      const cy: f32 = <f32>Math.cos(<f64>this.yaw);
      const forwardX = -sy, forwardZ = -cy;
      const rightX = cy, rightZ = -sy;
      let moveX: f32 = 0.0;
      let moveZ: f32 = 0.0;
      if (state.keyHeld(SCANCODE_W)) { moveX += forwardX; moveZ += forwardZ; }
      if (state.keyHeld(SCANCODE_S)) { moveX -= forwardX; moveZ -= forwardZ; }
      if (state.keyHeld(SCANCODE_D)) { moveX += rightX; moveZ += rightZ; }
      if (state.keyHeld(SCANCODE_A)) { moveX -= rightX; moveZ -= rightZ; }
      const length: f32 = <f32>Math.sqrt(<f64>(moveX * moveX + moveZ * moveZ));
      if (length > 0.0001) {
        this.x += (moveX / length) * MOVE_SPEED * FRAME_DT;
        this.z += (moveZ / length) * MOVE_SPEED * FRAME_DT;
      }

      if (state.keyHeld(SCANCODE_ESCAPE)) break;

      // The camera record: yaw about Y, then pitch about the camera's own X,
      // as one quaternion (the renderer takes orientation, not angles).
      const half_yaw: f64 = <f64>this.yaw * 0.5;
      const half_pitch: f64 = <f64>this.pitch * 0.5;
      const cyq: f32 = <f32>Math.cos(half_yaw);
      const syq: f32 = <f32>Math.sin(half_yaw);
      const cpq: f32 = <f32>Math.cos(half_pitch);
      const spq: f32 = <f32>Math.sin(half_pitch);
      const camera = ogre.CameraRecord.perspective(
        45.0 * (3.14159265358979 / 180.0), <f32>WIDTH / <f32>HEIGHT, 0.1, 200.0,
        this.x, this.y, this.z);
      camera.cameraId = 1;
      camera.rotationX = cyq * spq;
      camera.rotationY = syq * cpq;
      camera.rotationZ = -syq * spq;
      camera.rotationW = cyq * cpq;
      if (ogre.submitCamera(camera) != 0) fail("submitCamera refused");

      frames++;
    }

    print("input-camera: " + frames.toString() + " frames, camera at (" +
          this.x.toString() + ", " + this.y.toString() + ", " + this.z.toString() +
          "), yaw " + this.yaw.toString() + ", pitch " + this.pitch.toString());
  }

  shutdown(): void {
    if (this.handle > 0) input.close(this.handle);
    ogre.shutdown();
    RuntimeSession.close();
  }
}

export function _start_game(): void {
  const game = new Game(parseArgs());
  game.run();
  game.shutdown();
}
