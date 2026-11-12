import { BRAND_MARK_PATH, PRODUCT_NAME } from "../constants/branding";

export function BrandLogo() {
	return (
		<svg
			data-testid="brand-logo"
			role="img"
			aria-label={PRODUCT_NAME}
			width="32"
			height="32"
			viewBox="0 0 256 256"
			className="size-[32px] shrink-0 text-primary"
			xmlns="http://www.w3.org/2000/svg"
		>
			<path fillRule="evenodd" fill="currentColor" d={BRAND_MARK_PATH} />
		</svg>
	);
}
