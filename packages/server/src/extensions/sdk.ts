import type { SdkToolServices } from "@thinkrail/extension-api/server";
import { serverExtensions } from "./registry";

export interface SdkExtensionSnapshot {
	name: string;
	settings: Record<string, boolean>;
}
export function snapshotSdkExtensions(
	disabled: readonly string[],
	settings: Record<string, Record<string, boolean>>,
): SdkExtensionSnapshot[] {
	return serverExtensions.flatMap(({ extension }) =>
		extension.sdkTools && !disabled.includes(extension.name)
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
) {
	return snapshot.flatMap((saved) => {
		const extension = serverExtensions.find(
			(entry) => entry.extension.name === saved.name,
		)?.extension;
		if (!extension?.sdkTools) throw new Error("The saved extension graph is unavailable");
		return extension.sdkTools({
			...services,
			setting(key) {
				const value = saved.settings[key];
				if (value === undefined) throw new Error("Unknown extension setting");
				return value;
			},
		});
	});
}
