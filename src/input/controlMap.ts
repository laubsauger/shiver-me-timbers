/**
 * Player-facing input map. Runtime handlers import these same values, and the
 * settings Controls page renders CONTROL_GROUPS, so documentation and actual
 * bindings cannot quietly drift apart.
 */

export const CONTROL_CODES = {
  steerLeft: 'KeyA',
  steerRight: 'KeyD',
  trimInPrimary: 'KeyW',
  trimInAlternate: 'KeyE',
  trimOutPrimary: 'KeyQ',
  trimOutAlternate: 'KeyS',
  fire: 'Space',
  toggleFreeCamera: 'KeyC',
  toggleHelm: 'KeyH',
} as const;

export interface ControlBinding {
  keys: readonly string[];
  action: string;
  hint?: string;
}

export interface ControlGroup {
  title: string;
  bindings: readonly ControlBinding[];
}

export const CONTROL_GROUPS: readonly ControlGroup[] = [
  {
    title: 'Sailing',
    bindings: [
      { keys: ['A', 'D'], action: 'Turn the rudder', hint: 'Left / right' },
      { keys: ['W', 'E'], action: 'Trim sails in' },
      { keys: ['Q', 'S'], action: 'Ease sails out' },
      { keys: ['S'], action: 'Brake the ship', hint: 'Also eases the sails' },
      { keys: ['Space'], action: 'Fire broadside', hint: 'Fires toward the camera side' },
    ],
  },
  {
    title: 'Camera',
    bindings: [
      { keys: ['H'], action: 'Helm view', hint: 'Captain’s eye behind the wheel; press again to return' },
      { keys: ['C'], action: 'Free camera', hint: 'Press again to return to chase view' },
      { keys: ['Mouse drag'], action: 'Look around' },
      { keys: ['Wheel'], action: 'Zoom', hint: 'Changes travel speed in free camera' },
      { keys: ['W', 'A', 'S', 'D'], action: 'Fly camera', hint: 'Free camera only' },
      { keys: ['R', 'F'], action: 'Rise / descend', hint: 'Free camera only' },
      { keys: ['Shift', 'Ctrl'], action: 'Fast / precise flight', hint: 'Free camera only' },
    ],
  },
  {
    title: 'Interface',
    bindings: [
      { keys: ['Alt', 'Enter'], action: 'Toggle full screen' },
      { keys: ['Esc'], action: 'Pause / back' },
      { keys: ['P', 'F2'], action: 'Photo mode' },
      { keys: ['Tab', 'F1'], action: 'Show or hide dev tools' },
    ],
  },
];

export function isFullscreenShortcut(
  e: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'code'>,
): boolean {
  return (
    e.altKey &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.shiftKey &&
    (e.code === 'Enter' || e.code === 'NumpadEnter')
  );
}
