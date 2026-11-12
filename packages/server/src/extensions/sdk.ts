import type { SdkToolServices } from "@thinkrail/extension-api/server";
import { serverExtensions } from "./registry";

export type SdkExtensionKind = "parent" | "child";

export interface SdkExtensionSnapshot {
	name: string;
	settings: Record<string, boolean>;
}
export function snapshotSdkExtensions(
	disabled: readonly string[],
	settings: Record<string, Record<string, boolean>>,
	kind: SdkExtensionKind = "parent",
): SdkExtensionSnapshot[] {
	return serverExtensions.flatMap(({ extension }) =>
		(kind === "child" ? extension.sdkChildTools : extension.sdkTools) &&
		!disabled.includes(extension.name)
			? [
					{
						name: extension.name,
						settings: Object.fromEntries(
							Object.entries(extension.settings ?? {}).map(([key, definition]) => [
								key,
								settings[extension.name]?.[key] ?? definition.default,
							]),
						),
					},
				]
			: [],
	);
}
export function registrySdkTools(
	services: Omit<SdkToolServices, "setting">,
	snapshot: readonly SdkExtensionSnapshot[],
	kind: SdkExtensionKind = "parent",
) {
	return snapshot.flatMap((saved) => {
		const extension = serverExtensions.find(
			(entry) => entry.extension.name === saved.name,
		)?.extension;
		const factory = kind === "child" ? extension?.sdkChildTools : extension?.sdkTools;
		if (!factory) throw new Error("The saved extension graph is unavailable");
		return factory({
			...services,
			setting(key) {
				const value = saved.settings[key];
				if (value === undefined) throw new Error("Unknown extension setting");
				return value;
			},
		});
	});
}
