/**
 * Self-hosted type for the speedboat UI (COEP require-corp blocks Google Fonts, §T.178).
 *
 *  - Saira Stencil One (Omnibus-Type), SIL OFL 1.1, no Reserved Font Name
 *    — numerals, calls, headlines.            assets/fonts/speedboat/OFL-SairaStencilOne.txt
 *  - Saira Condensed SemiBold 600 + Bold 700 (Omnibus-Type), SIL OFL 1.1, RFN "Saira"
 *    — labels and body.                         assets/fonts/speedboat/OFL-SairaCondensed.txt
 *
 * Source: github.com/google/fonts (ofl/sairastencilone, ofl/sairacondensed), converted TTF → WOFF2
 * with fontTools, all glyphs kept and names untouched (a lossless container change, not a subset, so
 * the "Saira" RFN is not engaged). Vite hashes and serves them same-origin.
 */
import stencilUrl from '../../../assets/fonts/speedboat/SairaStencilOne-Regular.woff2?url';
import condSemiUrl from '../../../assets/fonts/speedboat/SairaCondensed-SemiBold.woff2?url';
import condBoldUrl from '../../../assets/fonts/speedboat/SairaCondensed-Bold.woff2?url';

export const STENCIL_FAMILY = '"SB Saira Stencil"';
export const COND_FAMILY = '"SB Saira Condensed"';

export const FONT_FACE_CSS = /* css */ `
@font-face { font-family: "SB Saira Stencil"; src: url("${stencilUrl}") format("woff2"); font-weight: 400; font-display: block; }
@font-face { font-family: "SB Saira Condensed"; src: url("${condSemiUrl}") format("woff2"); font-weight: 600; font-display: block; }
@font-face { font-family: "SB Saira Condensed"; src: url("${condBoldUrl}") format("woff2"); font-weight: 700; font-display: block; }
`;

/** resolves when the three faces are ready (the HUD should not flash fallback metrics) */
export function loadSpeedboatFonts(): Promise<unknown> {
  if (typeof document === 'undefined' || !document.fonts) return Promise.resolve();
  return Promise.all([
    document.fonts.load(`400 40px ${STENCIL_FAMILY}`),
    document.fonts.load(`600 16px ${COND_FAMILY}`),
    document.fonts.load(`700 16px ${COND_FAMILY}`),
  ]);
}
