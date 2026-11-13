import { tool } from "@openai/agents";
import type { ThinkingLevel } from "@thinkrail/contracts";
import { CHAT_HANDOFF_SUMMARY_MAX_LENGTH } from "@thinkrail/contracts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@thinkrail/shared/toolOutput";
import { z } from "zod";

export interface StartWorkspaceParams {
	prompt: string;
	project?: string;
	base_branch?: string;
	model?: string;
	effort?: ThinkingLevel;
	attachments?: string[];
}
export interface WorkspaceStatusParams {
	project?: string;
	workspaces?: string[];
}
export interface StartedWorkspace {
	workspaceId: string;
	projectId: string;
	sessionId: string;
	name: string;
	branch: string;
	baseBranch: string;
	model: string | null;
	effort: string;
}
export interface WorkspaceToolsHost {
	start(
		sessionId: string,
		params: StartWorkspaceParams,
		signal: AbortSignal,
	): Promise<StartedWorkspace>;
	status(sessionId: string, params: WorkspaceStatusParams): Promise<string>;
}
export interface ContinueToolHost {
	apply(
		sessionId: string,
		summary: string,
		signal: AbortSignal,
		assertActive: () => void,
		inputId: string | undefined,
	): Promise<string>;
}
let workspaceHost: WorkspaceToolsHost | undefined;
let continuationHost: ContinueToolHost | undefined;
export function setWorkspaceToolsHost(host: WorkspaceToolsHost | undefined): void {
	workspaceHost = host;
}
export function setContinueToolHost(host: ContinueToolHost | undefined): void {
	continuationHost = host;
}

export function createWorkspaceActions(context: {
	sessionId: string;
	inputId: string | undefined;
	standalone: boolean;
	signal: AbortSignal;
	assertActive: () => void;
}) {
	const host = workspaceHost;
	const continuation = continuationHost;
	const assertActive = () => {
		context.assertActive();
		context.signal.throwIfAborted();
	};
	return [
		...(host
			? [
					tool({
						name: "start_workspace",
						errorFunction: null,
						description:
							"Start a new Git workspace and an independent agent chat in an open project. Use it when the user asks for a new, separate or parallel workspace. Pass a self-contained task: the new agent cannot see this conversation. Its worktree starts from a committed branch; commit or attach anything it needs first. Returns when the prompt is accepted; use workspace_status to check progress. Suggest independent tasks before starting unrequested parallel work.",
						parameters: z.object({
							prompt: z
								.string()
								.trim()
								.min(1)
								.describe("Complete task, context and acceptance criteria for the new agent."),
							project: z
								.string()
								.nullable()
								.optional()
								.describe(
									"Open project name, slug or ID. Required in standalone chats; otherwise defaults to this project.",
								),
							base_branch: z.string().nullable().optional(),
							model: z
								.string()
								.nullable()
								.optional()
								.describe(
									"Verified provider/id or unique model ID; omitted uses the new-chat default.",
								),
							effort: z
								.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"])
								.nullable()
								.optional(),
							attachments: z.array(z.string()).nullable().optional(),
						}),
						execute: async (args) => {
							assertActive();
							const started = await host.start(
								context.sessionId,
								{
									prompt: args.prompt,
									...(args.project ? { project: args.project } : {}),
									...(args.base_branch ? { base_branch: args.base_branch } : {}),
									...(args.model ? { model: args.model } : {}),
									...(args.effort ? { effort: args.effort } : {}),
									...(args.attachments ? { attachments: args.attachments } : {}),
								},
								context.signal,
							);
							assertActive();
							return {
								content: [
									{
										type: "text" as const,
										text: `Started workspace "${started.name}" (id ${started.workspaceId}, branch ${started.branch}, from ${started.baseBranch}) with chat ${started.sessionId}. It runs independently; check it with workspace_status.`,
									},
								],
								details: started,
							};
						},
					}),
					tool({
						name: "workspace_status",
						errorFunction: null,
						description:
							"Check workspaces in an open project: chat state, PR and diff size. Name specific workspaces to include their final assistant messages.",
						parameters: z.object({
							project: z.string().nullable().optional(),
							workspaces: z.array(z.string()).nullable().optional(),
						}),
						execute: async (args) => {
							assertActive();
							const text = await host.status(context.sessionId, {
								...(args.project ? { project: args.project } : {}),
								...(args.workspaces ? { workspaces: args.workspaces } : {}),
							});
							assertActive();
							const bounded = truncateHead(text);
							if (!bounded.truncated) return text;
							const footer = "\n[Output truncated; name fewer workspaces for detail.]";
							return (
								truncateHead(text, {
									maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(footer),
									maxLines: DEFAULT_MAX_LINES - 1,
								}).content + footer
							);
						},
					}),
				]
			: []),
		...(continuation && context.standalone
			? [
					tool({
						name: "continue_in_workspace",
						errorFunction: null,
						description:
							"Hand this conversation to a new project workspace only after the host asks with a continuation card. Write a short summary of the request, decisions and open work, then call once.",
						parameters: z.object({ summary: z.string().trim().min(1) }),
						execute: async ({ summary }) => {
							assertActive();
							const bounded =
								summary.length > CHAT_HANDOFF_SUMMARY_MAX_LENGTH
									? `${summary.slice(0, CHAT_HANDOFF_SUMMARY_MAX_LENGTH - 1)}…`
									: summary;
							const text = await continuation.apply(
								context.sessionId,
								bounded,
								context.signal,
								assertActive,
								context.inputId,
							);
							assertActive();
							return { content: [{ type: "text" as const, text }], details: { summary: bounded } };
						},
					}),
				]
			: []),
	];
}
