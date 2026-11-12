import { expect, test } from "bun:test";

const handlerModule = new URL("./handlers.ts", import.meta.url).href;

test("client errors validate report bounds and log only closed classifications locally", async () => {
	const program = `
		import { handleRequest } from ${JSON.stringify(handlerModule)};
		const ctx = { clientKey: "client-report-test" };
		const valid = [];
		for (const report of [
			{ kind: "render", type: "TypeError", stack: "PRIVATE_STACK", boundary: "PRIVATE_BOUNDARY" },
			{ kind: "rejection", type: "PRIVATE_ERROR_TYPE" },
		]) valid.push(await handleRequest("client.reportError", report, ctx));
		const rejected = [];
		for (const report of [
			{ kind: "unknown", type: "Error" },
			{ kind: "window", type: "" },
			{ kind: "window", type: "x".repeat(121) },
			{ kind: "window", type: "Error", stack: "x".repeat(16385) },
			{ kind: "window", type: "Error", boundary: "x".repeat(121) },
			{ kind: "window", type: "Error", token: "PRIVATE_TOKEN" },
		]) {
			try { await handleRequest("client.reportError", report, ctx); rejected.push(false); }
			catch { rejected.push(true); }
		}
		process.stdout.write(JSON.stringify({valid, rejected}));
	`;
	const child = Bun.spawn([process.execPath, "--eval", program], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(code).toBe(0);
	expect(JSON.parse(out)).toEqual({
		valid: [{ ok: true }, { ok: true }],
		rejected: [true, true, true, true, true, true],
	});
	expect(err).toContain("client render error (TypeError)");
	expect(err).toContain("client rejection error (Error)");
	expect(err).not.toContain("PRIVATE_");
});
