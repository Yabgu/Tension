// HlmsTensionSkin — a minimal HlmsPbs subclass that binds its own matrix
// buffer and injects its own shader piece, with no SkeletonInstance anywhere.
//
// This is the reference implementation for the adapter's v1-removal path: the
// guest computes model-space matrices, the adapter binds them, the vertex
// shader reads them by draw id. See README.md beside this file for the recipe
// and for the source citations behind every choice here.
//
// It is a *reference*, not the adapter: the "matrices" it carries are one vec4
// per object whose x component is a deliberate world-space offset, chosen so
// that three identical objects at the same scene node land in three different
// places — which is how the per-object channel is proven. Swap the record for
// a real bone matrix array and the mechanism is the adapter's.

#ifndef _HlmsTensionSkin_H_
#define _HlmsTensionSkin_H_

#include "OgreHlmsPbs.h"
#include "OgreHlmsPbsDatablock.h"
#include "OgreRootLayout.h"

namespace Ogre
{
    class ReadOnlyBufferPacked;

    /// The datablock a subclass hands to its own Items. It exists so the fill can
    /// tell "our" renderables from everyone else's; the field is a marker the
    /// probe sets and reads back, nothing more.
    class HlmsTensionSkinDatablock : public HlmsPbsDatablock
    {
        uint32 mTensionFlag;

    public:
        HlmsTensionSkinDatablock( IdString name, HlmsPbs *creator, const HlmsMacroblock *macroblock,
                                  const HlmsBlendblock *blendblock, const HlmsParamVec &paramVec ) :
            HlmsPbsDatablock( name, creator, macroblock, blendblock, paramVec ),
            mTensionFlag( 0u )
        {
        }
        void   setTensionFlag( uint32 v ) { mTensionFlag = v; }
        uint32 getTensionFlag() const { return mTensionFlag; }
    };

    class HlmsTensionSkin : public HlmsPbs
    {
    public:
        /// When false every record is zero: the contrast run. With the channel on,
        /// records 0..N-1 place their objects at -3, 0, +3, ... world units in x,
        /// so N objects produce N distinguishable fragments.
        static bool  sChannelEnabled;
        /// How many records the fill has written (one per object per frame).
        static int   sObjectCounter;
        /// The record the last fill wrote, for the run's own output.
        static float sLastWrite[4];

        /// Our buffer's slot in the ReadOnlyBuffer range: PBS reserved [0, 1).
        static const uint16 kOurTexBufferSlot = 1u;
        /// Floats per object record in our buffer (one vec4).
        static const size_t kRecordFloats = 4u;
        /// How many objects our buffer can carry records for.
        static const size_t kMaxObjects = 64u;

        HlmsTensionSkin( Archive *dataFolder, ArchiveVec *libraryFolders );

        void setupRootLayout( RootLayout &rootLayout, size_t tid ) override;
        HlmsCache preparePassHash( const Ogre::CompositorShadowNode *shadowNode, bool casterPass,
                                   bool dualParaboloid, SceneManager *sceneManager ) override;
        void _changeRenderSystem( RenderSystem *newRs ) override;

        uint32 fillBuffersFor( const HlmsCache *cache, const QueuedRenderable &queuedRenderable,
                               bool casterPass, uint32 lastCacheHash,
                               uint32 lastTextureHash ) override;
        uint32 fillBuffersForV1( const HlmsCache *cache, const QueuedRenderable &queuedRenderable,
                                 bool casterPass, uint32 lastCacheHash,
                                 CommandBuffer *commandBuffer ) override;
        uint32 fillBuffersForV2( const HlmsCache *cache, const QueuedRenderable &queuedRenderable,
                                 bool casterPass, uint32 lastCacheHash,
                                 CommandBuffer *commandBuffer ) override;

    protected:
        ReadOnlyBufferPacked *mMatrixBuffer;
        size_t                mMatrixBufferBytes;
        /// The whole record range, mapped once per pass — one ring advance per pass,
        /// never one per object. See preparePassHash() for why.
        float                *mRecords;
        bool                  mRecordsMapped;

        HlmsDatablock *createDatablockImpl( IdString datablockName, const HlmsMacroblock *macroblock,
                                            const HlmsBlendblock *blendblock,
                                            const HlmsParamVec &paramVec ) override;

        void calculateHashFor( Renderable *renderable, uint32 &outHash,
                               uint32 &outCasterHash ) override;
        void calculateHashForPreCreate( Renderable *renderable, PiecesMap *inOutPieces ) override;

        void bindOurBuffer( CommandBuffer *commandBuffer );
    };
}  // namespace Ogre

#endif
