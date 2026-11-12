import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { extractSession } from "./extract";
import { HistoryIndex } from "./historyIndex";
import { sessionDirFor, writeFixtureSession } from "./testFixtures";

test("fixture sessions use the real flat JSON record and stable transcript identities", async () => {
	const root = mkdtempSync(join(tmpdir(), "raildesign-history-fixture-"));
	try {
		const directory = sessionDirFor(root);
		const written = writeFixtureSession(directory, {
			id: "fixture-a",
			workspaceId: "workspace-a",
			cwd: `${root}/repo/./`,
			name: "Fixture chat",
			messages: [
				{ role: "user", text: "hello", timestamp: 10 },
				{ role: "assistant", text: "hello back", timestamp: 20 },
				{
					role: "toolResult",
					toolCallId: "call-a",
					toolName: "read",
					content: [{ type: "text", text: "file contents" }],
					details: { path: "index.ts" },
					isError: false,
					timestamp: 30,
				},
			],
		});
		expect(written.path).toBe(join(directory, "fixture-a.json"));
		const json = readFileSync(written.path, "utf8");
		const stored = JSON.parse(json);
		expect(stored).toMatchObject({
			version: 2,
			sessionId: "fixture-a",
			workspaceId: "workspace-a",
			cwd: resolve(root, "repo"),
			title: "Fixture chat",
			history: [],
			revision: 0,
			eventSeq: 0,
		});
		expect(stored.messages.map((message: { id: string }) => message.id)).toEqual([
			"fixture-a-m0",
			"fixture-a-m1",
			"fixture-a-m2",
		]);
		expect(stored.messages[2]).toMatchObject({
			toolCallId: "call-a",
			details: { path: "index.ts" },
			isError: false,
		});
		expect(extractSession(json)?.entries.map((entry) => entry.text)).toEqual([
			"hello",
			"hello back",
		]);
		const result = await new HistoryIndex(directory).search({
			query: "hello",
			filter: () => true,
			labels: () => ({}),
		});
		expect(result.prompts[0]?.sessionId).toBe("fixture-a");
		expect(result.messages[0]?.messageIndex).toBe(1);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("fixture session IDs cannot escape the session directory", () => {
	expect(() =>
		writeFixtureSession("/not-used", { id: "../outside", cwd: "/repo", messages: [] }),
	).toThrow("Invalid fixture session ID");
});

test("an empty fixture carries explicit session activity metadata", () => {
	const root = mkdtempSync(join(tmpdir(), "raildesign-history-empty-fixture-"));
	try {
		const written = writeFixtureSession(sessionDirFor(root), {
			id: "newest-empty",
			workspaceId: "workspace-a",
			cwd: root,
			messages: [],
			updatedAt: 42,
		});
		const record = JSON.parse(readFileSync(written.path, "utf8"));
		expect(record.updatedAt).toBe(42);
		expect(record.messages).toEqual([]);
		expect(record.state.execution).toBe("idle");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
