import type { ExtensionCatalogEntry } from "@thinkrail/contracts";
import type { SdkToolServices } from "@thinkrail/extension-api/server";
import { type ServerExtensionEntry, serverExtensions } from "./registry";

type ExtensionDescription = Omit<ExtensionCatalogEntry, "enabled">;

function describeEntry({ extension }: ServerExtensionEntry): ExtensionDescription {
	const unavailable = (): never => {
		throw new Error("The Settings catalog has no active session");
	};
	const services: SdkToolServices = {
		webAccess: {
			search: async () => {
				throw new Error("No web service in this fixture");
			},
			fetch: async () => {
				throw new Error("No web service in this fixture");
			},
		},
		cwd: "",
		assertActive: unavailable,
		toolResponse: unavailable,
		markToolFailed: unavailable,
		workspaceFiles: { check: async () => unavailable(), scratchDir: "" },
		setting(key) {
			const setting = extension.settings?.[key];
			if (!setting) throw new Error("Unknown extension setting");
			return setting.default;
		},
	};
	const tools = (extension.sdkTools?.(services) ?? []).flatMap((tool) =>
		tool.type === "function" ? [tool.name] : [],
	);
	const settings = Object.entries(extension.settings ?? {}).map(([key, setting]) => ({
		key,
		default: setting.default,
	}));
	return {
		name: extension.name,
		title: extension.title ?? extension.name,
		...(extension.description ? { description: extension.description } : {}),
		tools: [...new Set(tools)],
		hasChildExtensions: extension.sdkChildTools !== undefined,
		...(settings.length > 0 ? { settings } : {}),
	};
}

const described = new WeakMap<readonly ServerExtensionEntry[], ExtensionDescription[]>();

export async function listExtensionCatalog(
	disabled: ReadonlySet<string>,
	entries: readonly ServerExtensionEntry[] = serverExtensions,
): Promise<ExtensionCatalogEntry[]> {
	let descriptions = described.get(entries);
	if (!descriptions) {
		descriptions = entries.map(describeEntry);
		described.set(entries, descriptions);
	}
	return descriptions.map((description) => ({
		...description,
		enabled: !disabled.has(description.name),
	}));
}
