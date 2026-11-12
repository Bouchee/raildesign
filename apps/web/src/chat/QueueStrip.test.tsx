import { expect, test } from "bun:test";
import { TooltipProvider } from "@thinkrail/ui/tooltip";
import { renderToStaticMarkup } from "react-dom/server";
import { QueueStrip } from "./QueueStrip";

test("queue rows expose stable identity, pending/staged state and retained admission errors", () => {
	const markup = renderToStaticMarkup(
		<TooltipProvider>
			<QueueStrip
				queue={{
					steering: [{ id: "staged", text: "first", state: "staged" }],
					followUp: [
						{ id: "waiting", text: "second", state: "pending", error: "Input was not admitted" },
					],
				}}
				onEdit={() => {}}
				onRemove={() => {}}
			/>
		</TooltipProvider>,
	);
	expect(markup).toContain('data-message-id="staged"');
	expect(markup).toContain('data-state="staged"');
	expect(markup).toContain("Staged for the next model call");
	expect(markup).toContain("Waiting for admission");
	expect(markup).toContain('role="alert"');
	expect(markup).toContain("Input was not admitted");
	expect(markup.match(/<button[^>]*disabled=""/g)).toHaveLength(2);
});
