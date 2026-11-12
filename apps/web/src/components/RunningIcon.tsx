import { useT } from "@thinkrail/locales/react";
import { cn } from "@thinkrail/ui/utils";
import { BRAND_MARK_PATH } from "../constants/branding";

export function RunningIcon({ className }: { className?: string | undefined }) {
	const t = useT();
	return (
		<span
			data-testid="running-icon"
			data-running="true"
			role="img"
			aria-label={t("components.runningIcon.label")}
			className={cn(
				"inline-flex shrink-0 items-center justify-center motion-safe:animate-pulse",
				className,
			)}
		>
			<svg aria-hidden="true" viewBox="0 0 256 256" className="size-full">
				<path fill="currentColor" fillRule="evenodd" d={BRAND_MARK_PATH} />
			</svg>
		</span>
	);
}
