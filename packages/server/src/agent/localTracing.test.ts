import { expect, spyOn, test } from "bun:test";
import {
	Agent,
	getGlobalTraceProvider,
	NoopTrace,
	Runner,
	setTracingDisabled,
} from "@openai/agents";
import { assistantMessage, modelResponse, ScriptedModel } from "@openai/agents/testing";
import { configureLocalSdkTracing } from "./localTracing";

test("enabled local SDK tracing flushes without contacting the OpenAI exporter", async () => {
	const oldKey = process.env.OPENAI_API_KEY;
	const initiallyDisabled =
		getGlobalTraceProvider().createTrace({ name: "Probe" }) instanceof NoopTrace;
	process.env.OPENAI_API_KEY = "offline-tracing-test-key";
	const rejectNetwork = () => {
		throw new Error("Local tracing must not make a network request");
	};
	const network = spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(rejectNetwork, { preconnect: rejectNetwork }),
	);
	try {
		configureLocalSdkTracing();
		setTracingDisabled(false);
		expect(getGlobalTraceProvider().createTrace({ name: "Local tracing" })).not.toBeInstanceOf(
			NoopTrace,
		);
		const model = new ScriptedModel([modelResponse([assistantMessage("done")])]);
		const result = await new Runner({
			tracingDisabled: false,
			traceIncludeSensitiveData: false,
		}).run(new Agent({ name: "Local trace test", model }), "do not export this input");
		expect(result.finalOutput).toBe("done");
		await getGlobalTraceProvider().forceFlush();
		expect(network).not.toHaveBeenCalled();
		model.assertComplete();
	} finally {
		setTracingDisabled(initiallyDisabled);
		network.mockRestore();
		if (oldKey === undefined) delete process.env.OPENAI_API_KEY;
		else process.env.OPENAI_API_KEY = oldKey;
	}
});
