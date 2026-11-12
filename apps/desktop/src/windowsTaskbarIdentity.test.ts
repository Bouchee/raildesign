import { expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	desktopAppUserModelId,
	loadWindowsShellApi,
	stampTaskbarShortcuts,
	taskbarShortcutCandidates,
	type WindowsShortcut,
} from "./windowsTaskbarIdentity";

const POWERSHELL_TEST_TIMEOUT_MS = 30_000;

test("names one AppUserModelID per channel", () => {
	expect(desktopAppUserModelId("stable")).toBe("io.github.bouchee.raildesign");
	expect(desktopAppUserModelId("nightly")).toBe("io.github.bouchee.raildesign.nightly");
	expect(desktopAppUserModelId("dev")).toBe("io.github.bouchee.raildesign.dev");
	expect(() => desktopAppUserModelId("beta")).toThrow('unknown release channel "beta"');
});

function withTemp(run: (root: string) => void): void {
	const root = mkdtempSync(join(tmpdir(), "raildesign-taskbar-"));
	try {
		run(root);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function pinnedFolders(appData: string): { taskbar: string; implicit: string } {
	const pinned = join(appData, "Microsoft", "Internet Explorer", "Quick Launch", "User Pinned");
	const taskbar = join(pinned, "TaskBar");
	const implicit = join(pinned, "ImplicitAppShortcuts", "a1b2c3");
	mkdirSync(taskbar, { recursive: true });
	mkdirSync(implicit, { recursive: true });
	return { taskbar, implicit };
}

test("collects Electrobun's Start-menu shortcut and every taskbar pin, but not the Desktop shortcut", () => {
	withTemp((root) => {
		const channelRoot = join(root, "local", "io.github.bouchee.raildesign", "canary");
		mkdirSync(join(channelRoot, "app"), { recursive: true });
		writeFileSync(
			join(channelRoot, ".electrobun-uninstall.json"),
			JSON.stringify({
				schema_version: 1,
				desktop_shortcut: "C:\\Users\\me\\Desktop\\RailDesign (Canary).lnk",
				start_menu_shortcut: "C:\\Users\\me\\Start Menu\\Programs\\RailDesign (Canary).lnk",
			}),
		);
		const appData = join(root, "roaming");
		const { taskbar, implicit } = pinnedFolders(appData);
		writeFileSync(join(taskbar, "RailDesign (Canary).lnk"), "");
		writeFileSync(join(taskbar, "desktop.ini"), "");
		writeFileSync(join(implicit, "RailDesign (Canary).lnk"), "");

		expect(taskbarShortcutCandidates(join(channelRoot, "app"), appData)).toEqual({
			paths: [
				"C:\\Users\\me\\Start Menu\\Programs\\RailDesign (Canary).lnk",
				join(taskbar, "RailDesign (Canary).lnk"),
				join(implicit, "RailDesign (Canary).lnk"),
			],
			failures: [],
		});
	});
});

test("finds nothing for an unmanaged build or an unknown manifest schema", () => {
	withTemp((root) => {
		const appDir = join(root, "build", "RailDesign-dev");
		mkdirSync(appDir, { recursive: true });
		expect(taskbarShortcutCandidates(appDir, undefined)).toEqual({ paths: [], failures: [] });
		writeFileSync(
			join(root, "build", ".electrobun-uninstall.json"),
			JSON.stringify({ schema_version: 2, start_menu_shortcut: "C:\\x.lnk" }),
		);
		expect(taskbarShortcutCandidates(appDir, join(root, "missing"))).toEqual({
			paths: [],
			failures: [],
		});
	});
});

test("a corrupt manifest is reported without hiding the taskbar pins", () => {
	withTemp((root) => {
		const appDir = join(root, "channel", "app");
		mkdirSync(appDir, { recursive: true });
		writeFileSync(join(root, "channel", ".electrobun-uninstall.json"), "");
		const appData = join(root, "roaming");
		const { taskbar } = pinnedFolders(appData);
		writeFileSync(join(taskbar, "RailDesign.lnk"), "");

		const { paths, failures } = taskbarShortcutCandidates(appDir, appData);

		expect(paths).toEqual([join(taskbar, "RailDesign.lnk")]);
		expect(failures).toHaveLength(1);
		expect(failures[0]).toBeInstanceOf(SyntaxError);
	});
});

test("stamps only existing shortcuts to this launcher that carry another ID", () => {
	withTemp((root) => {
		const file = (name: string) => {
			const path = join(root, `${name}.lnk`);
			writeFileSync(path, "");
			return path;
		};
		const ours = file("ours");
		const current = file("current");
		const other = file("other");
		const broken = file("broken");
		const launcher =
			"C:\\Users\\me\\AppData\\Local\\io.github.bouchee.raildesign\\stable\\app\\bin\\launcher.exe";
		const ids = new Map<string, string | null>([
			[ours, null],
			[current, "io.github.bouchee.raildesign"],
			[other, null],
		]);
		const closed: string[] = [];
		const writableOpens: string[] = [];
		const open = (path: string, writable: boolean): WindowsShortcut => {
			if (path === broken) throw new Error("not a shortcut");
			if (writable) writableOpens.push(path);
			return {
				target: () =>
					path === other ? "\\\\fileserver\\tools\\other.exe" : launcher.toUpperCase(),
				appUserModelId: () => ids.get(path) ?? null,
				setAppUserModelId: (id) => ids.set(path, id),
				close: () => closed.push(path),
			};
		};
		const resolve = spyOn(realpathSync, "native");
		try {
			const result = stampTaskbarShortcuts(
				[ours, current, other, broken, join(root, "missing.lnk")],
				launcher,
				"io.github.bouchee.raildesign",
				open,
			);

			expect(result.stamped).toEqual([ours]);
			expect(result.failures).toEqual([new Error("not a shortcut")]);
			expect(ids.get(ours)).toBe("io.github.bouchee.raildesign");
			expect(ids.get(other)).toBeNull();
			expect(writableOpens).toEqual([ours]);
			expect(closed).toEqual([ours, ours, current, other]);
			expect(resolve.mock.calls.map(([path]) => String(path))).not.toContain(
				"\\\\fileserver\\tools\\other.exe",
			);
		} finally {
			resolve.mockRestore();
		}
	});
});

function powershell(script: string): string {
	const result = Bun.spawnSync(
		["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
		{
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	if (!result.success) {
		throw new Error(
			`powershell exited ${result.exitCode} (signal ${result.signalCode ?? "none"}): ${result.stderr.toString()}`,
		);
	}
	return result.stdout.toString().trim();
}

test.skipIf(process.platform !== "win32")("sets the process AppUserModelID", () => {
	const shell = loadWindowsShellApi();
	expect(loadWindowsShellApi()).toBe(shell);
	shell.setProcessAppUserModelId("io.github.bouchee.raildesign.Test");
	expect(shell.processAppUserModelId()).toBe("io.github.bouchee.raildesign.Test");
});

test.skipIf(process.platform !== "win32")(
	"stamps a real shortcut that targets the launcher",
	() => {
		withTemp((root) => {
			const launcher = join(root, "app", "bin", "launcher.exe");
			const other = join(root, "other.exe");
			mkdirSync(join(root, "app", "bin"), { recursive: true });
			writeFileSync(launcher, "");
			writeFileSync(other, "");
			const ours = join(root, "RailDesign.lnk");
			const foreign = join(root, "Other.lnk");
			for (const [path, target] of [
				[ours, launcher],
				[foreign, other],
			]) {
				powershell(
					`$s = (New-Object -ComObject WScript.Shell).CreateShortcut('${path}'); $s.TargetPath = '${target}'; $s.Save()`,
				);
			}
			const shell = loadWindowsShellApi();
			const id = "io.github.bouchee.raildesign.Test";
			shell.withComApartment(() => {
				const opened = shell.openShortcut(ours);
				try {
					expect(realpathSync.native(opened.target() ?? "")).toBe(realpathSync.native(launcher));
					expect(opened.appUserModelId()).toBeNull();
				} finally {
					opened.close();
				}

				expect(stampTaskbarShortcuts([ours, foreign], launcher, id, shell.openShortcut)).toEqual({
					stamped: [ours],
					failures: [],
				});
				expect(
					stampTaskbarShortcuts([ours, foreign], launcher, id, shell.openShortcut).stamped,
				).toEqual([]);
			});
			const readId = (path: string) =>
				powershell(
					`(New-Object -ComObject Shell.Application).NameSpace('${root}').ParseName('${path.slice(root.length + 1)}').ExtendedProperty('System.AppUserModel.ID')`,
				);
			expect(readId(ours)).toBe(id);
			expect(readId(foreign)).toBe("");
			shell.withComApartment(() => {
				const reopened = shell.openShortcut(ours);
				try {
					expect(reopened.appUserModelId()).toBe(id);
				} finally {
					reopened.close();
				}
			});
		});
	},
	POWERSHELL_TEST_TIMEOUT_MS,
);
