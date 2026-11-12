---
id: module-pi-ask-user-question
type: module-design
status: active
title: Pure question schema and response helpers
parent: architecture
tags: [questions, questionnaire]
---

## Responsibility and public surface

`@thinkrail/ask-user-question` supplies question schemas, validation and response helpers.
The root exports the core and schema surfaces.
The `./core` entry supplies engine-independent argument, result and response types and helpers.
There is no Pi factory, terminal UI or dialog execution path.
The package does not inspect model messages or choose tool batches. SDK dispatch owns execution.

## Question contract

The tool name remains `ask_user_question`.
The schema defines question text, short headers, options, multiple selection and preview fields.
The core defines the option and header limits.
Question text and option labels must be unique within their applicable scope.
Reserved escape labels cannot appear as authored options.
The UI supplies free text, discussion and skip controls.

File previews require explicit host support.
A preview cannot supply both inline Markdown and a preview file.
A before file requires an after file.
The host validates every referenced workspace path before approval and response execution.

Responses identify the original question index and text.
The SDK server extension also validates selection identities and duplicate responses.
Discussion responses include the reason and notes without inventing an answer.
Live and restored answers use the same response formatter.

## Pending and cancellation results

A deferred response uses the canonical `{ kind: "ack" }` details marker.
That marker never represents a completed answer.
The result tells the model to wait for the user's response.
Abandonment reports that the run stopped.
The host owns durable interaction identities, saved decisions and SDK continuation.

## Dependencies and checks

Allow TypeBox and standard JavaScript only.
Do not import SDK, host, React or terminal code.
Pure tests cover schemas, preview constraints, response text and discussion.
The server extension tests cover approval and saved-response execution.
