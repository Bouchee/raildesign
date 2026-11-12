export function desktopError(scope: string, message: string, error?: unknown): void {
	if (error === undefined) console.error(`[desktop:${scope}] ${message}`);
	else console.error(`[desktop:${scope}] ${message}`, error);
}
