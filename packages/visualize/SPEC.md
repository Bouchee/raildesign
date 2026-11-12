---
id: module-pi-visualize
type: module-design
status: active
title: Pure visualization schema and result helpers
parent: architecture
tags: [visualization, mermaid]
---

## Responsibility and public surface

`@thinkrail/visualize` supplies `VisualizeSchema`, `VisualizeParams`, `ComparisonOption` and `MermaidValidator`.
It exports `validateShape`, `fileSources`, `mermaidSources`, `mermaidFence`, `fileMarkdown` and `comparisonMarkdown`.
These helpers have no engine, session or UI state.
The package has no Pi or terminal execution path.

## Tool contract

The host tool name remains `visualize`.
Arguments select a diagram, comparison or file preview.
Validated arguments remain the result details that existing renderers read.
The server extension owns SDK registration, strict Mermaid validation, grant checks and workspace file checks.
The web extension owns rich display and fallback rendering.
Syntax validation does not guarantee SVG layout success.

## Files and comparisons

File previews identify existing workspace files rather than inline content.
The optional `before` path selects a previous version.
The same file cannot supply both versions.
A preview shows the current file contents.
To keep an earlier proposal, the agent must copy it before further edits.
HTML mockups use inline CSS and data images.
Controls use styled elements because the host can remove scripts, forms and external resources.

The helpers retain model-readable Markdown for diagrams, options and files.
Shape validation rejects missing diagram source, empty options, empty labels and missing file paths.
Source enumeration identifies the exact field for a validation error.

## Dependencies and checks

Allow TypeBox and standard JavaScript only.
Do not import host, SDK, React, Mermaid, DOM or terminal libraries.
Tests cover shape rules, file comparisons, source enumeration and Markdown results.
