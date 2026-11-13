import { realpathSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { E2eWire } from "../fixtures/wire";
import { openSeededSession } from "./harness";

test("wire receipts release consumed success and error replies beyond replay capacity", async () => {
	const wire = await E2eWire.connect();
	try {
		for (let index = 0; index < 600; index++) {
			await wire.request("project.list", {});
			await expect(
				wire.request("session.getMessages", {
					workspaceId: "missing-wire-receipt-fixture",
					sessionId: "missing-wire-receipt-fixture",
				}),
			).rejects.toThrow("Unknown workspace: missing-wire-receipt-fixture");
		}
		expect(await wire.request("project.list", {})).toEqual(expect.any(Array));
	} finally {
		wire.close();
	}
});

test("a seeded SDK session uses the host-resolved default workspace without a model turn", async ({
	page,
}) => {
	const wire = await E2eWire.connect();
	let sessionId: string | undefined;
	try {
		const session = await openSeededSession(page, wire, "code-only");
		sessionId = session.sessionId;
		expect(session.cwd).toBe(realpathSync(session.cwd));
		const projects = await wire.request("project.list", {});
		const project = projects.find((item) => item.path === session.cwd);
		if (!project) throw new Error("The seeded session has no host project");
		const workspaces = await wire.request("workspace.list", { projectId: project.id });
		expect(workspaces.find((item) => item.id === session.workspaceId)).toMatchObject({
			kind: "default",
			worktreePath: session.cwd,
		});
		const snapshot = await wire.request("session.getMessages", session);
		expect(snapshot.summary.workspaceId).toBe(session.workspaceId);
		expect(snapshot.summary.state).toMatchObject({
			execution: "idle",
			runId: null,
			needsInput: null,
		});
		expect(snapshot.messages).toEqual([]);
	} finally {
		if (sessionId) await wire.request("session.dispose", { sessionId });
		wire.close();
	}
});
