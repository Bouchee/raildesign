const HOST_RESOURCE_ID = /^[A-Za-z0-9_-]{1,200}$/;

/** Application ids are bounded plain path components; no runtime journal is consulted. */
export function isHostResourceId(value: unknown): value is string {
	return typeof value === "string" && HOST_RESOURCE_ID.test(value);
}
