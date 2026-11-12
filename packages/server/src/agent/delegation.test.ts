import { expect, test } from "bun:test";
import type { ChildHandle, RunLifecycleStatus } from "pi-delegation";
import {
	hasLiveSessionChildren,
	liveSessionChildren,
	ownedChild,
	stopSessionChildren,
} from "./delegation";

function child(
	id: string,
	scope = "workspace",
	parent = "parent",
	status: RunLifecycleStatus = "running",
): ChildHandle {
	return {
		sessionId: id,
		record: {
			sessionId: id,
			scope,
			parentSessionId: parent,
			originKind: "fresh",
			info: { createdBy: "test" },
			interactive: false,
			visibility: "hidden",
			createdAt: "",
			sessionFile: "",
		},
		snapshot: {
			status,
			task: "",
			details: {
				childSessionId: id,
				task: "",
				status,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					cost: 0,
					turns: 0,
					contextTokens: 0,
				},
				durationMs: 0,
			},
			collected: false,
		},
		async runQueued() {
			throw new Error("No executor in policy test");
		},
		async runNow() {
			throw new Error("No executor in policy test");
		},
		async steer() {},
		onEvent: () => () => {},
		collectResult: () => undefined,
		async abort() {},
		async dispose() {},
	};
}
function service(children: ChildHandle[]) {
	return {
		childrenOf: () => children,
		findChild: (id: string) => children.find((entry) => entry.sessionId === id),
	};
}

test("ownership requires both workspace and parent, and unknown children fail explicitly", () => {
	const owned = child("own"),
		otherWorkspace = child("foreign", "other"),
		otherParent = child("sibling", "workspace", "other");
	const current = service([owned, otherWorkspace, otherParent]);
	expect(ownedChild(current, "workspace", "parent", "own")).toBe(owned);
	for (const id of ["foreign", "sibling", "missing"])
		expect(() => ownedChild(current, "workspace", "parent", id)).toThrow("Resource unavailable");
});

test("only queued and running children of the owner consume live resources", () => {
	const current = service([
		child("queued", "workspace", "parent", "queued"),
		child("running"),
		child("done", "workspace", "parent", "completed"),
		child("foreign", "other"),
	]);
	expect(
		liveSessionChildren(current, "workspace", "parent").map(({ sessionId }) => sessionId),
	).toEqual(["queued", "running"]);
	expect(hasLiveSessionChildren(current, "workspace", "parent")).toBe(true);
	expect(hasLiveSessionChildren(current, "other", "parent")).toBe(true);
	expect(hasLiveSessionChildren(current, "workspace", "missing")).toBe(false);
});

test("Stop aborts owned work synchronously and settles after the actual cleanup", async () => {
	const a = child("a"),
		b = child("b"),
		foreign = child("foreign", "other");
	const events: string[] = [];
	let release: () => void = () => {};
	a.abort = (reason) => {
		events.push(`abort-a:${reason}`);
		return new Promise((resolve) => {
			release = resolve;
		});
	};
	b.abort = async () => {
		events.push("abort-b");
		throw new Error("abort failed");
	};
	b.dispose = async () => {
		events.push("dispose-b");
	};
	foreign.abort = async () => {
		throw new Error("Touched foreign work");
	};
	const result = stopSessionChildren(service([a, b, foreign]), "workspace", "parent", "user");
	expect(result.stopped).toBe(2);
	expect(events).toEqual(["abort-a:user", "abort-b"]);
	let settled = false;
	void result.settled.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	release();
	await result.settled;
	expect(settled).toBe(true);
	expect(events).toContain("dispose-b");
});

test("cleanup failure remains an error after every owned child settles", async () => {
	const broken = child("broken");
	broken.abort = async () => {
		throw new Error("abort");
	};
	broken.dispose = async () => {
		throw new Error("dispose");
	};
	await expect(
		stopSessionChildren(service([broken]), "workspace", "parent", "user").settled,
	).rejects.toThrow("Child cleanup failed");
});
