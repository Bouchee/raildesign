import { RiSearchLine as Search } from "@remixicon/react";
import { resultText, strArg, type ToolRenderProps } from "@thinkrail/extension-api/web";
import { useT } from "@thinkrail/locales/react";
import { WebResultBody } from "./WebResultBody";

export function webSearchSummary({ args }: ToolRenderProps): string {
	return strArg(args, "query");
}

function providerOf(result: unknown): string {
	const details = (result as { details?: unknown } | null)?.details as
		| { provider?: unknown }
		| undefined;
	const p = details?.provider;
	return typeof p === "string" ? p : "";
}

export function WebSearchCard({ toolCallId, args, result, status }: ToolRenderProps) {
	const t = useT();
	const query = strArg(args, "query");
	const provider = providerOf(result);
	const output = resultText(result);

	return (
		<div data-testid="tool-web_search" className="flex flex-col gap-4">
			<div className="flex items-center gap-4 tr-text-metadata">
				<Search className="size-12 shrink-0 text-text-muted" />
				<span className="truncate text-primary" title={query}>
					{query}
				</span>
				{provider ? (
					<span className="shrink-0 text-text-muted">{t("tools.webSearch.via", { provider })}</span>
				) : null}
			</div>
			<WebResultBody
				id={`${toolCallId}:content`}
				output={output}
				status={status}
				runningLabel={t("tools.webSearch.running")}
				emptyLabel={t("tools.webSearch.empty")}
			/>
		</div>
	);
}
