import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BRAND_MARK_PATH } from "../constants/branding";
import { RunningIcon } from "./RunningIcon";

test("running icon keeps an accessible label and uses the RailDesign mark", () => {
	const markup = renderToStaticMarkup(<RunningIcon className="size-14 text-primary" />);
	expect(markup).toContain('aria-label="Agent working"');
	expect(markup).toContain('data-running="true"');
	expect(markup).toContain("motion-safe:animate-pulse");
	expect(markup).toContain("size-14 text-primary");
	expect(markup).toContain(BRAND_MARK_PATH);
	expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b|style="/i);
});
