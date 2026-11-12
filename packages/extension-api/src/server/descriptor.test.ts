import { describe, expect, it, mock } from "bun:test";
import { isAbsolute } from "node:path";
import {
	defineServerExtension,
	type SdkToolServices,
	type ServerExtension,
} from "@thinkrail/extension-api/server";

describe("defineServerExtension", () => {
	it("preserves SDK factories and Skill specifiers without calling factories", () => {
		const sdkTools = mock((_services: SdkToolServices) => []);
		const sdkChildTools = mock((_services: SdkToolServices) => []);
		const descriptor = {
			name: "example",
			sdkTools,
			sdkChildTools,
			skillPackages: ["@example/skills"],
		} satisfies ServerExtension;
		const extension = defineServerExtension(descriptor);
		expect(extension).toBe(descriptor);
		expect(extension.sdkTools).toBe(sdkTools);
		expect(extension.sdkChildTools).toBe(sdkChildTools);
		expect(extension.skillPackages).toBe(descriptor.skillPackages);
		expect(sdkTools).not.toHaveBeenCalled();
		expect(sdkChildTools).not.toHaveBeenCalled();
	});

	it("does not add omitted fields", () => {
		const descriptor = { name: "minimal" } satisfies ServerExtension;
		const extension = defineServerExtension(descriptor);
		expect(extension).toBe(descriptor);
		for (const key of ["sdkTools", "sdkChildTools", "skillPackages", "title", "description"])
			expect(extension).not.toHaveProperty(key);
	});

	it("keeps display copy beside the identity", () => {
		const extension = defineServerExtension({
			name: "shown",
			title: "Shown",
			description: "Shows up in Settings.",
		});
		expect(extension.name).toBe("shown");
		expect(extension.title).toBe("Shown");
		expect(extension.description).toBe("Shows up in Settings.");
	});

	it("keeps the SDK type dependency out of the runtime entry", async () => {
		const imports: string[] = [];
		const build = await Bun.build({
			entrypoints: [Bun.resolveSync("@thinkrail/extension-api/server", import.meta.dir)],
			target: "browser",
			plugins: [
				{
					name: "record-runtime-imports",
					setup(builder) {
						builder.onResolve({ filter: /^[^./]/ }, ({ path }) => {
							if (!isAbsolute(path)) imports.push(path);
						});
					},
				},
			],
		});
		expect(build.success).toBe(true);
		expect(imports).toEqual(["@thinkrail/contracts"]);
		expect(await build.outputs[0]?.text()).toContain("defineServerExtension");
	});
});
