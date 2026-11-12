import { RiPencilLine as Pencil, RiCloseLine as X } from "@remixicon/react";
import type { SessionQueueState } from "@thinkrail/contracts";
import { useT } from "@thinkrail/locales/react";
import { IconButton } from "@thinkrail/ui/button";

export function QueueStrip({
	queue,
	onEdit,
	onRemove,
}: {
	queue: SessionQueueState;
	onEdit: (messageId: string) => void;
	onRemove: (messageId: string) => void;
}) {
	const t = useT();
	const items = [
		...queue.steering.map((message, index) => ({
			...message,
			kind: "steering" as const,
			index,
			label: t("chat.queue.steering"),
			hint: t("chat.queue.steeringHint"),
		})),
		...queue.followUp.map((message, index) => ({
			...message,
			kind: "followUp" as const,
			index,
			label: t("chat.queue.followUp"),
			hint: t("chat.queue.followUpHint"),
		})),
	];
	if (items.length === 0) return null;
	return (
		<div
			data-testid="queue-strip"
			className="flex w-full shrink-0 flex-col gap-2 border-border-default border-t bg-container-elevated-bg px-12 py-4 text-text-muted tr-text-metadata"
		>
			{items.map((item) => (
				<div
					key={item.id}
					data-testid="queue-item"
					data-kind={item.kind}
					data-index={item.index}
					data-message-id={item.id}
					data-state={item.state}
					title={`${item.text} — ${item.hint}`}
					className="flex w-full items-center gap-8"
				>
					<div className="min-w-0 flex-1">
						<div className="truncate">
							<span className="text-text-default">{item.label}:</span> {item.text}
						</div>
						<div>{t(item.state === "staged" ? "chat.queue.staged" : "chat.queue.pending")}</div>
						{item.error ? (
							<div role="alert" className="text-feedback-error">
								{item.error}
							</div>
						) : null}
					</div>
					<IconButton
						icon={Pencil}
						size="s"
						data-testid="queue-item-edit"
						label={t("chat.queue.edit", { text: item.text })}
						tooltip={t("common.edit")}
						onClick={() => onEdit(item.id)}
						disabled={item.state === "staged"}
						className="shrink-0"
					/>
					<IconButton
						icon={X}
						size="s"
						data-testid="queue-item-remove"
						label={t("chat.queue.remove", { text: item.text })}
						tooltip={t("common.remove")}
						onClick={() => onRemove(item.id)}
						disabled={item.state === "staged"}
						className="shrink-0"
					/>
				</div>
			))}
		</div>
	);
}
