import { describe, expect, test } from "bun:test";
import { RunContext } from "@openai/agents";
import type { SdkToolServices } from "@thinkrail/extension-api/server";
import extension from "./index";

type ExecResult = { content: Array<{ type: string; text: string }>; details: unknown };
const checked: Array<{ path: string; cwd: string }> = [];
const session: SdkToolServices = {
	webAccess: {
		search: async () => {
			throw new Error("No web service in this fixture");
		},
		fetch: async () => {
			throw new Error("No web service in this fixture");
		},
	},
	cwd: "/workspace",
	assertActive: () => {},
	toolResponse: () => ({ kind: "deferred" }),
	markToolFailed: () => {},
	setting: () => false,
	workspaceFiles: {
		check: async (path, cwd) => {
			checked.push({ path, cwd });
			if (path === "missing.html") throw new Error("no such file");
		},
		scratchDir: ".raildesign/context/mockups/",
	},
};

function loadTool() {
	const sdkTool = extension.sdkTools(session)[0];
	if (!sdkTool) throw new Error("Missing visualization tool");
	return {
		name: sdkTool.name,
		description: sdkTool.description,
		async execute(
			_id: string,
			params: unknown,
			_signal?: unknown,
			_update?: unknown,
			_context?: unknown,
		): Promise<ExecResult> {
			const output = await sdkTool.invoke(new RunContext({}), JSON.stringify(params));
			const result = typeof output === "string" ? JSON.parse(output) : output;
			if (result.isError) throw new Error(result.error);
			return result;
		},
	};
}

describe("visualize server half", () => {
	test("creates one SDK visualization tool and no child tools or Skills", () => {
		expect(extension.name).toBe("visualize");
		expect(extension.title).toBe("Visualize");
		expect(extension.description).toBeTruthy();
		expect(extension.sdkTools(session)).toHaveLength(1);
		expect(extension).not.toHaveProperty("sdkChildTools");
		expect(extension).not.toHaveProperty("skillPackages");
		expect(loadTool().name).toBe("visualize");
	});

	test("accepts valid Mermaid without leaking DOM globals", async () => {
		const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
		const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");
		const res = await loadTool().execute("id", {
			type: "diagram",
			mermaid: "flowchart LR\n A[Start] --> B[Done]",
		});
		expect(res.content[0]?.text).toContain("```mermaid");
		expect(res.details).toEqual({
			type: "diagram",
			mermaid: "flowchart LR\n A[Start] --> B[Done]",
		});
		expect(Object.getOwnPropertyDescriptor(globalThis, "window")).toEqual(windowDescriptor);
		expect(Object.getOwnPropertyDescriptor(globalThis, "document")).toEqual(documentDescriptor);
	});

	test("rejects a dangling flowchart edge with the strict mermaid parse error", async () => {
		await expect(
			loadTool().execute("id", { type: "diagram", mermaid: "flowchart LR\n A -->" }),
		).rejects.toThrow(
			/visualize: invalid Mermaid syntax in `mermaid`[\s\S]*parse error[\s\S]*correct the syntax and call `visualize` again/i,
		);
	});

	test("rejects invalid comparison Mermaid with its option location", async () => {
		await expect(
			loadTool().execute("id", {
				type: "comparison",
				options: [
					{ name: "Valid", mermaid: "flowchart LR\n A --> B" },
					{ name: "Invalid", mermaid: "flowchart LR\n A -->" },
				],
			}),
		).rejects.toThrow(/visualize: invalid Mermaid syntax in `options\[1\]\.mermaid`/);
	});

	test("validates diagram kinds whose sanitizer needs a real document", async () => {
		for (const mermaid of [
			"classDiagram\n class A\n A : +run()",
			"stateDiagram-v2\n [*] --> Idle\n Idle --> Running",
			"gantt\n title T\n dateFormat YYYY-MM-DD\n section S\n Task :a1, 2024-01-01, 3d",
			"mindmap\n  root((r))\n    child",
		]) {
			await expect(loadTool().execute("id", { type: "diagram", mermaid })).resolves.toBeDefined();
		}
	});

	test("serializes Mermaid parsing across tool instances", async () => {
		await loadTool().execute("warmup", { type: "diagram", mermaid: "flowchart LR\n A --> B" });
		const mermaid = (await import("mermaid")).default;
		const parseDescriptor = Object.getOwnPropertyDescriptor(mermaid, "parse");
		let active = 0;
		let maxActive = 0;
		try {
			Object.defineProperty(mermaid, "parse", {
				configurable: true,
				value: async () => {
					active += 1;
					maxActive = Math.max(maxActive, active);
					await Bun.sleep(10);
					active -= 1;
				},
				writable: true,
			});
			await Promise.all([
				loadTool().execute("first", { type: "diagram", mermaid: "flowchart LR\n A --> B" }),
				loadTool().execute("second", { type: "diagram", mermaid: "flowchart LR\n C --> D" }),
			]);
			expect(maxActive).toBe(1);
		} finally {
			if (parseDescriptor) Object.defineProperty(mermaid, "parse", parseDescriptor);
		}
	});

	test("checks every file path through the host's workspace files", async () => {
		checked.length = 0;
		const tool = loadTool();
		const run = (params: unknown) =>
			tool.execute("id", params, undefined, undefined, { cwd: "/workspace" });
		await expect(
			run({ type: "file", path: ".raildesign/context/mockups/after.html", before: "before.html" }),
		).resolves.toBeDefined();
		expect(checked).toEqual([
			{ path: ".raildesign/context/mockups/after.html", cwd: "/workspace" },
			{ path: "before.html", cwd: "/workspace" },
		]);
		await expect(run({ type: "file", path: "missing.html" })).rejects.toThrow(
			/cannot show `path` \(missing\.html\): no such file/,
		);
	});

	test("points the mockup guideline at the gitignored scratch directory", () => {
		expect(loadTool().description).toContain("`.raildesign/context/mockups/`");
	});
});
