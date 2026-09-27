// hlms_tension_skin.h — the adapter's HlmsPbs subclass (chunk 19, round 19a).
//
// The reference this ports is tension-ogre/tests/hlms-skin/ (branch
// polish/hlms-skin), where the mechanism was measured end to end. The shape is
// a subclass of `HlmsPbs` that registers *beside* PBS on its own `HlmsTypes`
// slot, carries its own matrix buffer at a slot it reserves, and injects its
// own vertex-shader piece which reads that buffer by draw id. It exists so
// that data computed outside OGRE's skeleton system can reach the PBS shader —
// the path the guest's model-space matrices will take once they are wired.
//
// This round lands the plumbing only. The buffer holds zeros, the fill calls
// the base, and the base still does the skinning through the Item's
// `SkeletonInstance`, so a rigged mesh drawn by this Hlms looks exactly like
// one drawn by PBS. The parts below are deliberately unchanged from the
// reference, because they are the parts that were proven:
//
//   * buffer  `ReadOnlyBufferPacked`, `PFG_RGBA32_FLOAT`, created in
//             `_changeRenderSystem` *after* the base call and destroyed with
//             `VaoManager::destroyReadOnlyBuffer`. (`ReadOnlyBufferPacked` has
//             no `destroy()`, and `mRenderSystem` is still null in the
//             constructor.)
//   * slot    1, with `DescBindingTypes::ReadOnlyBuffer` widened to [0, 2) in
//             `setupRootLayout( RootLayout &, const size_t tid )` — the `tid`
//             parameter is part of the signature.
//   * write   ONE whole-range map per `preparePassHash` with
//             `advanceFrame = true`, then plain stores at `baseInstance * 4`.
//             Never `upload()` and never a per-object map:
//             `GL3PlusBufferInterface::map` always targets `current + 1`, and
//             only `bAdvanceFrame` decides whether that copy also becomes the
//             one the pass draws from.
//   * read    `ReadOnlyBufferF( 1, float4, … )` + `readOnlyFetch( …, int(
//             inVs_drawId ) )`, applied in `custom_vs_preTransform` (on
//             `worldPos`), never in `custom_vs_posExecution` — which runs after
//             `outVs_Position` has been computed.
//
// `inVs_drawId` is the value `fillBuffersForV2` returns: the object's
// const-buffer vec4 index, which `RenderQueue` stores as the draw's
// `baseInstance`.

#ifndef TENSION_OGRE_HLMS_TENSION_SKIN_H
#define TENSION_OGRE_HLMS_TENSION_SKIN_H

#include <Hlms/Pbs/OgreHlmsPbs.h>
#include <Hlms/Pbs/OgreHlmsPbsDatablock.h>
#include <OgreRootLayout.h>

namespace tension_ogre {

/// The datablock a rigged Item carries. Its values are the same ones the
/// adapter puts on a PBS datablock — the only difference is which Hlms draws
/// it, and this type is how the fill recognises its own renderables. It adds
/// no fields: a datablock that carried state the adapter did not set would be
/// a second source of truth for the same material.
class HlmsTensionSkinDatablock : public Ogre::HlmsPbsDatablock {
public:
    HlmsTensionSkinDatablock(Ogre::IdString name, Ogre::HlmsPbs *creator,
                             const Ogre::HlmsMacroblock *macroblock,
                             const Ogre::HlmsBlendblock *blendblock,
                             const Ogre::HlmsParamVec &paramVec) :
        Ogre::HlmsPbsDatablock(name, creator, macroblock, blendblock, paramVec) {}
};

/// The subclass itself. One instance per render system, registered after PBS.
class HlmsTensionSkin : public Ogre::HlmsPbs {
public:
    /// Our buffer's slot in the ReadOnlyBuffer range: PBS reserved [0, 1).
    static const uint16_t kOurTexBufferSlot = 1u;
    /// Floats per object record in our buffer (one vec4).
    static const size_t kRecordFloats = 4u;
    /// How many objects our buffer can carry records for.
    static const size_t kMaxObjects = 64u;

    HlmsTensionSkin(Ogre::Archive *dataFolder, Ogre::ArchiveVec *libraryFolders);

    void setupRootLayout(Ogre::RootLayout &rootLayout, size_t tid) override;
    Ogre::HlmsCache preparePassHash(const Ogre::CompositorShadowNode *shadowNode, bool casterPass,
                                    bool dualParaboloid, Ogre::SceneManager *sceneManager) override;
    void _changeRenderSystem(Ogre::RenderSystem *newRs) override;

    uint32_t fillBuffersFor(const Ogre::HlmsCache *cache,
                            const Ogre::QueuedRenderable &queuedRenderable, bool casterPass,
                            uint32_t lastCacheHash, uint32_t lastTextureHash) override;
    uint32_t fillBuffersForV1(const Ogre::HlmsCache *cache,
                              const Ogre::QueuedRenderable &queuedRenderable, bool casterPass,
                              uint32_t lastCacheHash, Ogre::CommandBuffer *commandBuffer) override;
    uint32_t fillBuffersForV2(const Ogre::HlmsCache *cache,
                              const Ogre::QueuedRenderable &queuedRenderable, bool casterPass,
                              uint32_t lastCacheHash, Ogre::CommandBuffer *commandBuffer) override;

protected:
    Ogre::ReadOnlyBufferPacked *matrix_buffer_ = nullptr;
    size_t matrix_buffer_bytes_;
    /// The whole record range, mapped once per pass — one ring advance per
    /// pass, never one per object.
    float *records_ = nullptr;
    bool records_mapped_ = false;

    Ogre::HlmsDatablock *createDatablockImpl(Ogre::IdString datablockName,
                                             const Ogre::HlmsMacroblock *macroblock,
                                             const Ogre::HlmsBlendblock *blendblock,
                                             const Ogre::HlmsParamVec &paramVec) override;

    void calculateHashFor(Ogre::Renderable *renderable, uint32_t &outHash,
                          uint32_t &outCasterHash) override;
    void calculateHashForPreCreate(Ogre::Renderable *renderable,
                                   Ogre::PiecesMap *inOutPieces) override;

    void bind_our_buffer(Ogre::CommandBuffer *commandBuffer);
};

}  // namespace tension_ogre

#endif
