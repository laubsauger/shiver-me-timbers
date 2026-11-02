/**
 * The hub's hooks for the Drift's /farm/jobs (legacy-argv@1) while the Drift still sends argv: its job kinds and speed
 * classes, so speeds.json keeps learning in the classes it has (drift-render.mjs:4096, …). A hub config names this
 * file as "legacy": { "hooks": "farm/hub-hooks.mjs" }; drift-dash passes it as createFarmHub({ legacyHooks }).
 */
export { jobKind, jobClass } from './drift.adapter.mjs';
