/**
 * Raft DEBUG hotkeys (§I raft/input, §V84): the hotkey path exists for dev
 * work and is INERT for play. Two gates, both live callbacks: the dev layer
 * must be on, and the first-person walker must NOT own the lens (aboard, the
 * same letters walk). Every press is forwarded as a signed channel step; the
 * raft wiring adds it to `RaftControls` exactly as it applies station values,
 * so a key that reaches here and changes nothing is the wiring's §V62 defect,
 * not this file's.
 *
 * Keys: A/D oar ∓, Q/E forward/aft guara group deeper (Shift raises), W/S
 * sheet ±, Y tune + (Shift −), N skip-to-dawn. `J` (jump-to-island) is
 * `debug/jump.ts`'s and is not duplicated here.
 */
import { CONTROL_CODES } from '../input/controlMap';
import { playerParams } from '../params/player';

export type DebugChannel = 'oar' | 'guara-fwd' | 'guara-aft' | 'sheet' | 'tune' | 'dawn';

export interface DebugKeyHost {
  isDevLayerOn(): boolean;
  isPlayerActive(): boolean;
  /** `delta` is ±playerParams.debugStep for channels, 1 for `dawn` */
  onDebug(channel: DebugChannel, delta: number): void;
}

/** pure: what a keydown means, or null when it is not a debug key */
export function debugKeyAction(code: string, shift: boolean, step: number = playerParams.debugStep): { channel: DebugChannel; delta: number } | null {
  const s = Number.isFinite(step) ? step : 0;
  const sign = shift ? -1 : 1;
  switch (code) {
    case CONTROL_CODES.debugOarPort:
      return { channel: 'oar', delta: -s };
    case CONTROL_CODES.debugOarStarboard:
      return { channel: 'oar', delta: s };
    case CONTROL_CODES.debugGuaraFwd:
      return { channel: 'guara-fwd', delta: s * sign };
    case CONTROL_CODES.debugGuaraAft:
      return { channel: 'guara-aft', delta: s * sign };
    case CONTROL_CODES.debugSheetIn:
      return { channel: 'sheet', delta: s };
    case CONTROL_CODES.debugSheetOut:
      return { channel: 'sheet', delta: -s };
    case CONTROL_CODES.debugTune:
      return { channel: 'tune', delta: s * sign };
    case CONTROL_CODES.debugDawn:
      return { channel: 'dawn', delta: 1 };
    default:
      return null;
  }
}

function inTextField(e: KeyboardEvent): boolean {
  const t = e.target as { tagName?: string; isContentEditable?: boolean } | null;
  return Boolean(t?.isContentEditable) || /^(INPUT|TEXTAREA|SELECT)$/.test(t?.tagName ?? '');
}

export function attachDebugKeys(target: EventTarget, host: DebugKeyHost): () => void {
  const onDown = (e: Event): void => {
    const ke = e as KeyboardEvent;
    if (ke.metaKey || ke.altKey || ke.ctrlKey || inTextField(ke)) return;
    if (!host.isDevLayerOn() || host.isPlayerActive()) return;
    const a = debugKeyAction(ke.code, Boolean(ke.shiftKey));
    if (a === null) return;
    if (a.channel === 'dawn' && ke.repeat) return;
    host.onDebug(a.channel, a.delta);
  };
  target.addEventListener('keydown', onDown);
  return () => target.removeEventListener('keydown', onDown);
}
