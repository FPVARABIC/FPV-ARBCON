/**
 * THE OFFICIAL LOGO - browser resolution of the asset.
 *
 * Vite resolves this file instead of brandLogoSource.ts (resolve
 * .extensions puts `.web.*` first) and serves fpvArabicLogo.webp as an
 * ordinary hashed static asset - the exact committed bytes, cache-busted
 * by content hash, decoded by the browser. `import.meta`-typed by
 * `vite/client` (already in tsconfig.web.json's types), so no ambient
 * declaration is needed.
 */

import type {ImageSourcePropType} from 'react-native';

import brandLogoUri from './fpvArabicLogo.webp';

export const BRAND_LOGO_SOURCE: ImageSourcePropType = {uri: brandLogoUri};
