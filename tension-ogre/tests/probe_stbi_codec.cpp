// Does this Ogre-Next build have a working image codec?
//
// STBI is the only image codec this tree ships: FreeImage is compiled out
// (OGRE_NO_FREEIMAGE) and Ogre-Next has no Codec_* plugins at all — STBI lives
// inside OgreNextMain (OgreMain/CMakeLists.txt:359-362) and is registered by
// Ogre::Root (OgreRoot.cpp:271-273) when OGRE_NO_STBI_CODEC is undefined.
//
// So "the texture loaded" is not observable from any other test in this repo:
// every in-tree asset is pre-converted to DDS, which has its own codec. A build
// with no image codec at all passed the whole suite once. This probe exists to
// make that specific hole impossible to reopen.
//
// It is deliberately hermetic: the PNG below is embedded, not read from disk, so
// the expectation cannot drift with an asset and the test runs anywhere. The
// pixels are known, so a decode that returns the right dimensions but the wrong
// bytes still fails.
//
// Usage:  probe_stbi_codec            run the embedded case
//         probe_stbi_codec <file.png>  also decode a real file (dimensions only)

#include "OgreDataStream.h"
#include "OgreImageCodec2.h"
#include "OgreLogManager.h"
#include "OgrePixelFormatGpu.h"
#include "OgreSTBICodec.h"

#include <cstdio>
#include <cstring>
#include <fstream>
#include <iterator>
#include <string>
#include <vector>

namespace
{
    // 2x2 RGBA, 75 bytes. Row 0: red, green. Row 1: blue, white.
    // Generated once and pinned; the CRC in IHDR/IDAT is what makes it a legal
    // PNG rather than a byte blob STBI happens to accept.
    const unsigned char kPng[] = {
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
        0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x02,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x72, 0xb6, 0x0d, 0x24, 0x00, 0x00, 0x00,
        0x12, 0x49, 0x44, 0x41, 0x54, 0x78, 0xda, 0x63, 0xf8, 0xcf, 0xc0, 0xf0,
        0x1f, 0x0c, 0x81, 0x34, 0x18, 0x00, 0x00, 0x49, 0xc8, 0x09, 0xf7, 0x03,
        0xd9, 0x64, 0xf1, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
        0x42, 0x60, 0x82,
    };
    constexpr size_t kPngSize = sizeof( kPng );

    // Row-major RGBA8, matching kPng above.
    const unsigned char kExpectedPixels[16] = {
        255, 0,   0,   255,   0,   255, 0,   255,
        0,   0,   255, 255,   255, 255, 255, 255,
    };

    int failures = 0;

    void check( bool condition, const char *what )
    {
        if( !condition )
        {
            std::printf( "  FAIL %s\n", what );
            ++failures;
        }
        else
        {
            std::printf( "  ok   %s\n", what );
        }
    }

    /// Decode `bytes` with the registered codec for the PNG magic number, exactly
    /// as Ogre::Image2 does: magic lookup first, then decode.
    ///
    /// The magic probe length matters: Ogre::Image2 hands over
    /// min(stream->size(), 128) bytes (OgreImage2.cpp:682-687), and
    /// STBIImageCodec::magicNumberToFileExt only matches PNG when it is given at
    /// least the 8-byte signature (OgreSTBICodec.cpp:243). Passing 4 here would
    /// test a path no caller takes.
    bool decodePng( const void *bytes, size_t size, const char *label,
                    Ogre::ImageCodec2::ImageData2 const **outData )
    {
        // Codec::getCodec wants a mutable pointer but does not write through it.
        char *magic = const_cast<char *>( static_cast<const char *>( bytes ) );
        const size_t magicLen = size < 128u ? size : 128u;
        Ogre::Codec *codec = Ogre::Codec::getCodec( magic, magicLen );
        if( codec == nullptr )
        {
            std::printf( "  FAIL %s: no codec claims the PNG magic number\n", label );
            ++failures;
            return false;
        }
        if( codec->getType() != "png" )
        {
            std::printf( "  FAIL %s: magic number mapped to '%s', expected 'png'\n", label,
                         codec->getType().c_str() );
            ++failures;
            return false;
        }

        Ogre::DataStreamPtr stream( new Ogre::MemoryDataStream(
            const_cast<void *>( bytes ), size, /*freeOnClose*/ false ) );

        Ogre::Codec::DecodeResult result;
        try
        {
            result = codec->decode( stream );
        }
        catch( const std::exception &e )
        {
            std::printf( "  FAIL %s: decode threw: %s\n", label, e.what() );
            ++failures;
            return false;
        }

        const Ogre::ImageCodec2::ImageData2 *data =
            static_cast<const Ogre::ImageCodec2::ImageData2 *>( result.second.get() );
        if( data == nullptr || data->box.data == nullptr )
        {
            std::printf( "  FAIL %s: decoded no pixel data\n", label );
            ++failures;
            return false;
        }
        std::printf( "  %s: %ux%u %s, %zu bytes, %u bytes/row\n", label, data->box.width,
                     data->box.height, Ogre::PixelFormatGpuUtils::toString( data->format ),
                     data->box.bytesPerImage, data->box.bytesPerRow );
        *outData = data;
        return true;
    }

    int runEmbedded()
    {
        std::printf( "embedded 2x2 RGBA PNG, %zu bytes\n", kPngSize );

        const Ogre::ImageCodec2::ImageData2 *data = nullptr;
        if( !decodePng( kPng, kPngSize, "embedded", &data ) )
            return 1;

        check( data->box.width == 2u && data->box.height == 2u, "dimensions are 2x2" );
        check( data->format == Ogre::PFG_RGBA8_UNORM, "format is PFG_RGBA8_UNORM" );
        check( data->box.bytesPerImage == 16u, "decoded 16 bytes for 2x2 RGBA8" );
        check( data->box.bytesPerRow == 8u, "row stride is 8 bytes" );

        if( data->box.bytesPerImage == sizeof( kExpectedPixels ) &&
            data->box.bytesPerRow == 8u )
        {
            // bytesPerRow is the stride; rows are contiguous here, so a flat
            // compare of the first 16 bytes is exact.
            check( std::memcmp( data->box.data, kExpectedPixels, sizeof( kExpectedPixels ) ) == 0,
                   "pixels are red, green, blue, white in row-major RGBA" );
        }
        else
        {
            check( false, "pixel comparison (buffer size did not match expectation)" );
        }
        return failures == 0 ? 0 : 1;
    }

    int runFile( const char *path )
    {
        std::ifstream in( path, std::ios::binary );
        if( !in )
        {
            std::printf( "FAIL: cannot open %s\n", path );
            return 1;
        }
        std::vector<char> bytes( ( std::istreambuf_iterator<char>( in ) ),
                                 std::istreambuf_iterator<char>() );
        std::printf( "file %s, %zu bytes\n", path, bytes.size() );

        const Ogre::ImageCodec2::ImageData2 *data = nullptr;
        if( !decodePng( bytes.data(), bytes.size(), "file", &data ) )
            return 1;

        // No pinned expectation for an arbitrary file: assert the buffer is
        // self-consistent, which a header-only parse would not satisfy.
        check( data->box.width > 0u && data->box.height > 0u, "dimensions are non-zero" );
        check( data->box.bytesPerRow >= data->box.width * 4u, "row stride covers the width" );
        check( data->box.bytesPerImage >= data->box.bytesPerRow * data->box.height,
               "image size covers every row" );
        return failures == 0 ? 0 : 1;
    }
}  // namespace

int main( int argc, char **argv )
{
    // STBIImageCodec::startup() logs, and Root always has a LogManager by the
    // time it calls it. Construct one so this probe exercises the same call
    // Ogre makes, rather than constructing a codec directly and testing an
    // assembly path no application takes.
    Ogre::LogManager logManager;
    Ogre::STBIImageCodec::startup();

    std::printf( "probe_stbi_codec: image codec registration and decode\n" );

    int status = runEmbedded();
    if( status == 0 && argc > 1 )
        status = runFile( argv[1] );

    if( status == 0 )
        std::printf( "PASS: STBI codec registered and decoded PNG\n" );
    else
        std::printf( "FAIL: %d check(s) failed\n", failures );
    return status;
}
