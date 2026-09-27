// hlms_tension_skin.cpp — see hlms_tension_skin.h for what this is and why
// every choice below is the one the reference measured (chunk 19, round 19a).

#include "hlms_tension_skin.h"

#include <CommandBuffer/OgreCbShaderBuffer.h>
#include <CommandBuffer/OgreCommandBuffer.h>
#include <OgreHlmsManager.h>
#include <OgreLogManager.h>
#include <OgreRenderQueue.h>
#include <OgreRenderSystem.h>
#include <Vao/OgreReadOnlyBufferPacked.h>
#include <Vao/OgreVaoManager.h>

#include <algorithm>
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

    // Only the main pass writes records: a caster pass draws the same objects
    // with draw ids the main shader never sees, and the caster variant has no
    // use for the record.
    if (casterPass) {
        const uint32_t casterBase = HlmsPbs::fillBuffersForV2(
            cache, queuedRenderable, casterPass, lastCacheHash, commandBuffer);
        bind_our_buffer(commandBuffer);
        return casterBase;
    }

    // The base's return value IS the object's identity: `RenderQueue` stores it
    // as the draw's `baseInstance` (OgreRenderQueue.cpp:794), and the shader's
    // `inVs_drawId` is that value. Keeping it is also what keeps the
    // SkeletonInstance path intact — this fill does not touch the base's own
    // per-object block.
    const uint32_t baseInstance = HlmsPbs::fillBuffersForV2(cache, queuedRenderable, casterPass,
                                                            lastCacheHash, commandBuffer);

    // The bind goes LAST, after the base's fill, and both halves of that are
    // load-bearing:
    //
    //   * after, because the base fills its own read-only buffers and one of them
    //     is slot 1 — PBS reserves ReadOnlyBuffer [0, 2), where slot 0 is
    //     `worldMatBuf` and slot 1 is the Forward+ light list (`texUnit =
    //     mReservedTexBufferSlots` in its fill). A bind before the base is
    //     overwritten; measured: before, delta 0.0; after, delta 48.0.
    //   * on every pass including the caster, because binding state persists
    //     across passes within a command buffer, so a caster pass that leaves
    //     slot 1 holding something else poisons the main pass that follows.
    //     Measured: with a shadow node and no caster bind, the rig renders out
    //     of frame (0 non-background pixels against 3920 for the same scene
    //     without one).
    //
    // It is not the caster *shader* that reads the buffer — our piece is not
    // emitted into the caster variant at all (0 occurrences in its dump against
    // 4 in the main variant) — it is the binding each pass leaves behind.
    bind_our_buffer(commandBuffer);

    // The payload: the matrices the adapter stored for this renderable, or
    // zeros. One store of the whole record either way, so a slot that had a rig
    // in the last frame and a static mesh in this one cannot show the old rig.
    if (records_ != nullptr && baseInstance < kMaxObjects) {
        float *dst = records_ + baseInstance * kRecordFloats;
        const auto itor = renderable_matrices_.find(queuedRenderable.renderable);
        if (itor != renderable_matrices_.end() && !itor->second.empty()) {
            const size_t count = std::min(itor->second.size(), kRecordFloats);
            std::copy(itor->second.begin(), itor->second.begin() + count, dst);
            if (count < kRecordFloats) std::fill(dst + count, dst + kRecordFloats, 0.0f);
            // The sentinel the shader branches on: record[0].w is the first
            // matrix's m30, which is 0 for every affine matrix and unused by the
            // transform, so it can carry "matrices were submitted" without
            // touching anything the skinning reads.
            dst[3] = 1.0f;
        } else {
            std::fill(dst, dst + kRecordFloats, 0.0f);
        }
    }

    return baseInstance;
}

}  // namespace tension_ogre
