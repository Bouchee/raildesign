import { expect, spyOn, test } from "bun:test";
import { desktopError } from "./errorReporting";

test("desktop diagnostics stay in the local console", () => {
	const consoleError = spyOn(console, "error").mockImplementation(() => {});
	try {
		const error = new Error("boom");
		desktopError("updates", "could not install", error);
		desktopError("preferences", "could not save");
		expect(consoleError).toHaveBeenNthCalledWith(1, "[desktop:updates] could not install", error);
		expect(consoleError).toHaveBeenNthCalledWith(2, "[desktop:preferences] could not save");
	} finally {
		consoleError.mockRestore();
	}
});
