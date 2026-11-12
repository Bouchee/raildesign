import { CustomEndpointsSettings, useCustomEndpoints } from "./CustomEndpointsSettings";

export function ProvidersSettings() {
	const state = useCustomEndpoints();
	return (
		<div data-testid="settings-providers" className="flex flex-col gap-24">
			{state ? <CustomEndpointsSettings state={state} /> : null}
		</div>
	);
}
