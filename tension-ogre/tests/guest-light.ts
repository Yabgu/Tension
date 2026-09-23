// The lighting smoke fixture (chunk 10, round 10a): does the frozen wire carry
// a light end to end?
//
// No pixels. The rendering questions are the C++ probe's — `probe_light.cpp`,
// whose numbers are in DESIGN.md §5.1 — and what this fixture adds is the thing
// a probe cannot: that the *guest's* path to a light is the shipped one. It
// opens a session, submits a `LightRecord.directional(...)` through the
// `submitLight` the SDK exports (the generic submit verb with the light table
// kind), asserts the verb accepted it, re-reads the region slot it wrote, and
// closes. If the wire, the record size or the table offset ever move, this is
// the smallest thing that notices.
//
// Build and run (from the repo root):
//   tension-framework/node_modules/.bin/asc tension-ogre/tests/guest-light.ts \
//       --config tension-framework/build/session.asconfig.json \
//       -o tension-ogre/build/guest-light.wasm
//   tension-core/target/debug/tension-core \
//       --capability tension-ogre/build/libtension_ogre.so \
//       tension-ogre/build/guest-light.wasm --renderer=null

import { print } from "../../tension-framework/assembly/io";
import { ConfigBuilder, RuntimeSession, makeCallbacks } from "../../tension-framework/assembly/runtime";
import * as ogre from "../../tension-framework/assembly/ogre";
import { LightRecord, assertOgreWireOffsets } from "../../tension-framework/assembly/ogre/wire";
import { regionOffset } from "../../tension-framework/assembly/runtime/arena";
import { REGION_SCENE } from "../../tension-framework/assembly/runtime/wire";

export function _start_game(): void {
  assertOgreWireOffsets(); // the offsets this fixture reads back are the wire's
  const callbacks = makeCallbacks(null, null);
  if (RuntimeSession.open(ConfigBuilder.forThisBuild(callbacks), callbacks) != 0) {
    print("FAIL session_open refused");
    assert(false, "session_open");
  }
  if (ogre.init(new ogre.ConfigBuilder().renderer(ogre.Renderer.Null).headless(true).frameHz(60)
                   .windowSize(64, 64)) != 0) {
    print("FAIL ogre::init refused");
    assert(false, "ogre::init");
  }

  // A directional light from +x, the probe's own geometry: the direction a
  // shading test can check against a lit hemisphere.
  const light = LightRecord.directional(<f32>1.0, <f32>1.0, <f32>1.0, <f32>20.0,
                                        <f32>-1.0, <f32>0.0, <f32>0.0);
  light.lightId = 7;
  const rc = ogre.submitLight(light);
  print("LIGHT submitLight(id=7, directional, intensity 20) -> " + rc.toString());

  // Read the record back out of the region the SDK wrote it into: the same bytes
  // the adapter's `submit` shim decodes and the mirror stores. A record that
  // crosses the wire has to come back out of it unchanged, or the smoke test is
  // only testing the SDK's own encoder.
  const base = regionOffset(REGION_SCENE) + ogre.SCENE_LIGHT_BASE + (7 - 1) * ogre.SCENE_LIGHT_SIZE;
  const kind = load<u32>(base + 4);
  const colourR = load<f32>(base + 16);
  const intensity = load<f32>(base + 32);
  const directionX = load<f32>(base + 48);
  print("LIGHT region read-back: kind " + kind.toString() + " (LIGHT_DIRECTIONAL = " +
        ogre.LIGHT_DIRECTIONAL.toString() + "), colourR " + colourR.toString() +
        ", intensity " + intensity.toString() + ", directionX " + directionX.toString());
  if (rc != 0 || kind != ogre.LIGHT_DIRECTIONAL || colourR != 1.0 || intensity != 20.0 ||
      directionX != -1.0) {
    print("FAIL the light record did not survive the round trip");
    assert(false, "light round trip");
  }

  // A second submit of the same id is an upsert, not a duplicate: the verb
  // takes an id and a mode, and a guest that moves a light each frame relies on
  // that.
  light.directionY = <f32>-1.0;
  const rc2 = ogre.submitLight(light);
  const directionY = load<f32>(base + 52);
  print("LIGHT upsert -> " + rc2.toString() + ", directionY is now " + directionY.toString());
  if (rc2 != 0 || directionY != -1.0) {
    print("FAIL the upsert did not replace the record");
    assert(false, "light upsert");
  }

  // And the range check the SDK does before the verb: id 0 and an id past the
  // table are refused without a call.
  const bad = LightRecord.directional(<f32>1.0, <f32>1.0, <f32>1.0, <f32>1.0, <f32>0.0, <f32>-1.0,
                                      <f32>0.0);
  bad.lightId = 0;
  print("LIGHT submitLight(id=0) -> " + ogre.submitLight(bad).toString() + " (-22 is -EINVAL)");

  ogre.shutdown();
  RuntimeSession.close();
  print("OK lighting smoke: the wire carries a light, the region holds it, upsert replaces it");
}
