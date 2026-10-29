/**
 * LANE CODECS OFF THE MAC (docs/drift/RENDER-NODE.md §Codecs). scripts/cine-sink.mjs builds its own ffmpeg lines for
 * macOS (VideoToolbox ProRes, x264) and keeps them exactly; this module adds what a Linux or Windows render node needs:
 *
 *   prores | proreshq   prores_videotoolbox exists only on macOS. Elsewhere: prores_ks, profile 3 (HQ), 10-bit 4:2:2.
 *   prores4444          elsewhere: prores_ks, profile 4 (4444), 4:4:4 — but 10-bit samples: ffmpeg's ProRes encoders
 *                       take 10-bit input only (FFmpeg 9.0.2: yuv422p10le yuv444p10le yuva444p10le), so a TRUE 12-bit
 *                       ProRes 4444 is made on the Mac. For that, render `ffv1` on the node and convert (below).
 *   ffv1                FFV1 level 3, LOSSLESS 12-bit 4:4:4 in BT.709 (the exact samples a ProRes 4444 master holds),
 *                       intra-only in .mov: joins with -c copy, ffprobe counts its frames. ~1.3–2 B/px (a 16-bit PNG
 *                       sequence measured 3.2). DaVinci does not read it: on the Mac,
 *                       `ffmpeg -i x.mov -c:v prores_videotoolbox -profile:v 4444 -pix_fmt p416le …` (RENDER-NODE.md).
 *                       Needs --depth 16.
 *   hevc10              NVENC HEVC Main10 4:2:0 (.mp4, tagged hvc1 for Apple players): previews on NVIDIA. HEVC's
 *                       highest level (6.2) allows 35,651,584 luma samples a picture, ≈ 5968² square: an 8192² clip
 *                       encodes (NVENC goes to 8192×8192) but is outside every level, and decoders may refuse it.
 *
 * `null` from laneEncoderArgs = "the sink's own line" (x264 everywhere, ProRes on macOS): nothing changes there.
 */
const MAC = process.platform === 'darwin';

/**
 * every --codec a lane accepts, its container, the bit depths it takes from the page, and bytes per pixel per frame
 * on disk, generous (drift-render.mjs BYTES_PER_PX has the measurements; scripts/drift-queue.mjs sizes whole jobs)
 */
export const LANE_CODECS = {
  x264: { ext: 'mp4', depths: [8], bytesPerPx: 0.04 },
  prores: { ext: 'mov', depths: [8, 16], bytesPerPx: 0.8 },
  proreshq: { ext: 'mov', depths: [8, 16], bytesPerPx: 0.8 },
  prores4444: { ext: 'mov', depths: [8, 16], bytesPerPx: 1.1 },
  ffv1: { ext: 'mov', depths: [16], bytesPerPx: 2.0 },
  hevc10: { ext: 'mp4', depths: [8, 16], bytesPerPx: 0.05 },
};

/** HEVC level 6.2's MaxLumaPs (ITU-T H.265 Table A.8) */
export const HEVC_MAX_LUMA_PS = 35_651_584;

/** the ffmpeg encoder a lane codec runs on this platform */
export function laneEncoder(codec) {
  if (codec === 'x264') return 'libx264';
  if (codec === 'ffv1') return 'ffv1';
  if (codec === 'hevc10') return 'hevc_nvenc';
  return MAC ? 'prores_videotoolbox' : 'prores_ks';
}

/** what this platform's encoder keeps of a 16-bit frame, for the logs (null = nothing to say) */
export function laneNote(codec) {
  if (codec === 'prores4444' && !MAC) return 'prores_ks: ProRes 4444 at 10-bit samples (no 12-bit ProRes encoder off macOS; a 12-bit master: --codec ffv1, converted on the Mac)';
  if ((codec === 'prores' || codec === 'proreshq') && !MAC) return 'prores_ks: ProRes 422 HQ, 10-bit (the CPU engine; VideoToolbox is macOS only)';
  if (codec === 'ffv1') return 'FFV1 lossless 12-bit 4:4:4 BT.709 — the intermediate of a 12-bit ProRes 4444 master (convert on the Mac)';
  if (codec === 'hevc10') return 'NVENC HEVC Main10 4:2:0 preview';
  return null;
}

/** the encoder half of the sink's ffmpeg line for codecs this module owns, else null (the sink's own line) */
export function laneEncoderArgs(codec, { threads = null, crf = '18' } = {}) {
  const t = threads !== null ? ['-threads', String(threads)] : [];
  // -g 1: every frame a keyframe (FFV1's default GOP is 300, and a lane clip must join anywhere); -slicecrc: a
  // checksum per slice, so a damaged frame is found when it is decoded
  if (codec === 'ffv1') return ['-c:v', 'ffv1', '-level', '3', '-pix_fmt', 'yuv444p12le', '-g', '1', '-slices', '24', '-slicecrc', '1', ...t];
  // constant quality (cq ≈ x264's crf scale), no bitrate cap; hvc1: QuickTime / AVFoundation do not play hev1
  if (codec === 'hevc10') return ['-c:v', 'hevc_nvenc', '-profile:v', 'main10', '-pix_fmt', 'p010le', '-preset', 'p5', '-tune', 'hq', '-rc', 'vbr', '-cq', String(crf), '-b:v', '0', '-tag:v', 'hvc1'];
  if (MAC) return null;
  // vendor apl0: Apple's decoders and Final Cut treat the file as Apple-made ProRes (the edit masters do the same)
  if (codec === 'prores4444') return ['-c:v', 'prores_ks', '-profile:v', '4', '-vendor', 'apl0', '-pix_fmt', 'yuv444p10le', ...t];
  if (codec === 'prores' || codec === 'proreshq') return ['-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', ...t];
  return null;
}

/** does this ffmpeg have the encoder? (`ffmpeg -encoders` lists " V....D libx264  …") */
export function hasEncoder(encodersListing, name) {
  return new RegExp(`^\\s*V\\S*\\s+${name}\\s`, 'm').test(encodersListing);
}
