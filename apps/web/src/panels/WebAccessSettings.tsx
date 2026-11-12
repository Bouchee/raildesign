import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useEffect, useId, useState } from "react";
import { getTransport } from "@/transport";
import { SettingsGroup } from "./SettingsGroup";

export function WebAccessSettings() {
	const t = useT();
	const id = useId();
	const [configured, setConfigured] = useState<boolean | null>(null);
	const [apiKey, setApiKey] = useState("");
	const [saving, setSaving] = useState(false);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		let current = true;
		getTransport()
			.request("webAccess.status", {})
			.then((status) => {
				if (current) setConfigured(status.configured);
			})
			.catch(() => {
				if (current) setFailed(true);
			});
		return () => {
			current = false;
		};
	}, []);

	const save = (key: string) => {
		setSaving(true);
		setFailed(false);
		getTransport()
			.request("webAccess.configure", { apiKey: key })
			.then((status) => {
				setConfigured(status.configured);
			})
			.catch(() => setFailed(true))
			.finally(() => {
				setApiKey("");
				setSaving(false);
			});
	};

	return (
		<SettingsGroup
			title={t("settings.webAccess.title")}
			description={t("settings.webAccess.description")}
			testId="settings-web-access"
		>
			<form
				className="flex flex-col gap-8 px-12 py-8"
				onSubmit={(event) => {
					event.preventDefault();
					if (apiKey.trim() && !saving) save(apiKey);
				}}
			>
				<p data-testid="web-access-status" className="tr-text-metadata text-text-muted">
					{t(
						configured === null
							? "settings.webAccess.loading"
							: configured
								? "settings.webAccess.configured"
								: "settings.webAccess.notConfigured",
					)}
				</p>
				<label htmlFor={id} className="tr-title-compact text-text-default">
					{t("settings.webAccess.key")}
				</label>
				<input
					id={id}
					data-testid="web-access-key"
					type="password"
					autoComplete="off"
					value={apiKey}
					maxLength={4096}
					disabled={saving}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder={t("settings.webAccess.placeholder")}
					className="h-32 w-full min-w-0 rounded-sm border border-control-border-default bg-control-bg px-8 tr-text-ui text-text-default outline-none placeholder:text-text-muted focus:border-control-border-active"
				/>
				<div className="flex gap-8">
					<Button
						type="submit"
						variant="primary"
						size="m"
						disabled={!apiKey.trim() || saving}
						data-testid="web-access-save"
					>
						{t("settings.webAccess.save")}
					</Button>
					<Button
						type="button"
						variant="outline"
						size="m"
						disabled={!configured || saving}
						onClick={() => save("")}
						data-testid="web-access-clear"
					>
						{t("settings.webAccess.clear")}
					</Button>
				</div>
				{failed ? (
					<p role="alert" className="tr-text-metadata text-feedback-error">
						{t("settings.webAccess.failed")}
					</p>
				) : null}
			</form>
		</SettingsGroup>
	);
}
