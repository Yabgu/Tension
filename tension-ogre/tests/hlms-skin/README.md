# hlms-skin — the HlmsPbs subclass recipe

A minimal `Ogre::HlmsPbs` subclass that **binds its own matrix buffer and injects its
own shader piece**, with no `SkeletonInstance` anywhere in the path: the caller writes
one record per object, the shader reads it by draw id. This is the reference for the
adapter's v1-removal plan — the guest computes model-space matrices, the adapter binds
them, the vertex shader reads them — landed as measured code so the adapter round
starts from a working mechanism instead of re-deriving it.

**The load-bearing result.** Three Items sharing one mesh, one datablock and **one
scene node** are given three different records. With the channel on they appear in
three different places; with the channel off (`off` argument) they collapse into one:

```
ON : non-background pixels = 3920  columns [60, 259]    ← 3 × 1306, three objects
OFF: non-background pixels = 1306  columns [123, 196]   ← one object
```

3920 = 3 × 1306, and the screen span matches the predicted positions for records
−3, 0, +3 at z = 14. Three identical objects at one node cannot land in three places
unless **each object read its own record**. (`frame checksum` in the output is for
comparing runs of this program against each other; its formula is not stable across
versions of this file.)

## The mechanism, in the order it happens

1. **Register two Hlmses, each on its own slot.** `HlmsPbs` first, the subclass second,
   and the subclass sets `mType = HLMS_USER0` in its constructor. A second provider for
   `HLMS_PBS` is refused at registration
   (`ItemIdentityException: Provider for HLMS type '1' has already been set!`).
2. **Datablock.** `createDatablockImpl` returns an `HlmsPbsDatablock` subclass
   (`HlmsTensionSkin.h`); Items take it with `item->setDatablock()`, and the fill uses it
   to recognise its own renderables.
3. **Buffer.** `ReadOnlyBufferPacked`, `PFG_RGBA32_FLOAT`, created in
   **`_changeRenderSystem( RenderSystem *newRs )`** after the base call — *not* in the
   constructor: an Hlms's `mRenderSystem` is still 0 there (measured), and the base
   establishes its own buffers in the same override
   (`HlmsBufferManager::_changeRenderSystem`). Destroy with
   `VaoManager::destroyReadOnlyBuffer` (`ReadOnlyBufferPacked` has no `destroy()`).
4. **Root layout.** `setupRootLayout( RootLayout &, const size_t tid )` —
   **the `tid` parameter is part of the signature** (`OgreHlms.h:495`); an override
   without it does not override anything. PBS reserved `DescBindingTypes::ReadOnlyBuffer`
   `[0, 1)`, so the subclass widens it to `[0, 2)` and takes slot 1.
5. **Write recipe — one map per pass, never per object.** In `preparePassHash`:

   ```cpp
   mRecords = (float *)mMatrixBuffer->map( 0, kMaxObjects * kRecordFloats, true );
   ```

   then each fill stores its record at `mRecords + baseInstance * 4`. The reason is in
   `GL3PlusBufferInterface::map`: its offset is
   `mInternalBufferStart + elementStart + mInternalNumElements * dynamicCurrentFrame`,
   and `dynamicCurrentFrame` is *always* `(current + 1) % multiplier` — `bAdvanceFrame`
   only decides whether that copy also becomes the current one (`mFinalBufferStart`).
   One `advance = true` call therefore writes to and commits the same copy: the copy
   this pass's draws read.
6. **Read recipe.** Declare the buffer with OGRE's own macro and read it with OGRE's own
   fetch, in the vertex piece:

   ```glsl
   ReadOnlyBufferF( 1, float4, tensionMatrixBuf );
   ...
   float4 rec = readOnlyFetch( tensionMatrixBuf, int( inVs_drawId ) );
   ```

7. **Hook choice: `custom_vs_preTransform`.** The template inserts it at the top of
   `@piece( VertexTransform )` (`800.VertexShader_piece_vs.any:219`), before
   `outVs_Position = mul( worldPos, passBuf.viewProj );` (`:236`), so `worldPos` is in
   scope and a displacement affects the transform on both axes.
8. **The channel: `inVs_drawId` = the value `fillBuffersForV2` returns.** That value is
   the object's const-buffer vec4 index
   (`OgreHlmsPbs.cpp`: `((mCurrentMappedConstBuffer - mStartMappedConstBuffer) >> 2u) - 1u`).
   `RenderQueue` stores it as the draw's `baseInstance`
   (`OgreRenderQueue.cpp:794`; `baseInstanceShift` is 0 unless instanced stereo is on),
   and `drawId` is a vertex buffer of `0..N-1` bound as an instanced attribute at
   location 15 with divisor 1 (`GL3PlusVaoManager.cpp:183`, `:1163`). Measured: 0, 1, 2
   for three Items.

## The three failures that cost the most time

1. **A hand-written `samplerBuffer` never receives the data.** Under GL3Plus, OGRE binds
   a `ReadOnlyBufferPacked` as an **SSBO** — PBS declares its own world-matrix buffer as
   `ReadOnlyBufferF( 0, float4, worldMatBuf )`, i.e. `layout(std430, binding = 0) readonly
   restrict buffer`, read with `readOnlyFetch` (`bufferVar[idx]`). A texture buffer is a
   different GL binding namespace, so `layout(binding = 1) uniform samplerBuffer` plus
   `texelFetch` compiled fine and returned 0 for every texel. Use `ReadOnlyBufferF` +
   `readOnlyFetch`.
2. **`custom_vs_posExecution` runs after the transform.** The GLSL template is
   `custom_vs_preExecution; DefaultBodyVS; custom_vs_posExecution;`
   (`Media/Hlms/Pbs/GLSL/VertexShader_vs.glsl:71-74`), so posExecution runs after
   `outVs_Position` has been computed — a write to `outVs.pos` there moves the lighting,
   not the geometry, and frames come back byte-identical. Use `custom_vs_preTransform`.
3. **One map per pass, not one per object.** `upload()` maps with `bAdvanceFrame = true`
   on every call (`BufferInterface::upload`), so two objects rotate the ring twice and
   the draw reads the last copy — both objects then read the *same* record, which looks
   exactly like "the channel does not work". `map( ..., false )` is also wrong: it
   targets a copy one ahead of the one being drawn, so nothing changed on screen at all.
   A single whole-range `map( 0, N, true )` per pass is the only shape that works.

## The no-skeleton state

A mesh can carry blend data with no resolvable skeleton: `mesh->hasSkeleton() == true`,
`mesh->getSkeleton() == NULL`, `item->getSkeletonInstance() == NULL`,
`subitem->hasSkeletonAnimation() == true`, and a blend-index map of size 32. **Unmodified
PBS segfaults on it**, because the fill dereferences the skeleton unconditionally for any
renderable with `hasSkeletonAnimation()`:

```
HlmsPbs.cpp:3528    SkeletonInstance *skeleton = queuedRenderable.movableObject->getSkeletonInstance();
HlmsPbs.cpp:3576    const SimpleMatrixAf4x3 &mat4x3 = skeleton->_getBoneFullTransform( *itBone );
```

Calling the base fill therefore cannot survive that state, and **skipping the base fill is
not free**: the base's return value *is* the object identity the shader indexes with, so a
fill that skips it must still produce a valid const-buffer slot and identity, and still
write the non-skeleton per-object block (roughly `HlmsPbs.cpp:3390-3688`, with the shared
tail at `:3684-3755` producing the return value at `:3752`). The adapter round has to
decide between reproducing that block and shimming it — it is not a one-line guard either
way. This reference does **not** implement it; the fill calls the base.

## Vulkan

The plugin is installed (`/usr/lib/OGRE-Next/RenderSystem_Vulkan.so.4.0`) and exports its
entry points, but it cannot be loaded: it has **no `DT_NEEDED` entry for glslang**, so
`_ZN7glslang8TProgram10getInfoLogEv` is unresolved at dynamic load and
`Root::setRenderSystem` aborts with `Could not load dynamic library
/usr/lib/OGRE-Next/RenderSystem_Vulkan`. The system `libglslang.so.16.4.0` does export
that exact symbol. This is a packaging defect in the Arch AUR `ogre-next-git` package —
not OGRE-Next issue #530, and not a Tension problem. The fix belongs in the PKGBUILD
(record the glslang dependency); nothing here needs changing. Passing
`"Vulkan Rendering Subsystem"` as the render system argument is supported by `main.cc`
and currently fails at that point, before any subclass code runs.

## How to build and run

Prerequisites: OGRE-Next 3.0 headers and libraries (`pkg-config OGRE-Next`), the GL3Plus
plugin and the OGRE media at `/usr/share/OGRE-Next/Media`, and a display.

```sh
# 1. build
bash tension-ogre/tests/hlms-skin/build.sh
#    → tension-ogre/build/hlms-skin/hlms-skin   (build/ is gitignored)

# 2. stage a resource directory: a *v2* mesh plus its sibling skeleton.
#    The fixture mesh in tests/resources is v1; the v2 API needs the conversion.
mkdir -p /tmp/hlms-skin/res && cd /tmp/hlms-skin/res
cp <repo>/tension-ogre/tests/resources/meshes/characterMedium.mesh .
cp <repo>/tension-ogre/tests/resources/meshes/characterMedium.skeleton .
printf 'PluginFolder=/usr/lib/OGRE-Next\nPlugin=RenderSystem_NULL\n' > plugins_tools.cfg
OgreMeshTool -v2 characterMedium.mesh characterMedium-v2.mesh
#    OgreMeshTool reads plugins_tools.cfg from the *working directory*; without it the
#    tool dies with "Cannot initialise - no render system has been selected".

# 3. the two runs that matter
<repo>/tension-ogre/build/hlms-skin/hlms-skin /tmp/hlms-skin/res 10
<repo>/tension-ogre/build/hlms-skin/hlms-skin /tmp/hlms-skin/res 10 "" off
```

Expected: the first prints three blobs totalling ≈ 3 × 1306 non-background pixels, the
second one blob of ≈ 1306.

Other arguments: `hlms-skin <resdir> [frames] [render-system] [off]`. The per-fill log
line (`TENSION-SKIN fill: baseInstance=N record=(...)`) goes to the run's `Ogre.log`
under `/tmp/hlms-skin/run-*/`, and the compiled vertex shader variant is dumped to
`/tmp/hlms-skin/dump/` for inspection — grep it for `TENSION-SKIN` and for
`ReadOnlyBufferF( 1`.

## Why this is not in `run.sh`

`tension-ogre/tests/run.sh` builds the adapter and runs guest fixtures through the
interpreter; its default cases are headless and its one windowed case is opt-in
(`TENSION_OGRE_WINDOW_TEST=1`). This program is the opposite: it needs the full OGRE
render stack, a GL context, a display, the OGRE media and an `OgreMeshTool`-converted
asset, and it measures pixels. Adding it to `run.sh` would make a CI path depend on all
of that. It stays a manually run probe, like the other `tests/probe_*.cpp` binaries, and
this directory exists rather than a flat file because the recipe needs a README beside it.

## What this is not

Not the adapter: no v1-removal, no matrices, no skinning. The "matrices" are one vec4 per
object whose x component is a deliberate displacement, chosen so the proof is visible on
screen. Swapping that record for a real bone-matrix array — folded with the inverse bind
pose, in the layout the shader reads — is the adapter's job.
