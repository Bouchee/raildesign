import { readdirSync } from "node:fs";
import { join } from "node:path";
import { removeTree } from "@thinkrail/shared/removeTree";
import { E2E_BINARY_CACHE, E2E_DATA_DIR, E2E_DESKTOP_CACHE } from "./fixtures/paths";

export default function globalTeardown(): void {
	for (const name of readdirSync(E2E_DATA_DIR)) {
		if (name !== "host.lock") removeTree(join(E2E_DATA_DIR, name));
	}
	removeTree(E2E_BINARY_CACHE);
	removeTree(E2E_DESKTOP_CACHE);
}
