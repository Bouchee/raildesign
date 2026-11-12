import type { ProviderStatusReport } from "@thinkrail/contracts";
import { configuredProviderStatuses } from "../agent";

export async function getProviderStatus(): Promise<ProviderStatusReport> {
	return { providers: configuredProviderStatuses() };
}
