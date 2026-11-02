/**
 * This Mac's card and the boxes' heartbeats (scripts/drift-fleet.mjs, shown by scripts/drift-dash.mjs; the other
 * machines' cards are the studio-farm package's src/fleet.mjs, tested there). What a wrong merge would hide:
 *   - THE NEWEST HEARTBEAT PER BOX, whichever worker sent it: a box that moved to the studio-farm worker shows its GPU
 *     picture through the hub, and an older drift-node /report never covers a newer one (nor the other way round).
 *   - THIS MAC IN THE FARM: its farm state, its worker only while the hub hears it, its farm job shown once.
 */
import { describe, expect, it } from 'vitest';
import { farmHeartbeats, macCard, newestHeartbeats } from '../scripts/drift-fleet.mjs';

const NOW = 1_800_000_000_000;

describe('this Mac\'s card and the heartbeats', () => {
  it('this Mac is rendering while a render slot is held', () => {
    expect(macCard({ host: 'm', machine: {}, slots: { held: [{ label: 'review clip 300–330 s' }], limit: 2, waiting: [] } })).toMatchObject({ badge: 'rendering', slots: { held: 1, jobs: ['review clip 300–330 s'] } });
  });

  // (the user, 2026-11-02, after linux-monster moved to the studio farm's worker: "the Linux box is not telling us
  // anymore what is using VRAM … it's eating everything" — our own 2-lane render): the farm worker's GPU picture, through
  // the hub, makes the card's "ours" and its named others again, newer than the old worker's last heartbeat
  it('a studio-farm worker\'s GPU picture is the box\'s heartbeat: ours and the others named', () => {
    const old = { node: 'linux-monster', seen: NOW - 3_600_000, state: 'idle', vram: { oursGB: 0 }, foreign: [] };
    const workers = [{ node: 'linux-monster', gpu: { at: NOW - 4000, gpu: { name: 'NVIDIA GeForce RTX 4090', utilPct: 100, memUsedGB: 21.5, memTotalGB: 24 }, vram: { usedGB: 21.5, totalGB: 24, oursGB: 17.4, foreignGB: 3.9, freeGB: 2.5 }, foreign: [{ name: 'ComfyUI', memGB: 3.9 }] } }, { node: 'eeg-msi', gpu: null }];
    const hbs = newestHeartbeats([old], farmHeartbeats(workers));
    expect(hbs).toHaveLength(1);
    expect(hbs[0]).toMatchObject({ node: 'linux-monster', seen: NOW - 4000, foreign: [{ name: 'ComfyUI', memGB: 3.9 }] });
    expect(hbs[0]).toMatchObject({ gpu: { memUsedGB: 21.5 }, vram: { oursGB: 17.4, foreignGB: 3.9 }, via: 'farm' });
    // (an old drift-node heartbeat newer than the farm's picture still wins: windows-monster, eeg-msi on /report)
    expect(newestHeartbeats([{ ...old, seen: NOW }], farmHeartbeats(workers))[0].seen).toBe(NOW);
  });

  // (the user, 2026-11-02: "accept, drain, pause and remove toggles in the dashboard, so we can join in or out of the
  // render farm"): the card's controls act on what the hub says of this Mac's worker, and only while it runs
  it('this Mac in the farm: its farm state and moves, its worker only while the hub hears it, its farm job shown once', () => {
    const farmJob = { id: 'j1', node: 'laubs-mbp', state: 'running', label: 'node drift-review-stills.mjs a.json', startedAt: NOW };
    const c = macCard({
      host: 'laubs-mbp', machine: {},
      slots: { held: [{ label: 'farm j1 node drift-review-stills.mjs a.json', cmd: 'farm j1 node drift-review-stills.mjs a.json' }, { label: 'review clip', cmd: 'node scripts/drift-review-clip.mjs' }], limit: 2, waiting: [] },
      farm: [farmJob, { id: 'j0', node: 'laubs-mbp', state: 'done' }, { id: 'j2', node: 'linux-monster', state: 'running' }],
      farmState: { state: 'paused', at: NOW, by: 'x', actions: ['accepting', 'removed'] },
      worker: { node: 'laubs-mbp', state: 'busy-foreign', why: 'local jobs first: 1 waiting for a slot', seen: NOW },
    });
    expect(c).toMatchObject({ farmState: 'paused', farmActions: ['accepting', 'removed'], excluded: 'paused from the dashboard', farm: { id: 'j1' }, farmWorker: { state: 'busy-foreign', why: 'local jobs first: 1 waiting for a slot' } });
    // (the farm job's own slot is the job itself, not a second line of local work)
    expect(c.slots.jobs).toEqual(['review clip']);
    // a worker the hub no longer hears: no controls (the card says how to start it), and no farm state is made up
    expect(macCard({ host: 'laubs-mbp', machine: {}, slots: { held: [], limit: 1, waiting: [] }, farmState: { state: 'paused', actions: [] }, worker: { node: 'laubs-mbp', state: 'offline' } }).farmWorker).toBeNull();
    expect(macCard({ host: 'm', machine: {}, slots: { held: [], limit: 1, waiting: [] } })).toMatchObject({ farmState: undefined, farmWorker: null, farm: null });
  });
});
