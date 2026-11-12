import type { ModelDefault, ThinkingLevel, WireModel } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { Button } from "@thinkrail/ui/button";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ModelSelector } from "@/chat/ModelSelector";
import { ThinkingSelector } from "@/chat/ThinkingSelector";
import { useModelCatalog } from "@/chat/useModelCatalog";
import { useModelPreferences } from "@/chat/useModelPreferences";
import { selectCatalogModel, selectPickerModels, toast, useAppStore } from "@/store";
import { getTransport } from "@/transport";
import { SettingsGroup, SettingsPageContainer } from "./SettingsGroup";
import { VisibleModelsSettings } from "./VisibleModelsSettings";

export function ModelsSettings() {
	const t = useT();
	const defaultModel = useAppStore((s) => s.defaultModel);
	const defaultEffort = useAppStore((s) => s.defaultEffort);
	const { models: allModels, refreshing, refresh } = useModelCatalog(true);
	const hiddenModels = useAppStore((s) => s.hiddenModels);
	const visibleModels = useMemo(
		() => selectPickerModels(allModels, hiddenModels, []),
		[allModels, hiddenModels],
	);
	const preferences = useModelPreferences(visibleModels);
	const [resolvedDefault, setResolvedDefault] = useState<ModelDefault | null>(null);
	const [loadFailed, setLoadFailed] = useState(false);
	const [saving, setSaving] = useState(false);
	const [reading, setReading] = useState(true);
	const readSeq = useRef(0);

	const readDefault = useCallback(async () => {
		const seq = ++readSeq.current;
		setReading(true);
		const read = async () => {
			const next = await getTransport().request("model.default", {});
			if (seq !== readSeq.current) return;
			setResolvedDefault(next);
			setLoadFailed(false);
		};
		await read()
			.catch(() => {
				if (seq === readSeq.current) setLoadFailed(true);
			})
			.finally(() => {
				if (seq === readSeq.current) setReading(false);
			});
	}, []);

	useEffect(() => {
		void readDefault();
	}, [allModels, defaultModel, defaultEffort, readDefault]);

	const saveConfig = async (
		config: { defaultModel?: WireModel | null; defaultEffort?: ThinkingLevel | null },
		message: string,
	) => {
		if (saving || reading) return;
		setSaving(true);
		const save = async () => {
			await getTransport().request("settings.update", { config });
			await readDefault();
		};
		await save()
			.catch(() => toast.error(message))
			.finally(() => setSaving(false));
	};

	const configuredModel = selectCatalogModel(allModels, defaultModel ?? null);
	const model = resolvedDefault ? resolvedDefault.model : configuredModel;
	const level = resolvedDefault?.thinkingLevel ?? defaultEffort ?? "medium";
	const chatPickerModels = selectPickerModels(allModels, hiddenModels, [model]);
	return (
		<SettingsPageContainer testId="settings-models">
			<SettingsGroup title={t("settings.models.defaultGroup")}>
				{loadFailed ? (
					<div className="flex items-center gap-8 border-border-muted border-b py-12">
						<p className="text-text-muted tr-text-ui">{t("settings.models.loadFailed")}</p>
						<Button variant="ghost" size="m" onClick={() => void readDefault()}>
							{t("common.retry")}
						</Button>
					</div>
				) : resolvedDefault || !reading ? (
					<div
						data-testid="default-model-row"
						className="flex flex-wrap items-center justify-between gap-12 border-border-muted border-b py-12"
					>
						<span className="tr-text-ui text-text-default">{t("settings.models.chatModel")}</span>
						<div className="flex flex-wrap items-center gap-8">
							<ModelSelector
								models={chatPickerModels}
								current={model}
								refreshing={refreshing}
								onRefresh={refresh}
								onSelect={(selected) =>
									void saveConfig({ defaultModel: selected }, t("settings.models.saveModelFailed"))
								}
								placeholder={t("settings.models.firstAvailable")}
								disabled={saving || reading}
								preferences={preferences}
							/>
							<ThinkingSelector
								level={level}
								levels={model?.thinkingLevels ?? []}
								onSelect={(defaultEffort) =>
									void saveConfig({ defaultEffort }, t("settings.models.saveEffortFailed"))
								}
								disabled={saving || reading}
							/>
						</div>
					</div>
				) : null}
				<VisibleModelsSettings models={allModels} />
			</SettingsGroup>
		</SettingsPageContainer>
	);
}
