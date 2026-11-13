import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { gitText } from "../fixtures/git";
import { E2eWire } from "../fixtures/wire";
import {
	answerResumeQuestion,
	driveTurn,
	openSeededSession,
	RESUME_TASK_PATH,
	resumeChecks,
	runChecks,
	seedResumeWorkspace,
} from "./harness";

test(
	"S1/S2: mid-flow brainstorming records one decision, stops and recalls it after reopening",
	{ tag: "@agent" },
	async ({ page }, testInfo) => {
		test.setTimeout(540_000);
		let wire = await E2eWire.connect();
		const proof: Record<string, unknown> = {
			sourceCommit: gitText(process.cwd(), "rev-parse", "HEAD").trim(),
			sourceStatus: gitText(process.cwd(), "status", "--porcelain"),
		};
		try {
			const session = await openSeededSession(page, wire, seedResumeWorkspace);
			const seedCommit = gitText(session.cwd, "rev-parse", "HEAD").trim();
			const taskPath = join(session.cwd, RESUME_TASK_PATH);
			const initialTask = readFileSync(taskPath, "utf8");
			const scratchIgnorePath = join(session.cwd, ".raildesign/context/.gitignore");
			const initialScratchIgnore = readFileSync(scratchIgnorePath, "utf8");
			const ignoredFiles = () =>
				gitText(session.cwd, "ls-files", "--others", "--ignored", "--exclude-standard");
			const initialIgnoredFiles = ignoredFiles();
			const beforeAnswers: unknown[] = [];
			Object.assign(proof, {
				session,
				seedCommit,
				initialTask,
				initialIgnoredFiles,
				initialScratchIgnore,
				beforeAnswers,
			});
			expect(initialIgnoredFiles.trim().split("\n")).toEqual([
				".raildesign/context/.gitignore",
				RESUME_TASK_PATH,
			]);
			expect(initialScratchIgnore).toBe("*\n");
			const unchangedWorktree = () => {
				expect(gitText(session.cwd, "diff", seedCommit)).toBe("");
				expect(gitText(session.cwd, "ls-files", "--others", "--exclude-standard")).toBe("");
				expect(ignoredFiles()).toBe(initialIgnoredFiles);
				expect(readFileSync(scratchIgnorePath, "utf8")).toBe(initialScratchIgnore);
			};
			const decision = await driveTurn(
				wire,
				session,
				`Continue the brainstorming task in ${RESUME_TASK_PATH} where we left off: resolve the open ` +
					"log-format question with me in one ask_user_question round, record the decision in that task-spec, " +
					"then stop. Do not start implementing or change any other file.",
				{
					budget: { maxMs: 300_000 },
					answer: (call) => {
						const observation = {
							toolCallId: call.toolCallId,
							gitStatus: gitText(session.cwd, "status", "--porcelain"),
							gitDiff: gitText(session.cwd, "diff", seedCommit),
							ignoredFiles: ignoredFiles(),
							task: readFileSync(taskPath, "utf8"),
							response: answerResumeQuestion(call),
						};
						beforeAnswers.push(observation);
						unchangedWorktree();
						expect(observation.task, "no decision before the user's answer").toBe(initialTask);
						return observation.response;
					},
					allowConfirm: () => undefined,
				},
			);
			const results = runChecks(resumeChecks(), { log: decision.log, cwd: session.cwd });
			const decidedTask = readFileSync(taskPath, "utf8");
			Object.assign(proof, {
				decision: { ...decision, log: decision.log.renderTranscript() },
				results,
				decidedTask,
				gitDiff: gitText(session.cwd, "diff", seedCommit),
				gitStatus: gitText(session.cwd, "status", "--porcelain"),
				ignoredFiles: ignoredFiles(),
			});
			expect(decision.failure, decision.log.renderTranscript()).toBeNull();
			expect(results.filter((result) => !result.pass)).toEqual([]);
			expect(beforeAnswers).toHaveLength(1);
			expect(decidedTask).not.toBe(initialTask);
			expect(decision.snapshot.summary.state?.completion?.outcome).toBe("succeeded");
			unchangedWorktree();

			await wire.request("session.dispose", { sessionId: session.sessionId });
			wire.close();
			wire = await E2eWire.connect();
			const restored = await wire.request("session.getMessages", session);
			proof.restored = restored;
			expect(restored.messages).toEqual(decision.snapshot.messages);
			const recall = await driveTurn(
				wire,
				session,
				"Quick memory check — answer from our conversation only, without reading any files or using " +
					"any tools: which flag were we designing, and which log format did I settle on?",
				{
					forbid: [
						{
							description: "memory recall must use no tools",
							test: (log) => log.toolCalls().length > 0,
						},
					],
				},
			);
			proof.recall = { ...recall, log: recall.log.renderTranscript() };
			expect(recall.failure, recall.log.renderTranscript()).toBeNull();
			expect(recall.log.toolCalls()).toEqual([]);
			const answer = recall.log.assistantTexts().join("\n");
			expect(answer).toMatch(/--verbose/);
			expect(answer).toMatch(/plain[- ]text/i);
			expect(recall.snapshot.messages.slice(0, restored.messages.length)).toEqual(
				restored.messages,
			);
			expect(readFileSync(taskPath, "utf8")).toBe(decidedTask);
			unchangedWorktree();
		} finally {
			wire.close();
			await testInfo.attach("smoke-resume-proof", {
				contentType: "application/json",
				body: Buffer.from(JSON.stringify(proof, null, 2)),
			});
		}
	},
);
