import { tool } from "@openai/agents";
import { defineServerExtension, type SdkToolServices } from "@thinkrail/extension-api/server";
import { z } from "zod";

function webTools(session: SdkToolServices) {
	const errorFunction = (
		_context: unknown,
		error: unknown,
		details?: { toolCall?: { callId: string } },
	) => {
		if (details?.toolCall) session.markToolFailed(details.toolCall.callId);
		return JSON.stringify({
			isError: true,
			error: error instanceof Error ? error.message : String(error),
		});
	};
	return [
		tool({
			name: "web_search",
			description:
				"Search the web through DeepSeek. Return ranked titles, URLs and summaries. Use web_fetch to read a result.",
			parameters: z.object({
				query: z
					.string()
					.trim()
					.min(1)
					.refine((value) => [...value].length <= 128, "Use at most 128 characters"),
				count: z.number().int().min(1).max(10).nullable(),
			}),
			errorFunction,
			async execute({ query, count }, _context, details) {
				session.assertActive();
				const result = await session.webAccess.search(query, count ?? 5, details?.signal);
				session.assertActive();
				return result;
			},
		}),
		tool({
			name: "web_fetch",
			description:
				"Read one public HTTP or HTTPS web page through DeepSeek. Return its title and bounded Markdown content.",
			parameters: z.object({ url: z.string().min(1).max(8192) }),
			errorFunction,
			async execute({ url }, _context, details) {
				session.assertActive();
				const result = await session.webAccess.fetch(url, details?.signal);
				session.assertActive();
				return result;
			},
		}),
	];
}

export default defineServerExtension({
	name: "web-access",
	title: "Web access",
	description: "Search the web and read pages through DeepSeek Search and Fetch.",
	sdkTools: webTools,
	sdkChildTools: webTools,
});
