import type { ProviderStatus } from "@thinkrail/contracts";
import { t as translate } from "@thinkrail/locales/react";
import { useEffect, useEffectEvent, useRef } from "react";
import { toast } from "@/store";
import { getTransport } from "@/transport";
import { CustomEndpointsSettings, useCustomEndpoints } from "./CustomEndpointsSettings";
import { useProviderStatus } from "./useProviderStatus";

export function connectedProviderName(provider: ProviderStatus): string {
	return provider.name;
}

export async function announceProviderConnected(provider: ProviderStatus): Promise<void> {
	const models = await getTransport()
		.request("model.list", {})
		.catch(() => null);
	toast.success(
		models
			? translate("panels.connectProvider.modelsAvailable", { count: models.length })
			: translate("panels.connectProvider.agentCanRun"),
		translate("auth.login.connectedTitle", {
			provider: connectedProviderName(provider),
		}),
	);
}

export function ConnectProviderOptions({
	configuredAtStart,
	onConnected,
}: {
	configuredAtStart?: readonly string[];
	onConnected: (provider: ProviderStatus) => void;
}) {
	const { report, failed, refreshing } = useProviderStatus();
	const state = useCustomEndpoints();
	const baseline = useRef<Set<string> | null>(
		configuredAtStart ? new Set(configuredAtStart) : null,
	);
	const announceConnected = useEffectEvent(onConnected);
	useEffect(() => {
		if (!report) return;
		const configured = report.providers.filter((provider) => provider.configured);
		if (baseline.current === null) {
			baseline.current = new Set(configured.map((provider) => provider.id));
			return;
		}
		if (refreshing || failed) return;
		const fresh = configured.find((provider) => !baseline.current?.has(provider.id));
		if (fresh) {
			baseline.current.add(fresh.id);
			announceConnected(fresh);
		}
	}, [report, failed, refreshing]);
	return (
		<div data-testid="connect-provider-options" className="flex flex-col text-left">
			{state ? <CustomEndpointsSettings state={state} /> : null}
		</div>
	);
}
