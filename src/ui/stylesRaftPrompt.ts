/**
 * Station prompt stylesheet (§T.116, §V21). Same brass-and-plaque language as
 * the binnacle: a clipped-corner plate, small caps, the engraved keycap the
 * settings screen and the quick-controls card already use (`.smt-key`, one
 * definition, in stylesSettings.ts).
 *
 * NOTHING HERE TRANSITIONS. The fade is stepped in JS against the frame's own
 * dt (raftPrompt.ts) for two reasons: the plaque MOVES every frame — it is
 * pinned to a socket on a raft that pitches — so a CSS transition on the
 * element would fight the transform, and `prefers-reduced-motion` then has one
 * owner (the fade step) rather than a CSS rule and a JS path that can disagree.
 *
 * Positioning is `transform` only, off the top-left corner, so the label costs
 * one composited layer move per frame and never a layout.
 */

export const PROMPT_CSS = /* css */ `
/* the layer carries .smt-ui as well, which is what positions and stacks it —
   re-declaring \`position\` here would silently override that (this block is
   injected last, and both selectors are one class). Only the clipping is ours. */
.smt-prompt-layer { overflow: hidden; }
.smt-prompt {
  position: absolute; top: 0; left: 0; display: flex; align-items: center; gap: 3px;
  flex-direction: column;
  padding: 5px 12px 6px; white-space: nowrap; will-change: transform, opacity;
  color: var(--parch-hi);
  background: linear-gradient(180deg, rgba(12, 9, 5, 0.78), rgba(6, 4, 2, 0.72));
  box-shadow:
    inset 0 0 0 1px rgba(223, 192, 109, 0.34),
    0 3px 10px rgba(2, 14, 18, 0.45);
  clip-path: polygon(8px 0, calc(100% - 8px) 0, 100% 50%, calc(100% - 8px) 100%,
    8px 100%, 0 50%);
}
.smt-prompt-name {
  font-size: 14px; letter-spacing: 0.085em; font-variant-caps: small-caps;
  text-shadow: 0 1px 2px rgba(4, 18, 22, 0.9);
}
/* the drag hint that replaces name + key while the hands are busy: lower case,
   lighter, an instruction rather than a nameplate */
.smt-prompt-verb {
  font-size: 12.5px; letter-spacing: 0.14em; color: var(--brass-hi); opacity: 0.9;
  text-shadow: 0 1px 2px rgba(4, 18, 22, 0.9);
}
/* §T.136 — the plaque is two rows now: the nameplate, and underneath it what
   the hands are being asked to DO and where the channel currently stands. The
   second row exists only while a station is HELD (or, dimmed, when it is out
   of reach), so an idle prompt is the same one-line plaque §T.116 shipped. */
.smt-prompt-line { display: flex; align-items: center; gap: 8px; }
/* the gesture: 'mouse up: hoist · down: lower'. Lower case and quieter than
   the nameplate — an instruction, not a title. */
.smt-prompt-gesture {
  font-size: 11.5px; letter-spacing: 0.06em; color: var(--parch-hi); opacity: 0.72;
  text-shadow: 0 1px 2px rgba(4, 18, 22, 0.9);
}
/* the live channel. USER: "there's also no visual feedback as to if there's
   anything happening or not" — so the bar is the thing that MOVES while the
   mouse moves, and the readout is the number beside it. */
.smt-prompt-bar {
  position: relative; width: 54px; height: 4px; flex: 0 0 auto;
  background: rgba(4, 18, 22, 0.55);
  box-shadow: inset 0 0 0 1px rgba(223, 192, 109, 0.28);
}
.smt-prompt-fill {
  position: absolute; top: 0; bottom: 0; left: 0; width: 0;
  background: linear-gradient(180deg, var(--brass-hi), var(--brass));
}
.smt-prompt-readout {
  font-size: 11.5px; letter-spacing: 0.06em; color: var(--brass-hi);
  font-variant-numeric: tabular-nums;
  text-shadow: 0 1px 2px rgba(4, 18, 22, 0.9);
}
.smt-prompt-release { font-size: 11px; letter-spacing: 0.06em; opacity: 0.55; }
/* §T.136d — "step closer": the answer to a station being looked at from out of
   arm's reach, which used to be silence and therefore unreadable. */
.smt-prompt-far {
  font-size: 11.5px; letter-spacing: 0.1em; font-variant-caps: small-caps;
  color: var(--parch-hi); opacity: 0.6;
}
/* the brass diamond that marks a station in reach but not looked at. Same
   lozenge as the compass lubber mark and the fleuron, 7px: present enough to
   say "there is something here", too small to read as a label. */
.smt-prompt-cue {
  position: absolute; top: 0; left: 0; width: 7px; height: 7px;
  will-change: transform, opacity;
  background: linear-gradient(180deg, var(--brass-hi), var(--brass));
  box-shadow: 0 0 4px rgba(4, 18, 22, 0.95), inset 0 0 0 1px rgba(44, 33, 20, 0.45);
}
`;
