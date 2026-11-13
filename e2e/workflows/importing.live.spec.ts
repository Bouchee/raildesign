import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { SpecIndex, validateGraph } from "@thinkrail/spec-graph/core";
import { gitText } from "../fixtures/git";
import { E2eWire } from "../fixtures/wire";
import {
	answerImportQuestions,
	checks,
	driveTurn,
	type ImportChoice,
	importChecks,
	openSeededSession,
	runChecks,
	seedImportWorkspace,
} from "./harness";

const cases: { id: string; name: string; choice: ImportChoice }[] = [
	{ id: "I1", name: "existing durable docs are selected and adopted in place", choice: "accept" },
	{
		id: "I2",
		name: "code-only import does not offer process documents for adoption",
		choice: "no-docs",
	},
	{ id: "I3", name: "declined adoption preserves durable docs as input", choice: "decline" },
];

for (const scenario of cases) {
	test(`${scenario.id}: ${scenario.name}`, { tag: "@agent" }, async ({ page }, testInfo) => {
		test.setTimeout(960_000);
		const wire = await E2eWire.connect();
		try {
			const session = await openSeededSession(page, wire, (cwd) =>
				seedImportWorkspace(cwd, scenario.choice !== "no-docs"),
			);
			const seedCommit = gitText(session.cwd, "rev-parse", "HEAD").trim();
			const index = new SpecIndex(session.cwd);
			const finalChecks = [
				...importChecks(scenario.choice),
				checks.custom("every new file belongs to the resulting graph", ({ cwd }) => {
					const specPaths = new Set(index.contentEntries().map((entry) => entry.path));
					return (
						gitText(cwd, "ls-files", "--others", "--exclude-standard", "-z") +
						gitText(cwd, "diff", seedCommit, "--name-only", "--diff-filter=A", "-z")
					)
						.split("\0")
						.filter(Boolean)
						.every((path) => specPaths.has(path));
				}),
			];
			const beforeAnswers: {
				toolCallId: string;
				gitStatus: string;
				gitDiff: string;
				specCount: number;
			}[] = [];
			const turn = await driveTurn(
				wire,
				session,
				"/skill:importing-a-codebase This is an existing codebase without specs — set up its spec graph.",
				{
					budget: { maxMs: 900_000, maxToolCalls: 80 },
					stopWhen: [
						{
							description: "all importing artifact and decision checks pass",
							test: (log) =>
								finalChecks.every((check) => check.run({ log, cwd: session.cwd }).pass),
						},
					],
					answer: (call) => {
						const observation = {
							toolCallId: call.toolCallId,
							gitStatus: gitText(session.cwd, "status", "--porcelain"),
							gitDiff: gitText(session.cwd, "diff", seedCommit),
							specCount: new SpecIndex(session.cwd).graph().nodes.size,
						};
						beforeAnswers.push(observation);
						expect(observation.gitStatus, "no writes before the interview decision").toBe("");
						expect(observation.gitDiff, "no committed writes before the interview decision").toBe(
							"",
						);
						expect(observation.specCount).toBe(0);
						return answerImportQuestions(call, scenario.choice);
					},
					allowConfirm: () => undefined,
				},
			);
			const results = runChecks(finalChecks, { log: turn.log, cwd: session.cwd });
			await testInfo.attach("importing-proof", {
				contentType: "application/json",
				body: Buffer.from(
					JSON.stringify({
						case: scenario.id,
						sourceCommit: gitText(process.cwd(), "rev-parse", "HEAD").trim(),
						sourceStatus: gitText(process.cwd(), "status", "--porcelain"),
						session,
						seedCommit,
						finalHead: gitText(session.cwd, "rev-parse", "HEAD").trim(),
						commits: gitText(session.cwd, "log", "--format=%H %s", `${seedCommit}..HEAD`),
						...turn,
						log: turn.log.renderTranscript(),
						beforeAnswers,
						results,
						graph: { nodes: [...index.graph().nodes.values()], edges: index.graph().edges },
						validation: validateGraph(index.graph()),
						artifacts: index.contentEntries().map((entry) => ({
							path: entry.path,
							content: readFileSync(join(session.cwd, entry.path), "utf8"),
						})),
						gitStatus: gitText(session.cwd, "status", "--porcelain"),
						gitDiff: gitText(session.cwd, "diff", seedCommit),
					}),
				),
			});
			expect(turn.failure, turn.log.renderTranscript()).toBeNull();
			expect(results.filter((result) => !result.pass)).toEqual([]);
		} finally {
			wire.close();
		}
	});
}
