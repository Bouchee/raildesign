import { setTraceProcessors } from "@openai/agents";
import { logger } from "../log";

let configured = false;
const log = logger("sdk-trace");

export function configureLocalSdkTracing(): void {
	if (configured) return;
	setTraceProcessors([
		{
			onTraceStart: () => Promise.resolve(),
			onSpanStart: () => Promise.resolve(),
			onTraceEnd(trace) {
				log.info(JSON.stringify({ event: "trace.end", traceId: trace.traceId, name: trace.name }));
				return Promise.resolve();
			},
			onSpanEnd(span) {
				log.info(
					JSON.stringify({
						event: "span.end",
						traceId: span.traceId,
						spanId: span.spanId,
						type: span.spanData.type,
						startedAt: span.startedAt,
						endedAt: span.endedAt,
					}),
				);
				return Promise.resolve();
			},
			shutdown: () => Promise.resolve(),
			forceFlush: () => Promise.resolve(),
		},
	]);
	configured = true;
}
