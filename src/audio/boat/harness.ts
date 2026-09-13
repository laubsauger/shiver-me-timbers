/**
 * §T.183 listening harness (speedboat-audio-harness.html): the real createBoatAudio + worklet,
 * driven by sliders instead of the sim. No three.js, no sim — a camera is a matrix literal.
 */
import { attachGestureResume, createEngine } from '../engine';
import { createBoatAudio, type BoatFrameTelemetry } from './boatAudio';
import { boatAudioParams } from './params';
import { VOICE_KINDS, type GovernorMode, type VoiceKind } from './engineModel';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`harness: #${id} missing`);
  return el as T;
};
const num = (id: string): number => Number($<HTMLInputElement>(id).value);
const checked = (id: string): boolean => $<HTMLInputElement>(id).checked;

const engine = createEngine({ master: 0.9 });
const audio = createBoatAudio(engine);
attachGestureResume(engine);
$('start').addEventListener('click', () => void engine.resume());

for (const sel of ['voice', 'npcVoice']) {
  const s = $<HTMLSelectElement>(sel);
  for (const k of VOICE_KINDS) s.add(new Option(k, k));
}

// labels follow their sliders
for (const el of document.querySelectorAll<HTMLInputElement>('input[type=range]')) {
  const out = document.querySelector<HTMLOutputElement>(`output[for=${el.id}]`);
  const sync = (): void => {
    if (out) out.value = el.value;
  };
  el.addEventListener('input', sync);
  sync();
}

let slamPending = 0;
let wakePending = 0;
let landingUntil = 0;
$('slam').addEventListener('click', () => (slamPending = num('slamStrength')));
$('wake').addEventListener('click', () => (wakePending = 1));
$('jump').addEventListener('click', () => (landingUntil = performance.now() + num('airTime') * 1000));

// camera: 9 m behind and 2.5 m above the transom, looking forward (-z); column-major matrixWorld
const camera = { matrixWorld: { elements: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2.5, 9, 1] } };

let last = performance.now();
let flybyX = -300;
let landingVy = 0;
const frames: BoatFrameTelemetry[] = [];

function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const throttle = num('throttle');
  const advance = num('advance');
  const airborne = checked('airborne') || now < landingUntil;
  const immersion = airborne ? 0 : num('immersion');
  const rpmOverride = checked('useRpm') ? num('rpm') : undefined;
  if (airborne) landingVy = -num('landingVy');
  const slam = slamPending;
  slamPending = 0;

  frames.length = 0;
  frames.push({
    id: 1,
    isPlayer: true,
    voice: $<HTMLSelectElement>('voice').value as VoiceKind,
    position: [0, 0, 0],
    velocity: [0, airborne ? landingVy : 0, -advance],
    enginePosition: [0, 0.8, 4.6],
    throttle,
    governor: $<HTMLSelectElement>('governor').value as GovernorMode,
    driveAdvance: [advance, advance, advance],
    driveImmersion: [immersion, immersion * 0.97, immersion],
    driveThrust: [throttle * 15000 * immersion, throttle * 15000 * immersion, throttle * 15000 * immersion],
    wettedArea: airborne ? 0 : num('wet') * 6,
    slamImpulse: slam > 0 ? slam * 1.5 * 5350 : 0,
    wakeCrossing: wakePending,
    rpm: rpmOverride !== undefined ? [rpmOverride, rpmOverride * 1.004, rpmOverride * 0.996] : undefined,
  });
  wakePending = 0;

  if (checked('flyby')) {
    const v = num('flybySpeed');
    flybyX += v * dt;
    if (flybyX > 300) flybyX = -300;
    frames.push({
      id: 2,
      voice: $<HTMLSelectElement>('npcVoice').value as VoiceKind,
      position: [flybyX, 0, num('flybyOffset')],
      velocity: [v, 0, 0],
      throttle: 1,
      driveAdvance: [v, v, v],
      propImmersion: 0.8,
      wettedArea: 5,
      slamImpulse: 0,
    });
  }
  // extra rivals far away to exercise voice stealing and tiers
  const extra = num('extraNpcs');
  for (let i = 0; i < extra; i++) {
    const a = now / 9000 + i;
    const r = 80 + 60 * i;
    frames.push({
      id: 10 + i,
      voice: VOICE_KINDS[i % VOICE_KINDS.length],
      position: [Math.cos(a) * r, 0, Math.sin(a) * r - 40],
      velocity: [-Math.sin(a) * 35, 0, Math.cos(a) * 35],
      throttle: 0.9,
      driveAdvance: [35, 35, 35],
      propImmersion: 0.85,
      wettedArea: 5,
      slamImpulse: 0,
    });
  }

  audio.update(frames, dt, camera);

  const ctx = engine.getContext();
  const r = audio.rpmOf(1);
  $('readout').textContent = [
    `context: ${ctx ? ctx.state : 'locked (click Start)'}   worklet: ${audio.ready() ? 'loaded' : (audio.error() ?? 'loading…')}`,
    `crossOriginIsolated: ${String((globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated)}`,
    `nodes: ${audio.nodeCount()} / 50`,
    r ? `rpm: ${r.rpm.map((x) => x.toFixed(0)).join(' / ')}   limiter: ${r.limiterCut.map((c) => (c ? 'CUT' : '·')).join(' ')}   overrun: ${r.overrun.map((c) => (c ? 'OVR' : '·')).join(' ')}   load: ${r.load.map((x) => x.toFixed(2)).join(' ')}` : 'rpm: —',
    `flyby x: ${checked('flyby') ? flybyX.toFixed(0) : '—'} m`,
    'NPC slots: ' + audio.slots().map((s, i) => `${i}:${s.boat < 0 ? '—' : s.boat}${s.full ? '*' : ''}(${s.phase})`).join('  '),
  ].join('\n');
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// expose for console poking
(globalThis as { boatAudioHarness?: unknown }).boatAudioHarness = { engine, audio, params: boatAudioParams };
