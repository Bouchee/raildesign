import { RiExternalLinkLine as ExternalLink } from "@remixicon/react";
import type { ReactNode } from "react";

const LINK =
	"inline-flex items-center gap-2 rounded-sm text-primary underline underline-offset-2 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-primary";

export function NoticeLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a href={href} target="_blank" rel="noopener noreferrer" className={LINK}>
			{children}
			<ExternalLink className="size-12 shrink-0" aria-hidden />
		</a>
	);
}
