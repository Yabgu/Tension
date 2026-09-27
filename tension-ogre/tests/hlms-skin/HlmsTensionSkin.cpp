#include "HlmsTensionSkin.h"

#include "CommandBuffer/OgreCbShaderBuffer.h"
#include "CommandBuffer/OgreCommandBuffer.h"
#include "OgreHlmsManager.h"
#include "OgreLogManager.h"
#include "OgreRenderQueue.h"
#include "OgreRenderSystem.h"
#include "Vao/OgreReadOnlyBufferPacked.h"
#include "Vao/OgreVaoManager.h"
#include <algorithm>
#include <vector>

namespace Ogre
{
    bool  HlmsTensionSkin::sChannelEnabled = true;
    int   HlmsTensionSkin::sObjectCounter = 0;
    float HlmsTensionSkin::sLastWrite[4] = {0, 0, 0, 0};

    HlmsTensionSkin::HlmsTensionSkin( Archive *dataFolder, ArchiveVec *libraryFolders ) :
        HlmsPbs( dataFolder, libraryFolders ),
        mMatrixBuffer( nullptr ),
        mMatrixBufferBytes( kMaxObjects * kRecordFloats * sizeof( float ) ),
        mRecords( nullptr ),
        mRecordsMapped( false )
    {
        // A second provider for HLMS_PBS is refused (ItemIdentityException: "Provider
        // for HLMS type has already been set"), so the subclass takes its own slot.
        mType = HLMS_USER0;
        mTypeName = "TensionSkin";
        mTypeNameStr = "TensionSkin";
    }

    //-----------------------------------------------------------------------------------
    void HlmsTensionSkin::_changeRenderSystem( RenderSystem *newRs )
    {
        HlmsPbs::_changeRenderSystem( newRs );
        if( !newRs )
            return;

        // The buffer is created HERE, not in the constructor: mRenderSystem is still 0
        // when an Hlms is constructed (measured), and _changeRenderSystem is where the
        // base class establishes its own buffers too (HlmsBufferManager::_changeRenderSystem).
        std::vector<float> zeros( kMaxObjects * kRecordFloats, 0.0f );
        if( mMatrixBuffer )
        {
            mRecordsMapped = false;
            newRs->getVaoManager()->destroyReadOnlyBuffer( mMatrixBuffer );
        }
        mMatrixBuffer = newRs->getVaoManager()->createReadOnlyBuffer(
            PixelFormatGpu::PFG_RGBA32_FLOAT, mMatrixBufferBytes, BT_DYNAMIC_PERSISTENT,
            zeros.data(), false );
    }

    //-----------------------------------------------------------------------------------
    HlmsCache HlmsTensionSkin::preparePassHash( const CompositorShadowNode *shadowNode,
                                                bool casterPass, bool dualParaboloid,
                                                SceneManager *sceneManager )
    {
        HlmsCache retVal =
            HlmsPbs::preparePassHash( shadowNode, casterPass, dualParaboloid, sceneManager );

        // ONE map per pass, covering every record, with advanceFrame = true.
        //
        // GL3PlusBufferInterface::map() computes its offset as
        //     mInternalBufferStart + elementStart + mInternalNumElements * dynamicCurrentFrame
        // where dynamicCurrentFrame is ALWAYS (current + 1) % multiplier — bAdvanceFrame only
        // decides whether that copy also becomes the current one (mFinalBufferStart). So one
        // advance=true call writes to and commits the same copy: the copy this pass draws.
        //
        // Two alternatives were measured and both fail for multi-object writes:
        //   * upload() maps with bAdvanceFrame = true (BufferInterface::upload), so every
        //     object rotates the ring; two objects = two rotations, and the draw reads the
        //     last copy, which is why both objects once read the same record.
        //   * map( ..., false ) targets a copy one ahead of the one being drawn, so the
        //     writes are never visible to this frame's draw at all.
        if( mMatrixBuffer )
        {
            if( mRecordsMapped )
                mMatrixBuffer->unmap( UO_KEEP_PERSISTENT );
            mRecords = reinterpret_cast<float *>(
                mMatrixBuffer->map( 0, kMaxObjects * kRecordFloats, true ) );
            mRecordsMapped = ( mRecords != nullptr );
        }
        return retVal;
    }

    //-----------------------------------------------------------------------------------
    void HlmsTensionSkin::setupRootLayout( RootLayout &rootLayout, size_t tid )
    {
        HlmsPbs::setupRootLayout( rootLayout, tid );

        // Note the signature: ( RootLayout &, const size_t tid ) — a subclass override
        // without the tid parameter does not override anything (OgreHlms.h:495).
        // PBS reserved ReadOnlyBuffer [0, 1); widen it by one so slot 1 is ours.
        DescBindingRange *ranges = rootLayout.mDescBindingRanges[0];
        ranges[DescBindingTypes::ReadOnlyBuffer].end =
            std::max<uint16>( ranges[DescBindingTypes::ReadOnlyBuffer].end,
                              kOurTexBufferSlot + 1u );
    }

    //-----------------------------------------------------------------------------------
    void HlmsTensionSkin::bindOurBuffer( CommandBuffer *commandBuffer )
    {
        *commandBuffer->addCommand<CbShaderBuffer>() =
            CbShaderBuffer( VertexShader, kOurTexBufferSlot, mMatrixBuffer, 0, 0 );
    }

    //-----------------------------------------------------------------------------------
    HlmsDatablock *HlmsTensionSkin::createDatablockImpl( IdString datablockName,
                                                         const HlmsMacroblock *macroblock,
                                                         const HlmsBlendblock *blendblock,
                                                         const HlmsParamVec &paramVec )
    {
        return OGRE_NEW HlmsTensionSkinDatablock( datablockName, this, macroblock, blendblock,
                                                  paramVec );
    }

    //-----------------------------------------------------------------------------------
    void HlmsTensionSkin::calculateHashFor( Renderable *renderable, uint32 &outHash,
                                            uint32 &outCasterHash )
    {
        HlmsPbs::calculateHashFor( renderable, outHash, outCasterHash );
        if( getProperty( "tension_skinning" ) )
        {
            outHash |= 1u << 31;
            outCasterHash |= 1u << 31;
        }
    }

    //-----------------------------------------------------------------------------------
    void HlmsTensionSkin::calculateHashForPreCreate( Renderable *renderable,
                                                     PiecesMap *inOutPieces )
    {
        // The base first. For a mesh with blend data and no SkeletonInstance it is the
        // *fill*, not the hash, that crashes — so this is safe on that state.
        HlmsPbs::calculateHashForPreCreate( renderable, inOutPieces );

        if( dynamic_cast<HlmsTensionSkinDatablock *>( renderable->getDatablock() ) == nullptr )
            return;

        setProperty( "tension_skinning", 1 );
        // The instance struct (worldMaterialIdx[], and with it inVs_drawId) is declared
        // only when one of hlms_skeleton / hlms_shadowcaster / hlms_pose / metal /
        // lower_gpu_overhead is on. We need inVs_drawId, so force it on.
        setProperty( "lower_gpu_overhead", 1 );

        String &decl = inOutPieces[VertexShader][IdString( "custom_vs_uniformDeclaration" )];
        // NOT "layout(binding = 1) uniform samplerBuffer": under GL3Plus, OGRE binds a
        // ReadOnlyBufferPacked as an SSBO (layout(std430, binding = slot), see the
        // ReadOnlyBufferF macro and PBS's own declaration of worldMatBuf). A texture
        // buffer lives in a different GL binding namespace, so a hand-written
        // samplerBuffer never receives the data — measured: every texelFetch returned 0.
        decl += "ReadOnlyBufferF( 1, float4, tensionMatrixBuf );\n";

        // custom_vs_preTransform, NOT custom_vs_posExecution. The template inserts
        // preTransform at the top of @piece( VertexTransform )
        // (800.VertexShader_piece_vs.any:219), before
        //     outVs_Position = mul( worldPos, passBuf.viewProj );        (:236)
        // whereas posExecution runs after the whole body, where only the clip position
        // is still live — a write to outVs.pos there moves the lighting, not the
        // geometry. Here worldPos is in scope, so the record moves the object in world
        // space and both axes work.
        String &exec = inOutPieces[VertexShader][IdString( "custom_vs_preTransform" )];
        exec += "// TENSION-SKIN: the record for this object, by draw id.\n";
        exec += "{ float4 tensionRec = readOnlyFetch( tensionMatrixBuf, int( inVs_drawId ) );\n";
        exec += "  worldPos.xyz += tensionRec.xyz; }\n";
    }

    //-----------------------------------------------------------------------------------
    uint32 HlmsTensionSkin::fillBuffersFor( const HlmsCache *cache,
                                            const QueuedRenderable &queuedRenderable, bool casterPass,
                                            uint32 lastCacheHash, uint32 lastTextureHash )
    {
        OGRE_EXCEPT( Exception::ERR_NOT_IMPLEMENTED,
                     "Trying to use slow-path on a desktop implementation.",
                     "HlmsTensionSkin::fillBuffersFor" );
    }

    //-----------------------------------------------------------------------------------
    uint32 HlmsTensionSkin::fillBuffersForV1( const HlmsCache *cache,
                                              const QueuedRenderable &queuedRenderable,
                                              bool casterPass, uint32 lastCacheHash,
                                              CommandBuffer *commandBuffer )
    {
        return fillBuffersForV2( cache, queuedRenderable, casterPass, lastCacheHash, commandBuffer );
    }

    //-----------------------------------------------------------------------------------
    uint32 HlmsTensionSkin::fillBuffersForV2( const HlmsCache *cache,
                                              const QueuedRenderable &queuedRenderable,
                                              bool casterPass, uint32 lastCacheHash,
                                              CommandBuffer *commandBuffer )
    {
        // Only the main pass writes records: a caster pass draws the same objects with
        // draw ids the main shader never sees.
        if( casterPass || !mMatrixBuffer )
            return HlmsPbs::fillBuffersForV2( cache, queuedRenderable, casterPass, lastCacheHash,
                                              commandBuffer );

        // Bind BEFORE the base records the draw: the bind command must precede the draw
        // command that samples it.
        bindOurBuffer( commandBuffer );

        // The base's return value IS the object's identity: RenderQueue stores it as
        // CbDrawIndexed::baseInstance (OgreRenderQueue.cpp:794; baseInstanceShift is 0
        // unless instanced stereo is on), and drawId — a vertex buffer of 0..N-1 bound
        // as an instanced attribute at location 15 with divisor 1 — starts at
        // baseInstance. So the shader's inVs_drawId equals this value.
        const uint32 baseInstance = HlmsPbs::fillBuffersForV2( cache, queuedRenderable, casterPass,
                                                               lastCacheHash, commandBuffer );

        if( baseInstance >= kMaxObjects )
            return baseInstance;  // no record for this one; the shader reads zeros

        // The records exist to be *distinguishable*: record i displaces its object by
        // (-3 + 3i) world units in x. Three identical objects at the same scene node
        // therefore appear in three different places — which they cannot do unless each
        // object read its own record. Replace this with the bone matrices themselves and
        // the channel is the adapter's.
        float record[4] = {0.0f, 0.0f, 0.0f, 0.0f};
        if( sChannelEnabled )
            record[0] = -3.0f + 3.0f * float( baseInstance );

        if( mRecords )
        {
            float *dst = mRecords + baseInstance * kRecordFloats;
            dst[0] = record[0];
            dst[1] = record[1];
            dst[2] = record[2];
            dst[3] = record[3];
        }

        sLastWrite[0] = record[0];
        sLastWrite[1] = record[1];
        ++sObjectCounter;

        // The one line worth keeping: which object (baseInstance) got which record.
        LogManager::getSingleton().logMessage(
            "TENSION-SKIN fill: baseInstance=" + StringConverter::toString( baseInstance ) +
            " record=(" + StringConverter::toString( record[0] ) + ", " +
            StringConverter::toString( record[1] ) + ", " +
            StringConverter::toString( record[2] ) + ")" );

        return baseInstance;
    }
}  // namespace Ogre
