import { modelKeyEnvironmentNames } from "../modelConfiguration";
import { toolEnvironment } from "../sdkTools";
import type { BackgroundCommandContext } from "./types";

export function shellEnvironment(
	sessionId: string,
	context: BackgroundCommandContext,
): NodeJS.ProcessEnv {
	const env = toolEnvironment(
		new Set(modelKeyEnvironmentNames().map((name) => name.toUpperCase())),
	);
	for (const prefix of ["PI_", "RAILDESIGN_"])
		for (const key of ["SESSION_ID", "SESSION_FILE", "PROVIDER", "MODEL", "REASONING_LEVEL"])
			delete env[`${prefix}${key}`];
	if (context.exposeSessionEnvironment !== false) {
		env.RAILDESIGN_SESSION_ID = sessionId;
		if (context.sessionFile) env.RAILDESIGN_SESSION_FILE = context.sessionFile;
		if (context.model) {
			env.RAILDESIGN_PROVIDER = context.model.provider;
			env.RAILDESIGN_MODEL = context.model.id;
		}
		if (context.thinkingLevel) env.RAILDESIGN_REASONING_LEVEL = context.thinkingLevel;
	}
	return env;
}
