import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { E2eWire } from "./wire";

export async function disposeFixtureResources(
	directory: string,
	wire: Pick<E2eWire, "request">,
): Promise<void> {
	let sessionIds: string[] = [];
	try {
		sessionIds = readdirSync(join(directory, "sessions"))
			.filter((name) => /^[A-Za-z0-9_-]{1,200}\.json$/.test(name))
			.map((name) => name.slice(0, -5));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	for (const sessionId of sessionIds) await wire.request("session.dispose", { sessionId }, 30_000);
	let terminals: Record<string, { tabKey: string }[]> = {};
	try {
		terminals = JSON.parse(readFileSync(join(directory, "terminals.json"), "utf8"));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
	for (const [workspaceId, tabs] of Object.entries(terminals)) {
		for (const { tabKey } of tabs) {
			const result = await wire.request("terminal.close", { workspaceId, tabKey, force: true });
			if (result.busy) throw new Error("The fixture terminal could not be closed");
		}
	}
}
