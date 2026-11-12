---
id: submodule-server-environment
type: submodule-design
status: active
title: environment — stored host variables
parent: module-server
depends-on: [module-contracts, module-shared]
---

## Scope / Trigger

Settings edits a host-wide ordered list of variables. `bootHost` applies it after shell repair and
before `createServer`. Model endpoint credentials belong to the agent configuration.

## Signatures

The barrel exposes `applyHostEnvironment(options?)`, `hostEnvironmentStatus()` and
`updateHostEnvironment(value: unknown)`. Only the host boot path applies saved values.

## Contracts

`HostEnvironment` is `{vars: {name:string,value:string}[]}`. `environment.get` returns the stored
record, `restartRequired` and `launchOverridden`; `environment.update` persists a valid record without
changing the running process. `<dataDir>/environment.json` uses atomic replacement and mode `0600`.
The record is requested explicitly and is absent from `server.welcome` and settings broadcasts.

Launch values win over saved values. Windows compares names without case; other systems preserve case.
Blank rows are dropped. The applied and launch snapshots are captured at boot.

## Validation & Error Matrix

- A malformed record or an unknown top-level field throws `Invalid environment record`.
- Names must match `[A-Za-z_][A-Za-z0-9_]*`; duplicate names reject the complete update.
- `PATH`, `HOME`, `USERPROFILE`, `OPENAI_API_KEY`, `THINKRAIL_*` and `RAILDESIGN_*` are reserved.
- Invalid rows return `{ok:false,issues}` and write nothing.
- Invalid stored rows are skipped at boot; diagnostics contain field/code only.
- A failed save changes neither the applied snapshot nor the stored result.

## Good / Base / Bad Cases

Good: save `PROJECT_MODE=review`; after restart it applies unless the launch already supplied it.
Base: `{vars:[]}` keeps the launch environment. Bad: a duplicate, reserved name or obsolete directory
selector rejects the update before persistence.

## Tests Required

`environment.test.ts` covers whole-record rejection, private persistence, restart behavior, launch
precedence, invalid stored rows, Windows case rules and case-sensitive systems.

## Wrong vs Correct

Wrong: update `process.env` when a settings form saves, or include saved variables in a broadcast.
Correct: persist once, expose restart status, and apply through `bootHost` after shell repair.

## Boundary

Allowed dependencies: contracts, persistence, log and shared/shellEnv. The module owns no model runtime,
credential discovery, session storage or native application action. Variable names and values are not logged.
