// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import { DIFF_VIEW_URI_SCHEME } from "@hosts/vscode/VscodeDiffViewProvider"
import { WebviewProviderType as WebviewProviderTypeEnum } from "@shared/proto/cline/ui"
import assert from "node:assert"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import pWaitFor from "p-wait-for"
import { v4 as uuidv4 } from "uuid"
import * as vscode from "vscode"
import { sendAccountButtonClickedEvent } from "./core/controller/ui/subscribeToAccountButtonClicked"
import { sendChatButtonClickedEvent } from "./core/controller/ui/subscribeToChatButtonClicked"
import { sendHistoryButtonClickedEvent } from "./core/controller/ui/subscribeToHistoryButtonClicked"
import { sendMcpButtonClickedEvent } from "./core/controller/ui/subscribeToMcpButtonClicked"
import { sendSettingsButtonClickedEvent } from "./core/controller/ui/subscribeToSettingsButtonClicked"
import {
	migrateCustomInstructionsToGlobalRules,
	migrateWelcomeViewCompleted,
	migrateWorkspaceToGlobalStorage,
} from "./core/storage/state-migrations"
import { WebviewProvider } from "./core/webview"
import { createClineAPI } from "./exports"
import { ErrorService } from "./services/error/ErrorService"
import { Logger } from "./services/logging/Logger"
import { posthogClientProvider } from "./services/posthog/PostHogClientProvider"
import { telemetryService } from "./services/posthog/telemetry/TelemetryService"
import { cleanupTestMode, initializeTestMode } from "./services/test/TestMode"
import { WebviewProviderType } from "./shared/webview/types"
import "./utils/path" // necessary to have access to String.prototype.toPosix

import { HostProvider } from "@/hosts/host-provider"
import { vscodeHostBridgeClient } from "@/hosts/vscode/hostbridge/client/host-grpc-client"
import { readTextFromClipboard, writeTextToClipboard } from "@/utils/env"
import { ExtensionContext } from "vscode"
import { FileContextTracker } from "./core/context/context-tracking/FileContextTracker"
import { sendFocusChatInputEvent } from "./core/controller/ui/subscribeToFocusChatInput"
import { VscodeDiffViewProvider } from "./hosts/vscode/VscodeDiffViewProvider"
import { VscodeWebviewProvider } from "./hosts/vscode/VscodeWebviewProvider"
import { GitCommitGenerator } from "./integrations/git/commit-message-generator"
import { AuthService } from "./services/auth/AuthService"
import { ShowMessageType } from "./shared/proto/host/window"
/*
Built using https://github.com/microsoft/vscode-webview-ui-toolkit

Inspired by
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/default/weather-webview
https://github.com/microsoft/vscode-webview-ui-toolkit-samples/tree/main/frameworks/hello-world-react-cra

*/

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export async function activate(context: vscode.ExtensionContext) {
	maybeSetupHostProviders(context)

	ErrorService.initialize()
	Logger.log("Cline extension activated")

	// Migrate custom instructions to global Cline rules (one-time cleanup)
	await migrateCustomInstructionsToGlobalRules(context)

	// Migrate welcomeViewCompleted setting based on existing API keys (one-time cleanup)
	await migrateWelcomeViewCompleted(context)

	// Migrate workspace storage values back to global storage (reverting previous migration)
	await migrateWorkspaceToGlobalStorage(context)

	// Clean up orphaned file context warnings (startup cleanup)
	await FileContextTracker.cleanupOrphanedWarnings(context)

	// Version checking for autoupdate notification
	const currentVersion = context.extension.packageJSON.version
	const previousVersion = context.globalState.get<string>("clineVersion")
	const sidebarWebview = HostProvider.get().createWebviewProvider(WebviewProviderType.SIDEBAR)

	const testModeWatchers = await initializeTestMode(sidebarWebview)
	// Initialize test mode and add disposables to context
	context.subscriptions.push(...testModeWatchers)

	vscode.commands.executeCommand("setContext", "cline.isDevMode", IS_DEV && IS_DEV === "true")

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(WebviewProvider.sideBarId, sidebarWebview, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	)

	// Perform post-update actions if necessary
	try {
		if (!previousVersion || currentVersion !== previousVersion) {
			Logger.log(`Cline version changed: ${previousVersion} -> ${currentVersion}. First run or update detected.`)

			// Use the same condition as announcements: focus when there's a new announcement to show
			const lastShownAnnouncementId = context.globalState.get<string>("lastShownAnnouncementId")
			const latestAnnouncementId = context.extension?.packageJSON?.version?.split(".").slice(0, 2).join(".") ?? ""

			if (lastShownAnnouncementId !== latestAnnouncementId) {
				// Focus Cline when there's a new announcement to show (major/minor updates or fresh installs)
				const message = previousVersion
					? `Cline has been updated to v${currentVersion}`
					: `Welcome to Cline v${currentVersion}`
				await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
				await new Promise((resolve) => setTimeout(resolve, 200))
				HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message })
			}
			// Always update the main version tracker for the next launch.
			await context.globalState.update("clineVersion", currentVersion)
		}
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		console.error(`Error during post-update actions: ${errorMessage}, Stack trace: ${error.stack}`)
	}

	// backup id in case vscMachineID doesn't work
	let installId = context.globalState.get<string>("installId")

	if (!installId) {
		installId = uuidv4()
		await context.globalState.update("installId", installId)
	}

	telemetryService.captureExtensionActivated(installId)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.plusButtonClicked", async (webview: any) => {
			console.log("[DEBUG] plusButtonClicked", webview)
			// Pass the webview type to the event sender
			const isSidebar = !webview

			const openChat = async (instance: WebviewProvider) => {
				await instance?.controller.clearTask()
				await instance?.controller.postStateToWebview()
				await sendChatButtonClickedEvent(instance.controller.id)
			}

			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				if (sidebarInstance) {
					openChat(sidebarInstance)
					// Send event to the sidebar instance
				}
			} else {
				const tabInstances = WebviewProvider.getTabInstances()
				for (const instance of tabInstances) {
					openChat(instance)
				}
			}
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.mcpButtonClicked", (webview: any) => {
			console.log("[DEBUG] mcpButtonClicked", webview)

			const activeInstance = WebviewProvider.getActiveInstance()
			const isSidebar = !webview

			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				const sidebarInstanceId = sidebarInstance?.getClientId()
				if (sidebarInstanceId) {
					sendMcpButtonClickedEvent(sidebarInstanceId)
				} else {
					console.error("[DEBUG] No sidebar instance found, cannot send MCP button event")
				}
			} else {
				const activeInstanceId = activeInstance?.getClientId()
				if (activeInstanceId) {
					sendMcpButtonClickedEvent(activeInstanceId)
				} else {
					console.error("[DEBUG] No active instance found, cannot send MCP button event")
				}
			}
		}),
	)

	const openClineInNewTab = async () => {
		Logger.log("Opening Cline in new tab")
		// (this example uses webviewProvider activation event which is necessary to deserialize cached webview, but since we use retainContextWhenHidden, we don't need to use that event)
		// https://github.com/microsoft/vscode-extension-samples/blob/main/webview-sample/src/extension.ts
		const tabWebview = HostProvider.get().createWebviewProvider(WebviewProviderType.TAB)
		//const column = vscode.window.activeTextEditor ? vscode.window.activeTextEditor.viewColumn : undefined
		const lastCol = Math.max(...vscode.window.visibleTextEditors.map((editor) => editor.viewColumn || 0))

		// Check if there are any visible text editors, otherwise open a new group to the right
		const hasVisibleEditors = vscode.window.visibleTextEditors.length > 0
		if (!hasVisibleEditors) {
			await vscode.commands.executeCommand("workbench.action.newGroupRight")
		}
		const targetCol = hasVisibleEditors ? Math.max(lastCol + 1, 1) : vscode.ViewColumn.Two

		const panel = vscode.window.createWebviewPanel(WebviewProvider.tabPanelId, "Cline", targetCol, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [context.extensionUri],
		})
		// TODO: use better svg icon with light and dark variants (see https://stackoverflow.com/questions/58365687/vscode-extension-iconpath)

		panel.iconPath = {
			light: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_light.png"),
			dark: vscode.Uri.joinPath(context.extensionUri, "assets", "icons", "robot_panel_dark.png"),
		}
		tabWebview.resolveWebviewView(panel)

		// Lock the editor group so clicking on files doesn't open them over the panel
		await setTimeoutPromise(100)
		await vscode.commands.executeCommand("workbench.action.lockEditorGroup")
	}

	context.subscriptions.push(vscode.commands.registerCommand("cline.popoutButtonClicked", openClineInNewTab))
	context.subscriptions.push(vscode.commands.registerCommand("cline.openInNewTab", openClineInNewTab))

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.settingsButtonClicked", (webview: any) => {
			const isSidebar = !webview
			const webviewType = isSidebar ? WebviewProviderTypeEnum.SIDEBAR : WebviewProviderTypeEnum.TAB

			sendSettingsButtonClickedEvent(webviewType)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.historyButtonClicked", async (webview: any) => {
			console.log("[DEBUG] historyButtonClicked", webview)
			// Pass the webview type to the event sender
			const isSidebar = !webview
			const webviewType = isSidebar ? WebviewProviderTypeEnum.SIDEBAR : WebviewProviderTypeEnum.TAB

			// Send event to all subscribers using the gRPC streaming method
			await sendHistoryButtonClickedEvent(webviewType)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.accountButtonClicked", (webview: any) => {
			console.log("[DEBUG] accountButtonClicked", webview)

			const isSidebar = !webview
			if (isSidebar) {
				const sidebarInstance = WebviewProvider.getSidebarInstance()
				if (sidebarInstance) {
					// Send event to sidebar controller
					sendAccountButtonClickedEvent(sidebarInstance.controller.id)
				}
			} else {
				// Send to all tab instances
				const tabInstances = WebviewProvider.getTabInstances()
				for (const instance of tabInstances) {
					sendAccountButtonClickedEvent(instance.controller.id)
				}
			}
		}),
	)

	/*
	We use the text document content provider API to show the left side for diff view by creating a virtual document for the original content. This makes it readonly so users know to edit the right side if they want to keep their changes.

	- This API allows you to create readonly documents in VSCode from arbitrary sources, and works by claiming an uri-scheme for which your provider then returns text contents. The scheme must be provided when registering a provider and cannot change afterwards.
	- Note how the provider doesn't create uris for virtual documents - its role is to provide contents given such an uri. In return, content providers are wired into the open document logic so that providers are always considered.
	https://code.visualstudio.com/api/extension-guides/virtual-documents
	*/
	const diffContentProvider = new (class implements vscode.TextDocumentContentProvider {
		provideTextDocumentContent(uri: vscode.Uri): string {
			return Buffer.from(uri.query, "base64").toString("utf-8")
		}
	})()
	context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(DIFF_VIEW_URI_SCHEME, diffContentProvider))

	// URI Handler
	const handleUri = async (uri: vscode.Uri) => {
		console.log("URI Handler called with:", {
			path: uri.path,
			query: uri.query,
			scheme: uri.scheme,
		})

		const path = uri.path
		const query = new URLSearchParams(uri.query.replace(/\+/g, "%2B"))
		const visibleWebview = WebviewProvider.getVisibleInstance()
		if (!visibleWebview) {
			return
		}
		switch (path) {
			case "/openrouter": {
				const code = query.get("code")
				if (code) {
					await visibleWebview?.controller.handleOpenRouterCallback(code)
				}
				break
			}
			case "/auth": {
				console.log("Auth callback received:", uri.toString())

				const token = query.get("idToken")
				const provider = query.get("provider")

				console.log("Auth callback received:", { provider })

				if (token) {
					await visibleWebview?.controller.handleAuthCallback(token, provider)
					// await authService.handleAuthCallback(token)
				}
				break
			}
			default:
				break
		}
	}
	context.subscriptions.push(vscode.window.registerUriHandler({ handleUri }))

	// Register size testing commands in development mode
	if (IS_DEV && IS_DEV === "true") {
		// Use dynamic import to avoid loading the module in production
		import("./dev/commands/tasks")
			.then((module) => {
				const devTaskCommands = module.registerTaskCommands(context, sidebarWebview.controller)
				context.subscriptions.push(...devTaskCommands)
				Logger.log("Cline dev task commands registered")
			})
			.catch((error) => {
				Logger.log("Failed to register dev task commands: " + error)
			})
	}

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.addToChat", async (range?: vscode.Range, diagnostics?: vscode.Diagnostic[]) => {
			await vscode.commands.executeCommand("cline.focusChatInput") // Ensure Cline is visible and input focused
			await pWaitFor(() => !!WebviewProvider.getVisibleInstance())
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}

			// Use provided range if available, otherwise use current selection
			// (vscode command passes an argument in the first param by default, so we need to ensure it's a Range object)
			const textRange = range instanceof vscode.Range ? range : editor.selection
			const selectedText = editor.document.getText(textRange)

			if (!selectedText) {
				return
			}

			// Get the file path and language ID
			const filePath = editor.document.uri.fsPath
			const languageId = editor.document.languageId

			const visibleWebview = WebviewProvider.getVisibleInstance()
			await visibleWebview?.controller.addSelectedCodeToChat(
				selectedText,
				filePath,
				languageId,
				Array.isArray(diagnostics) ? diagnostics : undefined,
			)
			telemetryService.captureButtonClick("codeAction_addToChat", visibleWebview?.controller.task?.taskId)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.addTerminalOutputToChat", async () => {
			const terminal = vscode.window.activeTerminal
			if (!terminal) {
				return
			}

			// Save current clipboard content
			const tempCopyBuffer = await readTextFromClipboard()

			try {
				// Copy the *existing* terminal selection (without selecting all)
				await vscode.commands.executeCommand("workbench.action.terminal.copySelection")

				// Get copied content
				let terminalContents = (await readTextFromClipboard()).trim()

				// Restore original clipboard content
				await writeTextToClipboard(tempCopyBuffer)

				if (!terminalContents) {
					// No terminal content was copied (either nothing selected or some error)
					return
				}

				// [Optional] Any additional logic to process multi-line content can remain here
				// For example:
				/*
				const lines = terminalContents.split("\n")
				const lastLine = lines.pop()?.trim()
				if (lastLine) {
					let i = lines.length - 1
					while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
						i--
					}
					terminalContents = lines.slice(Math.max(i, 0)).join("\n")
				}
				*/

				// Send to sidebar provider
				const visibleWebview = WebviewProvider.getVisibleInstance()
				await visibleWebview?.controller.addSelectedTerminalOutputToChat(terminalContents, terminal.name)
			} catch (error) {
				// Ensure clipboard is restored even if an error occurs
				await writeTextToClipboard(tempCopyBuffer)
				console.error("Error getting terminal contents:", error)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to get terminal contents",
				})
			}
		}),
	)

	const CONTEXT_LINES_TO_EXPAND = 3
	const START_OF_LINE_CHAR_INDEX = 0
	const LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING = 1

	// Register code action provider
	context.subscriptions.push(
		vscode.languages.registerCodeActionsProvider(
			"*",
			new (class implements vscode.CodeActionProvider {
				public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.Refactor]

				provideCodeActions(
					document: vscode.TextDocument,
					range: vscode.Range,
					context: vscode.CodeActionContext,
				): vscode.CodeAction[] {
					const actions: vscode.CodeAction[] = []
					const editor = vscode.window.activeTextEditor // Get active editor for selection check

					// Expand range to include surrounding 3 lines or use selection if broader
					const selection = editor?.selection
					let expandedRange = range
					if (
						editor &&
						selection &&
						!selection.isEmpty &&
						selection.contains(range.start) &&
						selection.contains(range.end)
					) {
						expandedRange = selection
					} else {
						expandedRange = new vscode.Range(
							Math.max(0, range.start.line - CONTEXT_LINES_TO_EXPAND),
							START_OF_LINE_CHAR_INDEX,
							Math.min(
								document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
								range.end.line + CONTEXT_LINES_TO_EXPAND,
							),
							document.lineAt(
								Math.min(
									document.lineCount - LINE_COUNT_ADJUSTMENT_FOR_ZERO_INDEXING,
									range.end.line + CONTEXT_LINES_TO_EXPAND,
								),
							).text.length,
						)
					}

					// Add to Cline (Always available)
					const addAction = new vscode.CodeAction("Add to Cline", vscode.CodeActionKind.QuickFix)
					addAction.command = {
						command: "cline.addToChat",
						title: "Add to Cline",
						arguments: [expandedRange, context.diagnostics],
					}
					actions.push(addAction)

					// Explain with Cline (Always available)
					const explainAction = new vscode.CodeAction("Explain with Cline", vscode.CodeActionKind.RefactorExtract) // Using a refactor kind
					explainAction.command = {
						command: "cline.explainCode",
						title: "Explain with Cline",
						arguments: [expandedRange],
					}
					actions.push(explainAction)

					// Improve with Cline (Always available)
					const improveAction = new vscode.CodeAction("Improve with Cline", vscode.CodeActionKind.RefactorRewrite) // Using a refactor kind
					improveAction.command = {
						command: "cline.improveCode",
						title: "Improve with Cline",
						arguments: [expandedRange],
					}
					actions.push(improveAction)

					// Fix with Cline (Only if diagnostics exist)
					if (context.diagnostics.length > 0) {
						const fixAction = new vscode.CodeAction("Fix with Cline", vscode.CodeActionKind.QuickFix)
						fixAction.isPreferred = true
						fixAction.command = {
							command: "cline.fixWithCline",
							title: "Fix with Cline",
							arguments: [expandedRange, context.diagnostics],
						}
						actions.push(fixAction)
					}
					return actions
				}
			})(),
			{
				providedCodeActionKinds: [
					vscode.CodeActionKind.QuickFix,
					vscode.CodeActionKind.RefactorExtract,
					vscode.CodeActionKind.RefactorRewrite,
				],
			},
		),
	)

	// Register the command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.fixWithCline", async (range: vscode.Range, diagnostics: vscode.Diagnostic[]) => {
			// Add this line to focus the chat input first
			await vscode.commands.executeCommand("cline.focusChatInput")
			// Wait for a webview instance to become visible after focusing
			await pWaitFor(() => !!WebviewProvider.getVisibleInstance())
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}

			const selectedText = editor.document.getText(range)
			const filePath = editor.document.uri.fsPath
			const languageId = editor.document.languageId

			// Send to sidebar provider with diagnostics
			const visibleWebview = WebviewProvider.getVisibleInstance()
			await visibleWebview?.controller.fixWithCline(selectedText, filePath, languageId, diagnostics)
			telemetryService.captureButtonClick("codeAction_fixWithCline", visibleWebview?.controller.task?.taskId)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.explainCode", async (range: vscode.Range) => {
			await vscode.commands.executeCommand("cline.focusChatInput") // Ensure Cline is visible and input focused
			await pWaitFor(() => !!WebviewProvider.getVisibleInstance())
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}
			const selectedText = editor.document.getText(range)
			if (!selectedText.trim()) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Please select some code to explain.",
				})
				return
			}
			const filePath = editor.document.uri.fsPath
			const visibleWebview = WebviewProvider.getVisibleInstance()
			const fileMention = visibleWebview?.controller.getFileMentionFromPath(filePath) || filePath
			const prompt = `Explain the following code from ${fileMention}:\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``
			await visibleWebview?.controller.initTask(prompt)
			telemetryService.captureButtonClick("codeAction_explainCode", visibleWebview?.controller.task?.taskId)
		}),
	)

	context.subscriptions.push(
		vscode.commands.registerCommand("cline.improveCode", async (range: vscode.Range) => {
			await vscode.commands.executeCommand("cline.focusChatInput") // Ensure Cline is visible and input focused
			await pWaitFor(() => !!WebviewProvider.getVisibleInstance())
			const editor = vscode.window.activeTextEditor
			if (!editor) {
				return
			}
			const selectedText = editor.document.getText(range)
			if (!selectedText.trim()) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Please select some code to improve.",
				})
				return
			}
			const filePath = editor.document.uri.fsPath
			const visibleWebview = WebviewProvider.getVisibleInstance()
			const fileMention = visibleWebview?.controller.getFileMentionFromPath(filePath) || filePath
			const prompt = `Improve the following code from ${fileMention} (e.g., suggest refactorings, optimizations, or better practices):\n\`\`\`${editor.document.languageId}\n${selectedText}\n\`\`\``
			await visibleWebview?.controller.initTask(prompt)
			telemetryService.captureButtonClick("codeAction_improveCode", visibleWebview?.controller.task?.taskId)
		}),
	)

	// Register the focusChatInput command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.focusChatInput", async () => {
			let activeWebviewProvider: WebviewProvider | undefined = WebviewProvider.getVisibleInstance()

			// If a tab is visible and active, ensure it's fully revealed (might be redundant but safe)
			if (activeWebviewProvider?.getWebview() && activeWebviewProvider.getWebview().hasOwnProperty("reveal")) {
				const panelView = activeWebviewProvider.getWebview() as vscode.WebviewPanel
				panelView.reveal(panelView.viewColumn)
			} else if (!activeWebviewProvider) {
				// No webview is currently visible, try to activate the sidebar
				await vscode.commands.executeCommand("claude-dev.SidebarProvider.focus")
				await new Promise((resolve) => setTimeout(resolve, 200)) // Allow time for focus
				activeWebviewProvider = WebviewProvider.getSidebarInstance()

				if (!activeWebviewProvider) {
					// Sidebar didn't become active (might be closed or not in current view container)
					// Check for existing tab panels
					const tabInstances = WebviewProvider.getTabInstances()
					if (tabInstances.length > 0) {
						const potentialTabInstance = tabInstances[tabInstances.length - 1] // Get the most recent one
						if (potentialTabInstance.getWebview() && potentialTabInstance.getWebview().hasOwnProperty("reveal")) {
							const panelView = potentialTabInstance.getWebview() as vscode.WebviewPanel
							panelView.reveal(panelView.viewColumn)
							activeWebviewProvider = potentialTabInstance
						}
					}
				}

				if (!activeWebviewProvider) {
					// No existing Cline view found at all, open a new tab
					await vscode.commands.executeCommand("cline.openInNewTab")
					// After openInNewTab, a new webview is created. We need to get this new instance.
					// It might take a moment for it to register.
					await pWaitFor(
						() => {
							const visibleInstance = WebviewProvider.getVisibleInstance()
							// Ensure a boolean is returned
							return !!(visibleInstance?.getWebview() && visibleInstance.getWebview().hasOwnProperty("reveal"))
						},
						{ timeout: 2000 },
					)
					activeWebviewProvider = WebviewProvider.getVisibleInstance()
				}
			}
			// At this point, activeWebviewProvider should be the one we want to send the message to.
			// It could still be undefined if opening a new tab failed or timed out.
			if (activeWebviewProvider) {
				// Use the gRPC streaming method instead of postMessageToWebview
				const clientId = activeWebviewProvider.getClientId()
				sendFocusChatInputEvent(clientId)
			} else {
				console.error("FocusChatInput: Could not find or activate a Cline webview to focus.")
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Could not activate Cline view. Please try opening it manually from the Activity Bar.",
				})
			}
			telemetryService.captureButtonClick("command_focusChatInput", activeWebviewProvider?.controller.task?.taskId)
		}),
	)

	// Register the openWalkthrough command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.openWalkthrough", async () => {
			await vscode.commands.executeCommand("workbench.action.openWalkthrough", "saoudrizwan.claude-dev#ClineWalkthrough")
			telemetryService.captureButtonClick("command_openWalkthrough")
		}),
	)

	// Register the generateGitCommitMessage command handler
	context.subscriptions.push(
		vscode.commands.registerCommand("cline.generateGitCommitMessage", async (scm) => {
			await GitCommitGenerator?.generate?.(context, scm)
		}),
		vscode.commands.registerCommand("cline.abortGitCommitMessage", () => {
			GitCommitGenerator?.abort?.()
		}),
	)

	context.subscriptions.push(
		context.secrets.onDidChange(async (event) => {
			if (event.key === "clineAccountId") {
				// Check if the secret was removed (logout) or added/updated (login)
				const secretValue = await context.secrets.get("clineAccountId")
				const activeWebviewProvider = WebviewProvider.getVisibleInstance()
				const controller = activeWebviewProvider?.controller

				const authService = AuthService.getInstance(controller)
				if (secretValue) {
					// Secret was added or updated - restore auth info (login from another window)
					authService?.restoreRefreshTokenAndRetrieveAuthInfo()
				} else {
					// Secret was removed - handle logout for all windows
					authService?.handleDeauth()
				}
			}
		}),
	)

	return createClineAPI(sidebarWebview.controller)
}

export function getLatestAnnouncementId(context: vscode.ExtensionContext) {
	return context.extension?.packageJSON?.version?.split(".").slice(0, 2).join(".") ?? ""
}

function maybeSetupHostProviders(context: ExtensionContext) {
	if (!HostProvider.isInitialized()) {
		console.log("Setting up vscode host providers...")

		const createWebview = function (type: WebviewProviderType) {
			return new VscodeWebviewProvider(context, type)
		}
		const createDiffView = function () {
			return new VscodeDiffViewProvider()
		}
		const outputChannel = vscode.window.createOutputChannel("Cline")
		context.subscriptions.push(outputChannel)

		HostProvider.initialize(createWebview, createDiffView, vscodeHostBridgeClient, outputChannel.appendLine)
	}
}

// This method is called when your extension is deactivated
export async function deactivate() {
	// Dispose all webview instances
	await WebviewProvider.disposeAllInstances()

	// Clean up test mode
	cleanupTestMode()
	await posthogClientProvider.shutdown()

	Logger.log("Cline extension deactivated")
}

// TODO: Find a solution for automatically removing DEV related content from production builds.
//  This type of code is fine in production to keep. We just will want to remove it from production builds
//  to bring down built asset sizes.
//
// This is a workaround to reload the extension when the source code changes
// since vscode doesn't support hot reload for extensions
const IS_DEV = process.env.IS_DEV
const DEV_WORKSPACE_FOLDER = process.env.DEV_WORKSPACE_FOLDER

// Set up development mode file watcher
if (IS_DEV && IS_DEV !== "false") {
	assert(DEV_WORKSPACE_FOLDER, "DEV_WORKSPACE_FOLDER must be set in development")
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(DEV_WORKSPACE_FOLDER, "src/**/*"))

	watcher.onDidChange(({ scheme, path }) => {
		console.info(`${scheme} ${path} changed. Reloading VSCode...`)

		vscode.commands.executeCommand("workbench.action.reloadWindow")
	})
}
