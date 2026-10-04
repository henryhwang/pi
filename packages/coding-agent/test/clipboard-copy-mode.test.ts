import {
	getKeybindings,
	KeybindingsManager,
	setKeybindings,
	Text,
	TUI_KEYBINDINGS,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { copyToClipboard } from "../src/utils/clipboard.ts";

// Keep the real clipboard module but spy on copyToClipboard so the fallback
// (last assistant message) path can be asserted without touching the system clipboard.
vi.mock("../src/utils/clipboard.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../src/utils/clipboard.ts")>();
	return { ...actual, copyToClipboard: vi.fn(async () => {}) };
});

/**
 * Minimal stand-in for the InteractiveMode members read by handleCopyCommand.
 * The selection branch is what these cases exercise; the fallback branch reads
 * session.getLastAssistantText() and the status/error helpers.
 */
type CopyCommandHost = {
	ui: TuiAltScreen;
	session: { getLastAssistantText(): string | undefined };
	showError: (message: string) => void;
	showStatus: (message: string) => void;
};

function callHandleCopyCommand(
	host: CopyCommandHost,
	options: { flashConfirmation?: boolean; preferSelection?: boolean } = {},
): Promise<void> {
	const target = InteractiveMode.prototype as unknown as {
		handleCopyCommand(
			this: CopyCommandHost,
			options?: { flashConfirmation?: boolean; preferSelection?: boolean },
		): Promise<void>;
	};
	return target.handleCopyCommand.call(host, options);
}

/**
 * A real fullscreen TUI with an injected clipboard spy.
 * copyOnSelect: true models fullscreenCopyOnSelect: true (mouse release auto-copies).
 */
async function createFullscreenUi(): Promise<{
	ui: TuiAltScreen;
	terminal: VirtualTerminal;
	copied: string[];
	done: () => void;
}> {
	const originalKeybindings = getKeybindings();
	const terminal = new VirtualTerminal(20, 5);
	const copied: string[] = [];
	const ui = new TuiAltScreen(terminal, undefined, undefined, {
		copySelection: async (text) => {
			copied.push(text);
			return true;
		},
		copyOnSelect: true,
	});
	// ctrl+y is unbound in the defaults, so tests can enter copy mode deterministically.
	setKeybindings(new KeybindingsManager(TUI_KEYBINDINGS, { "tui.altScreen.copyMode": "ctrl+y" }));
	ui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
	ui.start();
	await terminal.waitForRender();
	return {
		ui,
		terminal,
		copied,
		done: () => {
			ui.stop();
			setKeybindings(originalKeybindings);
		},
	};
}

describe("handleCopyCommand with fullscreen selections", () => {
	test("copies an active copy-mode selection instead of the last assistant message", async () => {
		const { ui, terminal, copied, done } = await createFullscreenUi();
		try {
			terminal.sendInput("\x19"); // enter copy mode
			terminal.sendInput("k");
			terminal.sendInput("k");
			terminal.sendInput("V"); // linewise visual
			terminal.sendInput("j");
			await terminal.waitForRender();
			expect(ui.isCopyModeActive()).toBe(true);
			expect(ui.hasActiveSelection()).toBe(true);

			const host: CopyCommandHost = {
				ui,
				session: { getLastAssistantText: () => "last assistant text" },
				showError: vi.fn(),
				showStatus: vi.fn(),
			};
			await callHandleCopyCommand(host, { flashConfirmation: true, preferSelection: true });

			// The selection goes through the injected clipboard path, not the last-message fallback.
			expect(copied).toEqual(["beta\ngamma"]);
			expect(copyToClipboard).not.toHaveBeenCalled();
			expect(host.showError).not.toHaveBeenCalled();
			expect(host.showStatus).not.toHaveBeenCalled();
		} finally {
			done();
		}
	});

	test("falls back to the last assistant message when there is no selection", async () => {
		const { ui, terminal, copied, done } = await createFullscreenUi();
		try {
			terminal.sendInput("\x19"); // enter copy mode
			terminal.sendInput("\x1b"); // exit without selecting
			await terminal.waitForRender();
			expect(ui.isCopyModeActive()).toBe(false);
			expect(ui.hasActiveSelection()).toBe(false);

			const host: CopyCommandHost = {
				ui,
				session: { getLastAssistantText: () => "last assistant text" },
				showError: vi.fn(),
				showStatus: vi.fn(),
			};
			await callHandleCopyCommand(host, { flashConfirmation: true, preferSelection: true });

			expect(copied).toEqual([]);
			expect(copyToClipboard).toHaveBeenCalledWith("last assistant text");
			expect(host.showError).not.toHaveBeenCalled();
			expect(host.showStatus).not.toHaveBeenCalled();
		} finally {
			done();
		}
	});

	test("keeps the last-message fallback for mouse selections when copyOnSelect is enabled", async () => {
		const { ui, terminal, done } = await createFullscreenUi();
		try {
			// Mouse drag select of the first two rows; release auto-copies via copySelection
			// (copyOnSelect is true) and leaves the highlight in place.
			terminal.sendInput("\x1b[<0;1;1M");
			terminal.sendInput("\x1b[<32;2;2M");
			terminal.sendInput("\x1b[<0;2;2m");
			await terminal.waitForRender();
			expect(ui.hasActiveSelection()).toBe(true);
			expect(ui.isCopyModeActive()).toBe(false);

			const host: CopyCommandHost = {
				ui,
				session: { getLastAssistantText: () => "last assistant text" },
				showError: vi.fn(),
				showStatus: vi.fn(),
			};
			await callHandleCopyCommand(host, { flashConfirmation: true, preferSelection: true });

			// Mouse auto-copy already handled the selection, so Ctrl+X behaves exactly as before.
			expect(copyToClipboard).toHaveBeenCalledWith("last assistant text");
			expect(host.showError).not.toHaveBeenCalled();
			expect(host.showStatus).not.toHaveBeenCalled();
		} finally {
			done();
		}
	});
});
