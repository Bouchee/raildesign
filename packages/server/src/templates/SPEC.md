---
id: submodule-server-templates
type: submodule-design
status: active
title: templates — RailDesign prompt file CRUD
parent: module-server
depends-on: [module-contracts]
tags: [templates, public-surface-checked]
---

## Scope / trigger

Prompt file CRUD uses RailDesign directories and the installed YAML parser. It does not read pi
configuration, credentials or prompt files. The host resolves the optional project/workspace path.

## Public surface

`TemplateDirs`, `templateDirs`, `isValidTemplateName`, `listTemplates`, `getTemplate`, `saveTemplate`, `deleteTemplate`.

## Signatures

`templateDirs(cwd?, directory=dataDir())`, `isValidTemplateName(name)`, `listTemplates(dirs)`,
`getTemplate(dirs,name,scope?)`, `saveTemplate(dirs,scope,name,content)` and
`deleteTemplate(dirs,scope,name)` operate on explicit directory ownership.

`TemplateDirs` contains `globalDir` and optional `projectDir`. The default global directory is
`<dataDir>/prompts`; the project directory is `<cwd>/.raildesign/prompts`. An explicit directory is
available to isolated callers/tests. Allowed dependencies: `contracts`, `persistence`, `yaml`, Node fs/path.

## Contracts

Templates are Markdown files. The filename without `.md` is the name. Project names shadow global
names; list results are sorted. Full file content is returned unchanged. A closed YAML frontmatter
header may provide string `description` and `argument-hint` (returned as `argumentHint`). Missing or
incomplete headers have no metadata. Listing reads only an 8 KiB metadata head and skips invalid
files; direct reads validate the full file. Files are limited to 1 MiB before reading or writing.

## Validation and errors

- Empty/dot-leading names, separators, NUL and colon reject before path access.
- Missing files, non-regular files and symlinked entries are unavailable; writes refuse to follow them.
- A symlinked project config directory or prompts directory makes project reads empty and writes fail.
  The user-owned global directory may be a symlink.
- A closed malformed YAML header rejects get/save. Save validates before creating any destination.
  Listing skips only the bad file and keeps valid siblings.
- Project operations without `projectDir` reject. Oversized files reject on direct get/save and are
  omitted from lists. Filesystem write failures propagate.

## Good / base / bad cases

A project `review.md` overrides a global `review.md`. A plain Markdown body returns no fabricated
metadata. A malformed header or a project symlink cannot create an orphan file or expose its target.

## Tests required

`templates.test.ts` covers directory ownership, YAML scalars, BOM, exact content, precedence, malformed
headers, size bounds, filename validation and symlink containment. Host tests cover resolving a
pre-session project checkout and rejecting ambiguous workspace/project locations.

## Wrong / correct

Read `<dataDir>/prompts` and `<cwd>/.raildesign/prompts`. Reading an external agent directory or
`<cwd>/.pi/prompts` would import obsolete product data. Preserve the YAML parser's rejection before a
write rather than treating malformed input as metadata-free content.
