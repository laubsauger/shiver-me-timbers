/**
 * The titles' faces (the client's note of 2026-10-31: the Avenir Next "not good enough" for the epic mood): EB Garamond
 * Italic for the crawl's copy, Pinyon Script for "the Drift". Both SIL OFL 1.1, from Google Fonts, served from
 * public/drift/fonts with their OFL.txt beside them.
 *
 * The canvases draw them by family name, so they must be in `document.fonts` and LOADED before the first frame: a 2D
 * canvas does not wait for a face, it draws the fallback (Georgia, cursive) and never tells. main-drift.ts awaits this
 * before it publishes `window.__drift`, which every headless path (review stills and clips, render lanes) waits for, so
 * no captured frame can draw a fallback. A face that fails to load fails the boot, loudly, rather than a render that
 * silently sets the title in the wrong type.
 *
 * Variant B (`?type=sans`, undertime/crawlSans.ts; the client's note of 2026-10-31: "a clean airy helvetica or arial
 * style for the main type"): Inter Light as well, SIL OFL 1.1, from the Inter Project (rsms/inter, v3.019), with its
 * OFL beside it. Loaded only on a page that draws it, so the film without the param fetches exactly what it did.
 */
import { titleType } from './undertime/crawlSans';

const FACES: Array<{ family: string; file: string; descriptors: FontFaceDescriptors }> = [
  // the variable font: one file for every weight 400–800 (the crawl draws at 560)
  { family: 'EB Garamond', file: 'EBGaramond-Italic-VF.ttf', descriptors: { style: 'italic', weight: '400 800' } },
  { family: 'Pinyon Script', file: 'PinyonScript-Regular.ttf', descriptors: {} },
];
/** variant B's face: one static weight, the one the crawl draws (crawlSans.ts SANS.font) */
const SANS_FACES: typeof FACES = [{ family: 'Inter', file: 'Inter-Light.ttf', descriptors: { weight: '300' } }];

export async function loadTitleFonts(base = `${import.meta.env.BASE_URL}drift/fonts/`): Promise<void> {
  await Promise.all(
    [...FACES, ...(titleType() === 'sans' ? SANS_FACES : [])].map(async ({ family, file, descriptors }) => {
      const face = new FontFace(family, `url(${base}${file})`, descriptors);
      try {
        await face.load();
      } catch (e) {
        throw new Error(`drift titles: the face ${family} (${base}${file}) did not load: ${String(e)}`);
      }
      document.fonts.add(face);
    }),
  );
}
