import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { useAppStore } from "../store";
import * as wireTransport from "../transport/wireTransport";
import { promptWorkspaceChat } from "./openChat";

const initial = useAppStore.getInitialState();
const requests: string[] = [];
let restore = () => {};

beforeEach(() => {
	useAppStore.setState(initial, true);
	requests.length = 0;
	const store = useAppStore.getState();
	store.openChatSession("workspace", "chat", null, "off");
	store.openChatSession("other-workspace", "other-chat", null, "off");
	const transport = {
		request: async (method: string) => {
			requests.push(method);
			return {};
		},
	} as unknown as ReturnType<typeof wireTransport.getTransport>;
	const spy = spyOn(wireTransport, "getTransport").mockReturnValue(transport);
	restore = () => spy.mockRestore();
});

afterEach(() => {
	restore();
	useAppStore.setState(initial, true);
});

test("a busy chat preserves the existing draft and incoming prompt without queuing or sending", async () => {
	const store = useAppStore.getState();
	store.setChatDraft("chat", "User's unfinished\nnotes");
	store.setChatDraft("other-chat", "Other chat's draft");
	const runtime = useAppStore.getState().sessions.chat;
	if (!runtime) throw new Error("fixture chat missing");
	useAppStore.setState({
		sessions: { ...useAppStore.getState().sessions, chat: { ...runtime, isStreaming: true } },
	});

	await promptWorkspaceChat("workspace", "chat", "Incoming action prompt");

	expect(useAppStore.getState().sessions.chat?.draft).toBe(
		"User's unfinished\nnotes\n\nIncoming action prompt",
	);
	expect(useAppStore.getState().sessions["other-chat"]?.draft).toBe("Other chat's draft");
	expect(requests).toEqual([]);
});

test("a busy chat with no draft keeps the incoming prompt available for later editing", async () => {
	const runtime = useAppStore.getState().sessions.chat;
	if (!runtime) throw new Error("fixture chat missing");
	useAppStore.setState({
		sessions: { ...useAppStore.getState().sessions, chat: { ...runtime, isStreaming: true } },
	});
	await promptWorkspaceChat("workspace", "chat", "Incoming action prompt");
	expect(useAppStore.getState().sessions.chat?.draft).toBe("Incoming action prompt");
	expect(requests).toEqual([]);
});

test("an idle chat still receives an ordinary prompt and retains its separate draft", async () => {
	useAppStore.getState().setChatDraft("chat", "User's unfinished notes");
	await promptWorkspaceChat("workspace", "chat", "Incoming action prompt");
	expect(requests).toEqual(["session.prompt"]);
	expect(useAppStore.getState().sessions.chat?.draft).toBe("User's unfinished notes");
});
