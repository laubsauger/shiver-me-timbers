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
   * The numbered shipboard camera stations (`src/camera/camStations.ts`).
   * Pressing a station's own key again returns to the chase, as C and H do.
   *
   * KNOWN SHARED KEYS, stated here rather than discovered later: `Digit1..3`
   * are ALSO the cascade spectrum view's wave-band selector
   * (`src/ui/cascadeViewChannel.ts`), which only acts on them while that
   * full-screen debug instrument is open. The camera does not swallow them, so
   * both owners keep their binding; the only consequence is that closing the
   * view leaves the lens at whichever station was pressed. `Digit4` is the
   * camera's alone. Everything else on the row is free: freeCam swallows only
   * W/A/S/D/R/F, combatArena takes B/N/V/M/J/P, the jump takes J, gunnery the
   * arrows and the right mouse button, and the panel's search box stops
   * propagation on keydown.
   */
  cameraStationGun: 'Digit1',
  cameraStationBow: 'Digit2',
  cameraStationStern: 'Digit3',
  cameraStationNest: 'Digit4',
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
      {
        keys: ['1'],
        action: 'Gun station',
        hint: 'Astride the middle gun of the broadside, sighting along the barrel',
      },
      { keys: ['2'], action: 'Bow station', hint: 'On the stem head, over the bow wave' },
      { keys: ['3'], action: 'Stern station', hint: 'At the taffrail, looking back down the wake' },
      { keys: ['4'], action: 'Crow’s nest', hint: 'The masthead lookout' },
      {
        keys: ['1', '2', '3', '4'],
        action: 'Leave a station',
        hint: 'Press the station’s own key again; drag the mouse to look around while there',
      },
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
  {
    // Read-only reference, as the anchor and gunnery bindings are — the panel
    // only calls `addBinding` on primitives (§T.52), so there is no rebinding
    // path here and this page is where a new key becomes discoverable.
    title: 'Sea instruments',
    bindings: [
      {
        keys: ['G'],
        action: 'Cascade spectrum view',
        hint: 'Shows one wave band’s own data instead of the sea; press again to return',
      },
      {
        keys: ['1', '2', '3'],
        action: 'Choose the wave band',
        hint: 'Cascade view only — these also move the camera to a station',
      },
      {
        keys: ['[', ']'],
        action: 'Step through the fields',
        hint: 'Cascade view only — height, displacement, slope, det J, λ⁻, foam',
      },
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
