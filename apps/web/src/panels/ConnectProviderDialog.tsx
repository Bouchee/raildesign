import type { ProviderStatus } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@thinkrail/ui/dialog";
import { useAppStore } from "@/store";
import { announceProviderConnected, ConnectProviderOptions } from "./ConnectProviderOptions";

export function ConnectProviderDialog({
	onClose,
	onConnected,
}: {
	onClose: () => void;
	onConnected?: (provider: ProviderStatus) => void;
}) {
	const t = useT();
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (open) return;
				onClose();
			}}
		>
			<DialogContent data-testid="connect-provider-dialog" className="max-w-[36rem]">
				<DialogHeader>
					<DialogTitle>{t("panels.connectProvider.title")}</DialogTitle>
					<DialogDescription>{t("panels.connectProvider.description")}</DialogDescription>
				</DialogHeader>
				<ConnectProviderOptions
					onConnected={(provider) => {
						useAppStore.getState().clearSettledLogin(provider.id);
						void announceProviderConnected(provider);
						onClose();
						onConnected?.(provider);
					}}
				/>
			</DialogContent>
		</Dialog>
	);
}
