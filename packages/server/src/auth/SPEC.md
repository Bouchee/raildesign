---
id: submodule-server-auth
type: submodule-design
status: active
title: auth — provider status + in-app login
parent: module-server
depends-on: [module-contracts, module-shared]
references: [submodule-server-agent, central-integration]
tags: [auth, pi]
---

## Responsibility

Report the configuration status of RailDesign's SDK Responses endpoints. Endpoint keys and private
configuration remain inside the agent module. No provider login, OAuth mailbox, external-agent
credential discovery, JetBrains Central process or upstream configuration reader remains.

## Boundary

- **Owns:** `getProviderStatus() -> Promise<ProviderStatusReport>`.
- **Consumes:** the agent barrel's redacted configured-provider status, plus contracts types.
- **Forbidden:** reading model keys/config files directly, probing external account directories,
  importing SDK internals, network requests or native provider/service launchers.

Status means a model endpoint has usable local key configuration, not proof that the remote service
will accept a future request. Reports contain provider identity/name and configuration/auth kind only;
no keys, key-variable values, base URLs or private endpoint metadata are published.
