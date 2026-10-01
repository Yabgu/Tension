// hlms_tension_skin.cpp — see hlms_tension_skin.h for what this is and why
// every choice below is the one the reference measured (chunk 19, round 19a).

#include "hlms_tension_skin.h"

#include <CommandBuffer/OgreCbShaderBuffer.h>
#include <CommandBuffer/OgreCbTexture.h>
#include <CommandBuffer/OgreCommandBuffer.h>
#include <OgreHlmsListener.h>
#include <OgreHlmsManager.h>
#include <OgreLogManager.h>
#include <OgreRenderQueue.h>
#include <OgreRenderable.h>
#include <OgreRenderSystem.h>
#include <Vao/OgreConstBufferPacked.h>
#include <Vao/OgreReadOnlyBufferPacked.h>
#include <Vao/OgreVaoManager.h>

#include <algorithm>
#include <cstring>
#include <string>
#include <vector>

namespace tension_ogre {

using namespace Ogre;
 // NOLINT(google-build-using-namespace) — OGRE's own types are the subject here

HlmsTensionSkin::HlmsTensionSkin(Archive *dataFolder, ArchiveVec *libraryFolders) :
    HlmsPbs(dataFolder, libraryFolders),
    matrix_buffer_bytes_(kMaxObjects * kRecordFloats * sizeof(float)) {
    // A second provider for HLMS_PBS is refused at registration
    // (`ItemIdentityException: Provider for HLMS type '1' has already been
    // set!`), so the subclass takes a slot of its own.
    mType = HLMS_USER0;
    mTypeName = "TensionSkin";
    mTypeNameStr = "TensionSkin";
}

void HlmsTensionSkin::_changeRenderSystem(RenderSystem *newRs) {
    HlmsPbs::_changeRenderSystem(newRs);
    if (newRs == nullptr) return;

    // The buffer is created HERE and not in the constructor: `mRenderSystem` is
    // still null when an Hlms is constructed (measured), and this override is
    // where the base establishes its own buffers too
    // (`HlmsBufferManager::_changeRenderSystem`).
    std::vector<float> zeros(kMaxObjects * kRecordFloats, 0.0f);
    if (matrix_buffer_ != nullptr) {
        records_mapped_ = false;
        records_ = nullptr;
        newRs->getVaoManager()->destroyReadOnlyBuffer(matrix_buffer_);
        matrix_buffer_ = nullptr;
    }
    matrix_buffer_ = newRs->getVaoManager()->createReadOnlyBuffer(
        PixelFormatGpu::PFG_RGBA32_FLOAT, matrix_buffer_bytes_, BT_DYNAMIC_PERSISTENT, zeros.data(),
        false);


    // One line, once per render system: this is what tells a reader that both
    // Hlmses are registered and which slot each one holds.
    LogManager::getSingleton().logMessage(
        std::string("tension-ogre: hlms ") + mTypeNameStr + " registered on type " +
        StringConverter::toString(static_cast<int>(mType)) + " at " +
        StringConverter::toString(reinterpret_cast<size_t>(this)));
}

HlmsCache HlmsTensionSkin::preparePassHash(const CompositorShadowNode *shadowNode, bool casterPass,
                                           bool dualParaboloid, SceneManager *sceneManager) {
    HlmsCache retVal = HlmsPbs::preparePassHash(shadowNode, casterPass, dualParaboloid, sceneManager);

    // ONE map per pass, covering every record, with advanceFrame = true.
    // `GL3PlusBufferInterface::map()` computes its offset as
    //     mInternalBufferStart + elementStart + mInternalNumElements * dynamicCurrentFrame
    // where `dynamicCurrentFrame` is ALWAYS `(current + 1) % multiplier`; only
    // `bAdvanceFrame` decides whether that copy also becomes the current one
    // (`mFinalBufferStart`). So one `advance = true` call writes to *and*
    // commits the copy this pass's draws read. Two alternatives were measured
    // and both fail for multi-object writes: `upload()` maps with
    // `bAdvanceFrame = true` on every call (so every object rotates the ring,
    // and the draw reads the last copy — both objects then read the same
    // record), and `map( …, false )` targets a copy one ahead of the one being
    // drawn, so nothing written is ever visible.
    if (matrix_buffer_ != nullptr) {
        if (records_mapped_) matrix_buffer_->unmap(UO_KEEP_PERSISTENT);
        records_ = reinterpret_cast<float *>(matrix_buffer_->map(0, kMaxObjects * kRecordFloats, true));
        records_mapped_ = (records_ != nullptr);
    }
    return retVal;
}

void HlmsTensionSkin::setupRootLayout(RootLayout &rootLayout, size_t tid) {
    HlmsPbs::setupRootLayout(rootLayout, tid);

    // Measured: PBS's own call already reserves TWO read-only buffer slots
    // (ReadOnlyBuffer [0, 2), ConstBuffer [0, 3), TexBuffer [2, 3)), so slot 1
    // sits inside the base's range and this widening is a no-op today. It stays
    // because the reservation is PBS's to change, not ours to assume.
    DescBindingRange *ranges = rootLayout.mDescBindingRanges[0];
    ranges[DescBindingTypes::ReadOnlyBuffer].end =
        std::max<uint16>(ranges[DescBindingTypes::ReadOnlyBuffer].end, kOurTexBufferSlot + 1u);
}

void HlmsTensionSkin::bind_our_buffer(CommandBuffer *commandBuffer) {
    *commandBuffer->addCommand<CbShaderBuffer>() =
        CbShaderBuffer(VertexShader, kOurTexBufferSlot, matrix_buffer_, 0, 0);
}

HlmsDatablock *HlmsTensionSkin::createDatablockImpl(IdString datablockName,
                                                    const HlmsMacroblock *macroblock,
                                                    const HlmsBlendblock *blendblock,
                                                    const HlmsParamVec &paramVec) {
    return OGRE_NEW HlmsTensionSkinDatablock(datablockName, this, macroblock, blendblock, paramVec);
}

void HlmsTensionSkin::calculateHashFor(Renderable *renderable, uint32_t &outHash,
                                       uint32_t &outCasterHash) {
    HlmsPbs::calculateHashFor(renderable, outHash, outCasterHash);
    if (getProperty("tension_skinning")) {
        outHash |= 1u << 31;
        outCasterHash |= 1u << 31;
    }
}

void HlmsTensionSkin::calculateHashForPreCreate(Renderable *renderable, PiecesMap *inOutPieces) {
    // The base first. For a mesh with blend data and no SkeletonInstance it is
    // the *fill*, not the hash, that crashes — so this is safe on that state.
    HlmsPbs::calculateHashForPreCreate(renderable, inOutPieces);

    if (dynamic_cast<HlmsTensionSkinDatablock *>(renderable->getDatablock()) == nullptr) return;

    setProperty("tension_skinning", 1);
    // NOT `lower_gpu_overhead`. The reference set it to force the instance
    // struct (`worldMaterialIdx[]`) into the variant, but that property does
    // much more: in the pixel shader's `LoadMaterial` piece
    // (800.PixelShader_piece_ps.any:191) it replaces
    //     ushort materialId = worldMaterialIdx[inPs.drawId].x & 0x1FFu;
    //     #define material materialArray[materialId]
    // with `#define material materialArray[0]` — every object in the pass then
    // shades with the *first* datablock's constants. The reference could not
    // catch this because its scene had exactly one datablock, for which slot 0
    // is also the right answer. Measured here: with the property set, the
    // animated-character example rendered 17140 non-background pixels with a
    // patch spread of 64.99; without it, 15253 and 48.57 — the numbers the
    // PBS-drawn build produces.
    //
    // It is not needed either: the instance struct is declared when
    // `hlms_skeleton || hlms_shadowcaster || hlms_pose || metal ||
    // lower_gpu_overhead` is on (800.VertexShader_piece_vs.any:22), and every
    // renderable this Hlms draws is a rigged mesh, so `hlms_skeleton` is
    // already on and `inVs_drawId` is available.

    String &decl = inOutPieces[VertexShader][IdString("custom_vs_uniformDeclaration")];
    // NOT `layout(binding = 1) uniform samplerBuffer`: under GL3Plus OGRE binds
    // a ReadOnlyBufferPacked as an SSBO (`layout(std430, …)`, see PBS's own
    // declaration of `worldMatBuf`), and a texture buffer is a different GL
    // binding namespace — a hand-written samplerBuffer compiles and then reads
    // zero for every texel (measured). The name carries the project's prefix so
    // it cannot collide with any buffer OGRE declares.
    decl += "ReadOnlyBufferF( 1, float4, tensionMatrixBuf );\n";

    // `custom_vs_preTransform`, NOT `custom_vs_posExecution`. The template
    // inserts preTransform at the top of `@piece( VertexTransform )`
    // (800.VertexShader_piece_vs.any:219), before
    //     outVs_Position = mul( worldPos, passBuf.viewProj );        (:236)
    // whereas posExecution runs after the whole body, where only the clip
    // position is still live. Here `worldPos` is in scope.
    String &exec = inOutPieces[VertexShader][IdString("custom_vs_preTransform")];
    exec += "// tension-ogre: skin from the guest's matrices, or leave the base's pose alone.\n";
    exec += "{ int tensionBase = int( inVs_drawId ) * " +
            StringConverter::toString(kRecordFloats / 4) + ";\n";
    // The sentinel: the fill sets record[0].w (the first matrix's m30, which is
    // 0 for every affine matrix and unused by the transform) to 1 when the guest
    // submitted matrices for this renderable, and leaves the record zeroed when
    // it did not. Without that test an all-zero record would skin every vertex
    // to the origin and break the base's own SkeletonInstance path — which is
    // the path animated-character still uses.
    exec += "  float4 tensionS = readOnlyFetch( tensionMatrixBuf, tensionBase );\n";
    exec += "  if( tensionS.w > 0.5 )\n";
    exec += "  { float4 skinned = float4( 0.0, 0.0, 0.0, 0.0 );\n";
    // Four influences per vertex: the vertex stream carries UBYTE4 weights and
    // indices, and the compiled PBS variant expands its own skeleton block to
    // inVs_blendWeights[0..3] (measured). One column-major 4x4 matrix per joint,
    // four vec4s each, at bone * 4.
    exec += "    for( int i = 0; i < 4; ++i )\n";
    exec += "    { int mb = tensionBase + int( inVs_blendIndices[i] ) * 4;\n";
    exec += "      float4 c0 = readOnlyFetch( tensionMatrixBuf, mb + 0 );\n";
    exec += "      float4 c1 = readOnlyFetch( tensionMatrixBuf, mb + 1 );\n";
    exec += "      float4 c2 = readOnlyFetch( tensionMatrixBuf, mb + 2 );\n";
    exec += "      float4 c3 = readOnlyFetch( tensionMatrixBuf, mb + 3 );\n";
    exec += "      float4 tp = c0 * inputPos.x + c1 * inputPos.y + c2 * inputPos.z +\n";
    exec += "                  c3 * inputPos.w;\n";
    exec += "      skinned += tp * inVs_blendWeights[i]; }\n";
    exec += "    worldPos.xyz = skinned.xyz; }\n";
    exec += "}\n";
}

void HlmsTensionSkin::set_renderable_matrices(const Renderable *renderable,
                                              const std::vector<float> &matrices) {
    renderable_matrices_[renderable] = matrices;
}

void HlmsTensionSkin::clear_renderable_matrices(const Renderable *renderable) {
    renderable_matrices_.erase(renderable);
}

uint32_t HlmsTensionSkin::fillBuffersFor(const HlmsCache *cache,
                                         const QueuedRenderable &queuedRenderable, bool casterPass,
                                         uint32_t lastCacheHash, uint32_t lastTextureHash) {
    (void)cache;
    (void)queuedRenderable;
    (void)casterPass;
    (void)lastCacheHash;
    (void)lastTextureHash;
    OGRE_EXCEPT(Exception::ERR_NOT_IMPLEMENTED,
                "Trying to use slow-path on a desktop implementation.",
                "HlmsTensionSkin::fillBuffersFor");
}

uint32_t HlmsTensionSkin::fillBuffersForV1(const HlmsCache *cache,
                                           const QueuedRenderable &queuedRenderable,
                                           bool casterPass, uint32_t lastCacheHash,
                                           CommandBuffer *commandBuffer) {
    return fillBuffersForV2(cache, queuedRenderable, casterPass, lastCacheHash, commandBuffer);
}

uint32_t HlmsTensionSkin::fillBuffersForV2(const HlmsCache *cache,
                                           const QueuedRenderable &queuedRenderable,
                                           bool casterPass, uint32_t lastCacheHash,
                                           CommandBuffer *commandBuffer) {
    if (matrix_buffer_ == nullptr) {
        return HlmsPbs::fillBuffersForV2(cache, queuedRenderable, casterPass, lastCacheHash,
                                         commandBuffer);
    }

    // The datablock is what makes a renderable ours: the adapter gives
    // HlmsTensionSkinDatablock to the Items it drives with guest matrices, and
    // everything else keeps a plain PBS datablock (drawn by PBS's own Hlms).
    const HlmsTensionSkinDatablock *ours =
        dynamic_cast<HlmsTensionSkinDatablock *>(queuedRenderable.renderable->getDatablock());

    // Skip the base ONLY when there is no SkeletonInstance — the state the base
    // dereferences at :3528 and :3571 and crashes on. When a skeleton is
    // present, call the base: it streams the bone matrices the shader's
    // SkeletonTransform piece needs, and then we append our own record on top.
    // 79ed0de skipped the base for every one of ours, and rigged meshes drew 0
    // pixels because nothing streamed their bones.
    const Ogre::SkeletonInstance *skeleton =
        queuedRenderable.movableObject->getSkeletonInstance();

    // One store shared by both paths below: the matrices the adapter stored for
    // this renderable, or zeros, into the object's record slot. One whole
    // record either way, so a slot that had a rig in the last frame and a
    // static mesh in this one cannot show the old rig.
    const auto write_our_record = [&](const QueuedRenderable &qr, uint32_t baseInstance) {
        if (records_ == nullptr || baseInstance >= kMaxObjects) return;
        float *dst = records_ + baseInstance * kRecordFloats;
        std::fill(dst, dst + kRecordFloats, 0.0f);
        const auto *animated = dynamic_cast<const Ogre::RenderableAnimated *>(qr.renderable);
        const Ogre::RenderableAnimated::IndexMap *blendMap =
            animated != nullptr ? animated->getBlendIndexToBoneIndexMap() : nullptr;
        const auto itor = renderable_matrices_.find(qr.renderable);
        if (itor != renderable_matrices_.end() && !itor->second.empty() && blendMap != nullptr) {
            // The matrices are re-packed in **blend-slot order**, not joint
            // order. The vertex stream's blend indices are IndexMap slots —
            // measured on characterMedium: the map has 32 entries over 58 joints
            // and starts {19, 20, 21, 22, ...}, so slot 0 is joint 19. PBS packs
            // its matrices in that order for exactly this reason; a fill that
            // copied the guest's matrices in joint order would have the shader
            // read the wrong matrix for every vertex (measured: delta 1815
            // against 48 for the translation-only read, which is what exposed
            // it).
            const size_t slots = blendMap->size();
            const size_t joints = itor->second.size() / kMatrixFloats;
            for (size_t slot = 0; slot < slots && slot < kMaxBones; ++slot) {
                const uint16_t joint = (*blendMap)[slot];
                if (joint >= joints) continue;
                std::copy(itor->second.begin() + joint * kMatrixFloats,
                          itor->second.begin() + joint * kMatrixFloats + kMatrixFloats,
                          dst + slot * kMatrixFloats);
            }
            // The sentinel the shader branches on: record[0].w is the first
            // matrix's m30, which is 0 for every affine matrix and unused by the
            // transform, so it can carry "matrices were submitted" without
            // touching anything the skinning reads.
            dst[3] = 1.0f;
        }
    };

    if (ours == nullptr || skeleton != nullptr) {
        const uint32_t baseInstance = HlmsPbs::fillBuffersForV2(cache, queuedRenderable,
                                                                casterPass, lastCacheHash,
                                                                commandBuffer);
        // The bind goes AFTER the base's fill: the base fills its own read-only
        // buffers and one of them is slot 1 — the Forward+ light list (`texUnit
        // = mReservedTexBufferSlots` in its fill) — so a bind before the base
        // is overwritten. Measured: before, delta 0.0; after, delta 48.0. It
        // goes on every pass including the caster, because binding state
        // persists across passes within a command buffer: with a shadow node
        // and no caster bind, the rig renders out of frame (0 non-background
        // pixels against 3920 for the same scene without one). It is not the
        // caster *shader* that reads the buffer — our piece is not emitted into
        // the caster variant at all (0 occurrences in its dump against 4 in the
        // main variant) — it is the binding each pass leaves behind.
        bind_our_buffer(commandBuffer);
        if (ours != nullptr) {
            // Ours with a skeleton: the base's return value IS the object's
            // identity: `RenderQueue` stores it as the draw's `baseInstance`
            // (OgreRenderQueue.cpp:794), and the shader's `inVs_drawId` is that
            // value. The record goes on top of the base's stream — the bone
            // matrices stay in the tex buffer, deforming the mesh whenever the
            // sentinel is off and feeding the normals when it is on.
            write_our_record(queuedRenderable, baseInstance);
        }
        return baseInstance;
    }

    // ours != nullptr && skeleton == nullptr: the base would crash on the null
    // SkeletonInstance. fill_our_object reproduces its no-skeleton per-object
    // block, and nothing after this touches slot 1, so the bind follows the
    // fill. Same identity rule as above: the return is the draw's
    // `baseInstance` and the record slot.
    const uint32_t baseInstance =
        fill_our_object(queuedRenderable, casterPass, lastCacheHash, commandBuffer);
    bind_our_buffer(commandBuffer);
    write_our_record(queuedRenderable, baseInstance);
    return baseInstance;
}

uint32_t HlmsTensionSkin::fill_our_object(const Ogre::QueuedRenderable &queuedRenderable,
                                          bool casterPass, uint32_t lastCacheHash,
                                          Ogre::CommandBuffer *commandBuffer) {
    // A literal transcription of the base's no-skeleton-animation block:
    // OgreHlmsPbs.cpp:3402-3463 — the `!hasSkeletonAnimation && numPoses == 0`
    // branch, world matrix from the node's full transform — plus the shared
    // tail at :3691-3757 (the shadow-bias / light-mask / planar-reflection
    // words at +1/+2/+3, the +4 cursor advance, the member syncs and the
    // return). The skeleton drive loop (:3565-3575) has no counterpart here:
    // nothing reads a SkeletonInstance, so a renderable with blend data and no
    // resolved skeleton — which the base dereferences at :3528 and :3571 —
    // fills cleanly.
    //
    // One deliberate difference from the fast path's own write: the word below
    // is the dist-prefixed identity from :3560-3563, not the slot-only form of
    // :3432. Ours draw with `hlms_skeleton` on, and `SkeletonTransform`
    // resolves bone slot 0 from `(worldMaterialIdx[inVs_drawId].x >> 9u)` —
    // the float4 index of this object's matrices. The rigid 4x3 written just
    // below is what that fetch must find. The slot-only form serves only the
    // `!hlms_skeleton` fetch, which addresses `worldMatBuf` by draw id and
    // never reads those bits.
    const HlmsPbsDatablock *datablock =
        static_cast<const HlmsPbsDatablock *>(queuedRenderable.renderable->getDatablock());

    uint32 *currentMappedConstBuffer = mCurrentMappedConstBuffer;
    float *currentMappedTexBuffer = mCurrentMappedTexBuffer;

    const Matrix4 &worldMat = queuedRenderable.movableObject->_getParentNodeFullTransform();

    // ── The base's type-changed prelude (OgreHlmsPbs.cpp:3148-3390), reproduced ──
    // The base issues these shared binds only when the Hlms type changes in the batch
    // (first draw of this Hlms in a frame-sequence, or after another Hlms). Our fill must
    // do the same, or an ours-only frame never binds them: without the pass buffer above
    // all, `passBuf.viewProj` reads garbage and every vertex leaves the clip volume.
    // Skipped deliberately, with the reasons:
    //   * mAtmosphere->bindConstBuffers: our scenes never configure an atmosphere, and the
    //     call is inert for an unconfigured one (the base runs it for plain PBS draws that
    //     render identically without any atmosphere set up).
    //   * the feature-texture cascade (prepass/depth/SSR/refractions/irradiance/VCT/area
    //     masks/light profiles/LTC/decals/PCC): none of those HlmsPbs members can be
    //     non-null on an HlmsTensionSkin instance — the adapter configures none of them —
    //     and the variant does not declare their samplers, so every guard is false and
    //     the texUnit progression below matches the base's.
    // The listener call IS reproduced: Hlms::mListener is never null, and its default
    // implementation is the extension point.
    if( OGRE_EXTRACT_HLMS_TYPE_FROM_CACHE_HASH( lastCacheHash ) != mType )
    {
        // layout(binding = 0) uniform PassBuffer {} pass
        ConstBufferPacked *passBuffer = mPassBuffers[mCurrentPassBuffer - 1];
        *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
            VertexShader, 0, passBuffer, 0, (uint32)passBuffer->getTotalSizeBytes() );
        *commandBuffer->addCommand<CbShaderBuffer>() =
            CbShaderBuffer( PixelShader, 0, passBuffer, 0, (uint32)passBuffer->getTotalSizeBytes() );

        if( mUseLightBuffers )
        {
            ConstBufferPacked *light0Buffer = mLight0Buffers[mCurrentPassBuffer - 1];
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                VertexShader, 3, light0Buffer, 0, (uint32)light0Buffer->getTotalSizeBytes() );
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                PixelShader, 3, light0Buffer, 0, (uint32)light0Buffer->getTotalSizeBytes() );

            ConstBufferPacked *light1Buffer = mLight1Buffers[mCurrentPassBuffer - 1];
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                VertexShader, 4, light1Buffer, 0, (uint32)light1Buffer->getTotalSizeBytes() );
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                PixelShader, 4, light1Buffer, 0, (uint32)light1Buffer->getTotalSizeBytes() );

            ConstBufferPacked *light2Buffer = mLight2Buffers[mCurrentPassBuffer - 1];
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                VertexShader, 5, light2Buffer, 0, (uint32)light2Buffer->getTotalSizeBytes() );
            *commandBuffer->addCommand<CbShaderBuffer>() = CbShaderBuffer(
                PixelShader, 5, light2Buffer, 0, (uint32)light2Buffer->getTotalSizeBytes() );
        }

        size_t texUnit = mReservedTexBufferSlots;

        if( !casterPass )
        {
            if( mGridBuffer )
            {
                *commandBuffer->addCommand<CbShaderBuffer>() =
                    CbShaderBuffer( PixelShader, (uint16)texUnit++, mGlobalLightListBuffer, 0, 0 );
                *commandBuffer->addCommand<CbShaderBuffer>() =
                    CbShaderBuffer( PixelShader, (uint16)texUnit++, mGridBuffer, 0, 0 );
            }

            texUnit += mReservedTexSlots;

            // The shadow maps this pass' shadow node brought in — the same loop the base
            // runs inside its cascade, and it applies to our Hlms's pass data as well.
            FastArray<TextureGpu *>::const_iterator itor = mPreparedPass.shadowMaps.begin();
            FastArray<TextureGpu *>::const_iterator end = mPreparedPass.shadowMaps.end();
            while( itor != end )
            {
                *commandBuffer->addCommand<CbTexture>() =
                    CbTexture( (uint16)texUnit, *itor, mCurrentShadowmapSamplerblock );
                ++texUnit;
                ++itor;
            }
        }

        if( mHlmsManager->getBlueNoiseTexture() )
        {
            *commandBuffer->addCommand<CbTexture>() =
                CbTexture( (uint16)texUnit, mHlmsManager->getBlueNoiseTexture(), 0 );
            ++texUnit;
        }

        mLastDescTexture = 0;
        mLastDescSampler = 0;
        mLastBoundPool = 0;

        // layout(binding = 2) uniform InstanceBuffer {} instance
        if( mCurrentConstBuffer < mConstBuffers.size() &&
            (size_t)( ( mCurrentMappedConstBuffer - mStartMappedConstBuffer ) + 4 ) <=
                mCurrentConstBufferSize )
        {
            *commandBuffer->addCommand<CbShaderBuffer>() =
                CbShaderBuffer( VertexShader, 2, mConstBuffers[mCurrentConstBuffer], 0, 0 );
            *commandBuffer->addCommand<CbShaderBuffer>() =
                CbShaderBuffer( PixelShader, 2, mConstBuffers[mCurrentConstBuffer], 0, 0 );
        }

        rebindTexBuffer( commandBuffer );

#ifdef OGRE_BUILD_COMPONENT_PLANAR_REFLECTIONS
        mLastBoundPlanarReflection = 0u;
        if( mHasPlanarReflections )
            ++texUnit;  // We do not bind this texture now, but its slot is reserved.
#endif
        mListener->hlmsTypeChanged( casterPass, commandBuffer, datablock, texUnit );
    }

    // The base's per-datablock prelude (OgreHlmsPbs.cpp:3362-3387): bind PBS's material
    // pool at slot 1 for both stages, so the pixel shader's `materialArray`
    // (layout(binding = 1) uniform MaterialBuf) is THIS datablock's pool. Same tracking
    // as the base — `mLastBoundPool` — so a pool already bound is not rebound. (The base
    // also binds a manual cubemap probe's const buffer here; our datablocks never carry
    // one, so that branch is elided.)
    // Don't bind the material buffer on caster passes (important to keep
    // MDI & auto-instancing running on shadow map passes)
    if( mLastBoundPool != datablock->getAssignedPool() &&
        ( !casterPass || datablock->getAlphaTest() != CMPF_ALWAYS_PASS ||
          datablock->getAlphaHashing() ) )
    {
        // layout(binding = 1) uniform MaterialBuf {} materialArray
        const ConstBufferPool::BufferPool *newPool = datablock->getAssignedPool();
        *commandBuffer->addCommand<CbShaderBuffer>() =
            CbShaderBuffer( VertexShader, 1, newPool->materialBuffer, 0,
                            (uint32)newPool->materialBuffer->getTotalSizeBytes() );
        *commandBuffer->addCommand<CbShaderBuffer>() =
            CbShaderBuffer( PixelShader, 1, newPool->materialBuffer, 0,
                            (uint32)newPool->materialBuffer->getTotalSizeBytes() );
        mLastBoundPool = newPool;
    }

    // The datablock's own textures and samplers (OgreHlmsPbs.cpp:3720-3755) —
    // the block the 19e-a reproduction missed. Untextured probes never reached
    // it, so nothing noticed; the animated-character skins are the first
    // textured datablocks to draw through here, and they rendered black
    // because the pixel shader's descriptor set was never bound. The calls,
    // the `mTexUnitSlotStart` anchor and the tracking are the base's; the
    // descriptor sets come through the datablock subclass because
    // `friend class HlmsPbs` does not extend to a subclass. Same caster guard
    // as the material pool above, and `mLastDescTexture` / `mLastDescSampler`
    // are reset alongside `mLastBoundPool` in the type-changed prelude.
    const HlmsTensionSkinDatablock *our_datablock =
        static_cast<const HlmsTensionSkinDatablock *>(datablock);
    if( !casterPass || datablock->getAlphaTest() != CMPF_ALWAYS_PASS ||
        datablock->getAlphaHashing() )
    {
        if( our_datablock->textures_desc_set() != mLastDescTexture )
        {
            if( our_datablock->textures_desc_set() )
            {
                // Rebind textures
                size_t texUnit = mTexUnitSlotStart;

                *commandBuffer->addCommand<CbTextures>() =
                    CbTextures( (uint16)texUnit, our_datablock->cubemap_idx_in_desc_set(),
                                our_datablock->textures_desc_set() );

                if( !mHasSeparateSamplers )
                {
                    *commandBuffer->addCommand<CbSamplers>() =
                        CbSamplers( (uint16)texUnit, our_datablock->samplers_desc_set() );
                }
            }

            mLastDescTexture = our_datablock->textures_desc_set();
        }

        if( our_datablock->samplers_desc_set() != mLastDescSampler && mHasSeparateSamplers )
        {
            if( our_datablock->samplers_desc_set() )
            {
                // Bind samplers
                size_t texUnit = mTexUnitSlotStart;
                *commandBuffer->addCommand<CbSamplers>() =
                    CbSamplers( (uint16)texUnit, our_datablock->samplers_desc_set() );
                mLastDescSampler = our_datablock->samplers_desc_set();
            }
        }
    }

    // We need to correct currentMappedConstBuffer to point to the right texture buffer's
    // offset, which may not be in sync if the previous draw had skeletal and/or pose animation.
    const size_t currentConstOffset =
        static_cast<size_t>( currentMappedTexBuffer - mStartMappedTexBuffer ) >>
        ( 2u + !casterPass );
    currentMappedConstBuffer = currentConstOffset + mStartMappedConstBuffer;
    bool exceedsConstBuffer =
        static_cast<size_t>( ( currentMappedConstBuffer - mStartMappedConstBuffer ) + 4u ) >
        mCurrentConstBufferSize;

    const size_t minimumTexBufferSize = 16u * ( 1u + !casterPass );
    bool exceedsTexBuffer =
        ( static_cast<size_t>( currentMappedTexBuffer - mStartMappedTexBuffer ) +
          minimumTexBufferSize ) >= mCurrentTexBufferSize;

    if( exceedsConstBuffer || exceedsTexBuffer )
    {
        currentMappedConstBuffer = mapNextConstBuffer( commandBuffer );

        if( exceedsTexBuffer )
            mapNextTexBuffer( commandBuffer, minimumTexBufferSize * sizeof( float ) );
        else
            rebindTexBuffer( commandBuffer, true, minimumTexBufferSize * sizeof( float ) );

        currentMappedTexBuffer = mCurrentMappedTexBuffer;
    }

    // uint worldMaterialIdx[] — :3560-3563, dist-prefixed on purpose.
    size_t distToWorldMatStart =
        static_cast<size_t>( mCurrentMappedTexBuffer - mStartMappedTexBuffer );
    distToWorldMatStart >>= 2;
    *currentMappedConstBuffer = uint32( ( distToWorldMatStart << 9 ) |
                                        ( datablock->getAssignedSlot() & 0x1FF ) );

    // mat4x3 world
#if !OGRE_DOUBLE_PRECISION
    memcpy( currentMappedTexBuffer, &worldMat, 4 * 3 * sizeof( float ) );
    currentMappedTexBuffer += 16;
#else
    for( int y = 0; y < 3; ++y )
    {
        for( int x = 0; x < 4; ++x )
        {
            *currentMappedTexBuffer++ = worldMat[y][x];
        }
    }
    currentMappedTexBuffer += 4;
#endif

    // mat4 worldView
    Matrix4 tmp = mPreparedPass.viewMatrix.concatenateAffine( worldMat );
#if !OGRE_DOUBLE_PRECISION
    memcpy( currentMappedTexBuffer, &tmp, sizeof( Matrix4 ) * !casterPass );
    currentMappedTexBuffer += 16 * !casterPass;
#else
    if( !casterPass )
    {
        for( int y = 0; y < 4; ++y )
        {
            for( int x = 0; x < 4; ++x )
            {
                *currentMappedTexBuffer++ = tmp[y][x];
            }
        }
    }
#endif

    // The tail every base arm falls through to (:3691-3757).
    *reinterpret_cast<float * RESTRICT_ALIAS>( currentMappedConstBuffer + 1 ) =
        datablock->mShadowConstantBias * mConstantBiasScale;
#if !OGRE_NO_FINE_LIGHT_MASK_GRANULARITY
    *( currentMappedConstBuffer + 2u ) = queuedRenderable.movableObject->getLightMask();
#endif
#ifdef OGRE_BUILD_COMPONENT_PLANAR_REFLECTIONS
    *( currentMappedConstBuffer + 3u ) = queuedRenderable.renderable->mCustomParameter & 0x7F;
#endif
    currentMappedConstBuffer += 4;

    mCurrentMappedConstBuffer = currentMappedConstBuffer;
    mCurrentMappedTexBuffer = currentMappedTexBuffer;

    return uint32( ( ( mCurrentMappedConstBuffer - mStartMappedConstBuffer ) >> 2u ) - 1u );
}

}  // namespace tension_ogre
