import type { WebAccessStatus } from "@thinkrail/contracts";
import { z } from "zod";
import { getWebAccessStatus, setWebAccessKey } from "../agent";

export function webAccessStatus(): WebAccessStatus {
	return getWebAccessStatus();
}

export function configureWebAccess(params: { apiKey: string }): WebAccessStatus {
	const input = z
		.object({ apiKey: z.string().max(4096) })
		.strict()
		.parse(params);
	return setWebAccessKey(input.apiKey);
}
