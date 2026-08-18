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
  /**
   * Drop / weigh the anchor. `KeyX` is free everywhere else — freeCam only
   * swallows W/A/S/D/R/F, combatArena takes B/V, the jump takes J, and the
   * panel's search box stops propagation on keydown.
   */
  toggleAnchor: 'KeyX',
  toggleFreeCamera: 'KeyC',
  toggleHelm: 'KeyH',
  /**
   * Gun elevation, the one lever naval gunnery is about (the hull fixes the
   * bearing). Arrows are what a player tries first and are free everywhere:
   * freeCam swallows only W/A/S/D/R/F, the sailing collector reads letter
   * codes, and nothing else listens for them. `src/combat/gunnery.ts` also
   * takes the RIGHT MOUSE BUTTON as a held aim — camInput ignores that button
   * so the lens does not orbit while the guns move.
   */
  elevateGuns: 'ArrowUp',
  depressGuns: 'ArrowDown',
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
      { keys: ['X'], action: 'Drop / weigh anchor', hint: 'At anchor she holds station whatever the canvas is doing' },
    ],
  },
  {
    title: 'Gunnery',
    bindings: [
      { keys: ['Space'], action: 'Fire broadside', hint: 'Fires the battery the camera bears on' },
      {
        keys: ['Right mouse'],
        action: 'Lay the guns',
        hint: 'Hold and move the mouse up or down to raise or lower them',
      },
      {
        keys: ['↑', '↓'],
        action: 'Raise / lower the guns',
        hint: 'Fine lay; the crosshair sits where the shot falls',
      },
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
