# hlms-skin — the HlmsPbs subclass recipe

## What this is

A minimal `Ogre::HlmsPbs` subclass that brings its own matrix buffer and its own vertex
shader piece, so data computed **outside** OGRE's skeleton system reaches the PBS vertex
shader — the mechanism the adapter needs to feed guest-computed bone matrices to OGRE-Next
without a `SkeletonInstance` anywhere in the path. It is landed as measured code, together
with the recipe that produced it, so the adapter round starts from a working mechanism
instead of re-deriving one. The records it carries are stand-ins, not bone matrices: each is
one vec4 whose x component displaces its object, chosen so the per-object channel is visible on
screen. Swapping a record for a real bone-matrix array is the adapter's work; nothing else in
the mechanism changes.

## The mechanism, in order

1. **Register order.** `HlmsPbs` first, the subclass second, each on its own `HlmsTypes`
   slot: the subclass sets `mType = HLMS_USER0` in its constructor. A second provider for
   `HLMS_PBS` is refused at registration
   (`ItemIdentityException: Provider for HLMS type '1' has already been set!`).
2. **Datablock.** `createDatablockImpl` returns an `HlmsPbsDatablock` subclass
   (`HlmsTensionSkin.h`). The Item selects the Hlms **through its datablock**; the fill
   uses the datablock type to recognise its own renderables.
3. **Buffer.** `ReadOnlyBufferPacked`, `PFG_RGBA32_FLOAT`, created in
   **`_changeRenderSystem( RenderSystem *newRs )`** *after* the base call — not in the
   constructor, where `mRenderSystem` is still 0 (measured), and not before the base, which
   establishes its own buffers there (`HlmsBufferManager::_changeRenderSystem`). Destroy it
   with `VaoManager::destroyReadOnlyBuffer`; `ReadOnlyBufferPacked` has no `destroy()`.
4. **Root layout.** `setupRootLayout( RootLayout &, const size_t tid )` — the `tid`
   parameter is part of the signature (`OgreHlms.h:495`), and an override without it
   overrides nothing. PBS reserves `DescBindingTypes::ReadOnlyBuffer` `[0, 1)`, so the
   subclass widens it to `[0, 2)` and takes slot 1 for itself.
5. **Write: ONE whole-range map per pass.** In `preparePassHash`:

   ```cpp
   mRecords = (float *)mMatrixBuffer->map( 0, kMaxObjects * kRecordFloats, true );
   ```

   then each fill stores its record with plain stores at
   `mRecords + baseInstance * kRecordFloats`. **Never `upload()`, never a per-object map.**
   The reason is `GL3PlusBufferInterface::map`: its offset is
   `mInternalBufferStart + elementStart + mInternalNumElements * dynamicCurrentFrame`, and
   `dynamicCurrentFrame` is *always* `(current + 1) % multiplier` — `bAdvanceFrame` only
   decides whether that copy also becomes the current one (`mFinalBufferStart`). One
   `advance = true` call therefore writes to **and** commits the copy this pass's draws
   read; any other shape writes to a copy nobody draws from.
6. **Read.** Declare the buffer with OGRE's own macro and fetch with OGRE's own macro, in
   the vertex piece:

   ```glsl
   ReadOnlyBufferF( 1, float4, tensionMatrixBuf );
   ...
   float4 rec = readOnlyFetch( tensionMatrixBuf, int( inVs_drawId ) );
   ```

   Apply it in **`custom_vs_preTransform`**, on `worldPos` — not in
   `custom_vs_posExecution`.
7. **Channel: `inVs_drawId` = the value `fillBuffersForV2` returns** = the object's
   const-buffer vec4 index
   (`OgreHlmsPbs.cpp`: `((mCurrentMappedConstBuffer - mStartMappedConstBuffer) >> 2u) - 1u`).
   `RenderQueue` stores it as the draw's `baseInstance` (`OgreRenderQueue.cpp:794`;
   `baseInstanceShift` is 0 unless instanced stereo is on), and `drawId` is a vertex buffer
   of `0..N-1` bound as an instanced attribute at location 15 with divisor 1
   (`GL3PlusVaoManager.cpp:183`, `:1163`). Measured: **0, 1, 2** for three Items.

   The proof that the channel is per-object, with three Items sharing one mesh, one
   datablock and **one scene node**:

   ```
   ON : non-background pixels = 3920  columns [60, 259]    ← 3 × 1306, three objects
   OFF: non-background pixels = 1306  columns [123, 196]   ← one object
   ```

   Three identical objects at one node cannot land in three places unless each object read
   its own record. 3920 = 3 × 1306, and the span matches the predicted screen positions for
   records −3, 0, +3 at z = 14.

## The failures that cost the most time

- **A hand-written `samplerBuffer` never receives the data.** Under GL3Plus, OGRE binds a
  `ReadOnlyBufferPacked` as an **SSBO**: PBS declares its own world-matrix buffer as
  `ReadOnlyBufferF( 0, float4, worldMatBuf )`, which expands to
  `layout(std430, binding = 0) readonly restrict buffer`, read with `readOnlyFetch`
  (`bufferVar[idx]`). A texture buffer lives in a different GL binding namespace, so
  `layout(binding = 1) uniform samplerBuffer` plus `texelFetch` compiled cleanly and
  returned 0 for every texel. Use `ReadOnlyBufferF` + `readOnlyFetch`.
- **`custom_vs_posExecution` runs after the transform.** The GLSL template is
  `custom_vs_preExecution; DefaultBodyVS; custom_vs_posExecution;`
  (`Media/Hlms/Pbs/GLSL/VertexShader_vs.glsl:71-74`), so posExecution runs *after*
  `outVs_Position` has been computed: a write to `outVs.pos` there moves the lighting, not
  the geometry, and two runs come back byte-identical. `custom_vs_preTransform` sits at the
  top of `@piece( VertexTransform )` (`800.VertexShader_piece_vs.any:219`), before
  `outVs_Position = mul( worldPos, passBuf.viewProj );` (`:236`), where `worldPos` is in
  scope.
- **`upload()` rotates a ring buffer per call.** `BufferInterface::upload` maps with
  `bAdvanceFrame = true`, so every call advances the ring; two objects rotate it twice and
  the draw reads only the last copy — both objects then read the *same* record, which looks
  exactly like "the channel does not work". `map( ..., false )` is also wrong: it targets a
  copy one ahead of the one being drawn, so nothing changes on screen at all. One
  whole-range `map( 0, N, true )` per pass is the only shape that works.
- **`lower_gpu_overhead` is not a way to get the instance struct.** The reference set it to
  bring `worldMaterialIdx[]` (and with it `inVs_drawId`) into the variant, which does work —
  but the same property switches the PBS *pixel* shader to `#define material
  materialArray[0]` (`800.PixelShader_piece_ps.any:191`), so every object in the pass shades
  with the **first** datablock's constants. A one-datablock scene cannot see this (slot 0 is
  then the correct answer), which is why the probe did not; the adapter port did, as
  different pixel numbers for an unchanged scene. For the rigged meshes this Hlms draws the
  property is unnecessary anyway — `hlms_skeleton` is already on, and that alone declares the
  instance struct (`800.VertexShader_piece_vs.any:22`). Expect this problem again in the
  no-skeleton state, where `hlms_skeleton` is off by definition and the variant still needs
  `inVs_drawId`.

## The no-skeleton mesh state

A v2 mesh with blend data but no resolvable skeleton — `mesh->getSkeleton() == NULL`,
`item->getSkeletonInstance() == NULL`, `subitem->hasSkeletonAnimation() == true`, blend-index
map of size 32 — **crashes unmodified PBS**: the fill dereferences the skeleton
unconditionally for any renderable with `hasSkeletonAnimation()`
(`OgreHlmsPbs.cpp:3528` `SkeletonInstance *skeleton = queuedRenderable.movableObject->getSkeletonInstance();`
and `:3571` `... skeleton->_getBoneFullTransform( *itBone )`). Measured, under gdb:

```
#0  std::vector<Ogre::Bone>::size (...)          at OgreHlmsPbs.cpp:3571
#2  Ogre::SkeletonInstance::_getBoneFullTransform (this=...) at OgreSkeletonInstance.h:163
#3  Ogre::HlmsPbs::fillBuffersFor (...)          at OgreHlmsPbs.cpp:3571
#4  Ogre::HlmsPbs::fillBuffersForV2 (...)        at OgreHlmsPbs.cpp:3136
#5  Ogre::HlmsTensionSkin::fillBuffersForV2 (...) at HlmsTensionSkin.cpp:210
```

— our fill's call into the base is frame #5; the NULL `this` is dereferenced inside
`_getBoneFullTransform`. That state is exactly what a mesh with no `.skeleton` file
produces, which is the target for v1-removal, so the adapter's fill will have to
**skip the base fill for such meshes** — and that is not free: the base's
return value *is* the object identity the shader indexes with, so a fill that skips it must
still write the non-skeleton per-object block and produce a valid identity (source roughly
`:3390-3688`, shared tail `:3684-3755`, return value at `:3752`). **Size estimate: category
(b)/(c) — bounded but not small; not built, not measured.** This is a known open task for
the adapter round, and this reference does not implement it: the fill calls the base.

## Vulkan

Two measured facts:

- **The mechanism is renderer-independent.** The same source, unchanged, renders identical
  frames on GL3Plus and Vulkan:
  `3920 px, columns [60, 259]` (records on) and `1306 px, columns [123, 196]` (records off)
  on both. No Vulkan-specific code is needed anywhere in the subclass.
- **On this system the plugin cannot be loaded without `LD_PRELOAD`.**
  `/usr/lib/OGRE-Next/RenderSystem_Vulkan.so.4.0` has **no `DT_NEEDED` entry for glslang**
  (`ldd -r` reports 16 unresolved symbols: 15 `glslang::…` plus
  `spv::SpvBuildLogger::getAllMessages()`), so `setRenderSystem()` aborts with
  `Could not load dynamic library … undefined symbol: _ZN7glslang8TProgram10getInfoLogEv`.
  The installed `libglslang.so.16.4.0` **does** define every one of those symbols, so the
  fix is only that the Vulkan target must link them: the AUR `ogre-next-git` PKGBUILD adds
  glslang as a dependency but does not make the render system record it. **That is a
  packaging defect, not a Tension bug** — the fix belongs in the PKGBUILD. Workaround for
  testing:

  ```sh
  LD_PRELOAD=/usr/lib/libglslang.so.16.4.0 ./probe <resdir> 10 "Vulkan Rendering Subsystem"
  ```

  Do **not** add Vulkan-specific code to the subclass. The renderer choice stays GL3Plus by
  default; Vulkan becomes an option once the PKGBUILD links glslang into the plugin.
- **Readback note.** The download-ticket API (`setWantsToDownload(true)` +
  `canDownloadData()` + `Image2::convertFromTexture`) returns an **all-zero image on
  Vulkan** even when the frame is correct. `TextureGpu::writeContentsToFile` works on both
  backends — use the file capture for evidence.

## How to build and run it

Prerequisites: OGRE-Next 3.0 headers and libraries (`pkg-config OGRE-Next`), the GL3Plus
plugin, the OGRE media at `/usr/share/OGRE-Next/Media`, and a display.

```sh
# 1. build — lands `probe` beside these sources (gitignored)
cd tension-ogre/tests/hlms-skin
./build.sh

# 2. stage the resource directories: a v2 mesh with its sibling skeleton, and the
#    same mesh without the skeleton (the no-.skeleton state).
#    The fixture mesh in tests/resources is v1; the v2 API needs the conversion.
mkdir -p /tmp/hlms-skin/withskel /tmp/hlms-skin/noskel
cd /tmp/hlms-skin/withskel
cp <repo>/tension-ogre/tests/resources/meshes/characterMedium.mesh .
cp <repo>/tension-ogre/tests/resources/meshes/characterMedium.skeleton .
printf 'PluginFolder=/usr/lib/OGRE-Next\nPlugin=RenderSystem_NULL\n' > plugins_tools.cfg
OgreMeshTool -v2 characterMedium.mesh characterMedium-v2.mesh
cp characterMedium-v2.mesh ../noskel/          # noskel: the mesh alone, no .skeleton

# 3. the runs
cd <repo>/tension-ogre/tests/hlms-skin
./probe /tmp/hlms-skin/withskel 10                                  # 3 blobs, ~3920 px
./probe /tmp/hlms-skin/withskel 10 "" off                           # 1 blob, ~1306 px
./probe /tmp/hlms-skin/noskel 5                                     # crashes in the base fill
LD_PRELOAD=/usr/lib/libglslang.so.16.4.0 ./probe /tmp/hlms-skin/withskel 10 \
    "Vulkan Rendering Subsystem"                                     # same pixels, GL3Plus == Vulkan
```

The equivalent `OgreMeshTool` invocation on a system where the tool is run from
`/usr/share/OGRE-Next` is the same command with that directory as the working directory —
the tool reads **`plugins_tools.cfg` from the current working directory**, and without it
dies with `Cannot initialise - no render system has been selected`. Run from a directory
you can write to (as above); the file only needs `PluginFolder` and a render-system plugin,
and `RenderSystem_NULL` is enough.

**This probe runs manually, not in `tension-ogre/tests/run.sh`.** That harness builds the
adapter and runs guest fixtures through the interpreter, headless by default, with its one
windowed case opt-in. This program is the opposite: it needs a real GL context, a display,
the OGRE media tree and an `OgreMeshTool`-converted asset, and it asserts on pixels.
Adding it to `run.sh` would put all of that on the default path. It stays a manual probe,
like the other `tests/probe_*.cpp` binaries.

Output of interest: a line per fill (`TENSION-SKIN fill: baseInstance=N record=(…)`) in the
run's `Ogre.log` under `/tmp/hlms-skin/run-*/`, the rewritten variant in
`/tmp/hlms-skin/dump/` (grep it for `TENSION-SKIN` and `ReadOnlyBufferF( 1`), and the frame
itself at `/tmp/hlms-skin/frame-on.png` / `frame-off.png`.

## Operational gotchas

- `setDebugOutputPath` does **not** create its directory; `mkdir` first (the program does).
- `Ogre::Window` (renamed `RenderWindow` in 3.0) has **no `addViewport`** and no
  `writeContentsToFile`; use compositor workspaces and the window-texture download API
  (`OgreWindow.h:174-185`) — or `TextureGpu::writeContentsToFile`, which works on Vulkan
  too.
- `setupRootLayout`'s signature takes `( RootLayout&, const size_t tid )`.
- `ReadOnlyBufferPacked` has no `destroy()`; use `VaoManager::destroyReadOnlyBuffer`.
- `build.sh | grep error` returns 0 through the pipe; the failure is invisible. Check the
  exit status of `build.sh` itself.
- `OgreMeshTool` wants its options **before** the file arguments (`-v2 src dst`); flags
  last fail with a misleading `File <dest> not found`.
- A skinned mesh's conversion needs the sibling `.skeleton` present next to the source
  mesh.
- The program's own scratch is fixed at `/tmp/hlms-skin/` (log, dump, frames) rather than a
  random directory, so the evidence is findable afterwards.

## Shadow-node setup (OGRE-Next 3.0)

A caster pass changes the binding rules, and every trap below cost a run. They were found
while reproducing the caster-pass binding bug (chunk 19): **a subclass that binds its own
buffer must bind it on the caster pass too.** Binding state persists across passes within a
command buffer, so a caster pass that leaves slot 1 holding something else poisons the main
pass that follows — the main pass's own bind does not correct it, and the shader reads
garbage (measured: the rig renders out of frame, 0 non-background pixels, where the same
scene without a shadow node renders three objects at 3920). It is not the caster *shader*
reading the buffer: our piece is not emitted into the caster variant at all — 0 occurrences
in its dump against 4 in the main variant.

- `Light::setDirection` **before** `attachObject` is a **SIGSEGV** (`OgreLight.cpp:131` —
  the setter dereferences the light's node). Attach the light to a scene node first, then
  set its direction.
- The header is `Compositor/Pass/PassScene/OgreCompositorPassSceneDef.h`, not
  `Compositor/OgreCompositorPassSceneDef.h`.
- There is **no explicit `addNode`** for a shadow node in 3.0. The workspace's
  auto-generated node definition is fetched by
  `"AutoGen " + IdString( workspace + "/Node" ).getReleaseText()`, and its
  `CompositorPassSceneDef::mShadowNode` names the shadow node — which must already exist
  (`ShadowNodeHelper::createShadowNodeWithSettings`) when the workspace is created.
  The reference sample is `Samples/2.0/ApiUsage/ShadowMapFromCode/ShadowMapFromCode.cpp`.

### The layout, corrected

`HlmsPbs::setupRootLayout` reserves **`ReadOnlyBuffer [0, 2)`**, `ConstBuffer [0, 3)` and
`TexBuffer [2, 3)` — measured, not assumed. Earlier rounds recorded the first as `[0, 1)`,
which is why this subclass's widening looked necessary and was in fact a **no-op**: slot 1
was already inside the base's own range. The widening stays, because the reservation is
PBS's to change and not ours to assume.
