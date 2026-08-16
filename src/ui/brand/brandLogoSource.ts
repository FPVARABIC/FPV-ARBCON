/**
 * THE OFFICIAL LOGO - Android/Metro resolution of the asset.
 *
 * The operator supplied the exact image in fpvArabicLogo.webp and it is
 * committed byte-for-byte (sha256 a6099046f6f3db3edc1ff639894e31de1ceb
 * 0773fdebfdd71bd50abfab076ec7, 122,934 bytes, WebP 1024x1536 with a real
 * alpha channel). It is never redrawn, recompressed or traced - every
 * surface renders these bytes.
 *
 * This file is the NATIVE half of the asset seam and goes through the
 * NORMAL pipeline on every runtime rather than an inline data URI:
 *   - Metro: `require()` of a .webp registers a real bundled asset
 *     (webp is in Metro's default assetExts) and Android decodes WebP
 *     natively.
 *   - Jest: @react-native/jest-preset's assetFileTransformer stubs the
 *     same require, so component tests exercise the real module graph.
 *   - Vite never sees this file: brandLogoSource.web.ts shadows it via
 *     resolve.extensions, importing the same .webp as a hashed static
 *     asset URL.
 *
 * tsconfig.web.json excludes THIS file (same precedent as the TurboModule
 * spec): `require` is a Metro/Node construct the browser project has no
 * types for, and the .web sibling is what that project actually resolves.
 */

import type {ImageSourcePropType} from 'react-native';

export const BRAND_LOGO_SOURCE: ImageSourcePropType =
  require('./fpvArabicLogo.webp') as ImageSourcePropType;
