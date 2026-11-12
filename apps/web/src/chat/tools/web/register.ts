import { registerToolRenderer } from "../../toolRegistry";
import { WebFetchCard, webFetchSummary } from "./WebFetchCard";
import { WebSearchCard, webSearchSummary } from "./WebSearchCard";

registerToolRenderer("web_fetch", WebFetchCard, { summary: webFetchSummary });
registerToolRenderer("web_search", WebSearchCard, { summary: webSearchSummary });
