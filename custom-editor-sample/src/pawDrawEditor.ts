import * as path from 'path';
import * as vscode from 'vscode';
import { getNonce } from './util';

/**
 * Define the type of edits used in paw draw files.
 */
interface PawDrawEdit {
	readonly color: string;
	readonly stroke: ReadonlyArray<[number, number]>;
}

interface PawDrawDocumentDelegate {
	getFileData(): Promise<Uint8Array>;
}

/**
 * Define our document type.
 */
class PawDrawDocument implements vscode.CustomDocument {

	private static readonly backupFolder = 'pawDraw';

	static async create(
		uri: vscode.Uri,
		backupId: string | undefined,
		delegate: PawDrawDocumentDelegate,
	): Promise<PawDrawDocument | PromiseLike<PawDrawDocument>> {
		// If we have a backup, read that. Otherwise read the resource from the workspace
		let dataFile = uri;

		// Check for backup first
		if (typeof backupId === 'string') {
			dataFile = vscode.Uri.parse(backupId);
		}

		const fileData = await vscode.workspace.fs.readFile(dataFile);
		return new PawDrawDocument(uri, fileData, delegate);
	}

	private readonly _edits: Array<PawDrawEdit> = [];

	private _backupId = 0;

	private constructor(
		public readonly uri: vscode.Uri,
		public initialContent: Uint8Array,
		private readonly _delegate: PawDrawDocumentDelegate
	) { }

	//
	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	public readonly onDidDispose = this._onDidDispose.event;

	//
	private readonly _onDidChange = new vscode.EventEmitter<{
		readonly label: string,
		undo(): void,
		redo(): void,
	}>();
	public readonly onDidChange = this._onDidChange.event;

	//
	private readonly _onDidChangeDocument = new vscode.EventEmitter<void>();
	public readonly onDidChangeDocument = this._onDidChangeDocument.event;

	private readonly _onDidRevert = new vscode.EventEmitter<void>();
	public readonly onDidRevert = this._onDidRevert.event;

	public get edits() { return this._edits; }

	dispose(): void {
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		this._onDidChange.dispose();
		this._onDidChangeDocument.dispose();
		this._onDidRevert.dispose();
	}

	makeEdit(edit: PawDrawEdit) {
		this._edits.push(edit);

		this._onDidChange.fire({
			label: 'Stroke',
			undo: async () => {
				this._edits.pop();
				this._onDidChangeDocument.fire();
			},
			redo: async () => {
				this._edits.push(edit);
				this._onDidChangeDocument.fire();
			}
		});
	}

	async save(cancellation: vscode.CancellationToken): Promise<void> {
		await this.saveAs(this.uri, cancellation);
	}

	async saveAs(targetResource: vscode.Uri, cancellation: vscode.CancellationToken): Promise<void> {
		const fileData = await this._delegate.getFileData();
		if (!cancellation.isCancellationRequested) {
			await vscode.workspace.fs.writeFile(targetResource, fileData);
		}
	}

	async revert(_cancellation: vscode.CancellationToken): Promise<void> {
		const diskContent = await vscode.workspace.fs.readFile(this.uri);
		this.initialContent = diskContent;
		this._onDidRevert.fire();
	}

	async backup(destination: vscode.Uri, cancellation: vscode.CancellationToken): Promise<vscode.CustomDocumentBackup> {
		const id = this._backupId++;
		console.log(`backup: ${id}`);

		await this.saveAs(destination, cancellation);

		return {
			id: destination.toString(),
			delete: () => {
				console.log(`delete backup ${id}`);
				this.deleteBackup(destination);
			}
		};
	}

	private async deleteBackup(backupResource: vscode.Uri) {
		try {
			await vscode.workspace.fs.delete(backupResource);
		} catch {
			// noop
		}
	}

}

/**
 * Provider for paw draw editors.
 * 
 * Paw draw editors are used for `.pawDraw` files, which are just `.png` files with a different file extension.
 * 
 * This provider demonstrates:
 * 
 * - How to implement a custom editor for binary files.
 * - Setting up the initial webview for a custom editor.
 * - Loading scripts and styles in a custom editor.
 * - Communication between VS Code and the custom editor.
 * - Using CustomDocuments to store information that is shared between multiple custom editors.
 * - Implementing save, undo, redo, and revert.
 * - Backing up a custom editor.
 */
export class PawDrawEditorProvider implements vscode.CustomEditorProvider<PawDrawDocument> {

	public static register(context: vscode.ExtensionContext): vscode.Disposable {
		return vscode.window.registerCustomEditorProvider2(
			PawDrawEditorProvider.viewType,
			new PawDrawEditorProvider(context),
			{
				// For this demo extension, we enable `retainContextWhenHidden` which keeps the 
				// webview alive even when it is not visible. You should avoid using this setting
				// unless is absolutely required as it does have memory overhead.
				webviewOptions: {
					retainContextWhenHidden: true,
				},
				supportsMultipleEditorsPerDocument: false,
			});
	}

	public static readonly viewType = 'catCustoms.pawDraw';

	/**
	 * Tracks all known webviews
	 */
	private readonly webviews = new WebviewCollection();

	constructor(
		private readonly _context: vscode.ExtensionContext
	) { }

	//#region CustomEditorProvider

	async openCustomDocument(
		uri: vscode.Uri,
		openContext: { backupId?: string },
		_token: vscode.CancellationToken
	): Promise<PawDrawDocument> {
		const document = await PawDrawDocument.create(uri, openContext.backupId, {
			getFileData: async () => {
				const webviewsForDocument: any = Array.from(this.webviews.get(document.uri));
				if (!webviewsForDocument.length) {
					throw new Error('Could not find webview to save for');
				}
				const panel = webviewsForDocument[0];
				const response = await this.postMessageWithResponse<{ data: number[] }>(panel, 'getFileData', {});
				return new Uint8Array(response.data);
			}
		});

		const listeners: vscode.Disposable[] = [];

		listeners.push(document.onDidChange(e => {
			this._onDidChangeCustomDocument.fire({
				document,
				...e,
			});
		}));

		listeners.push(document.onDidChangeDocument(() => {
			for (const webviewPanel of this.webviews.get(document.uri)) {
				this.postMessage(webviewPanel, 'update', {
					edits: document.edits,
				});
			}
		}));

		listeners.push(document.onDidRevert(() => {
			for (const webviewPanel of this.webviews.get(document.uri)) {
				this.postMessage(webviewPanel, 'init', {
					value: document.initialContent
				});
			}
		}));

		document.onDidDispose(() => {
			for (const listener of listeners) {
				listener.dispose();
			}
		});

		return document;
	}

	async resolveCustomEditor(
		document: PawDrawDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		// Add the webview to our internal set of active webviews
		this.webviews.add(document.uri, webviewPanel);

		// Setup initial content for the webview
		webviewPanel.webview.options = {
			enableScripts: true,
		};
		webviewPanel.webview.html = this.getHtmlForWebview(webviewPanel.webview);

		webviewPanel.webview.onDidReceiveMessage(e => this.onMessage(document, e));

		// Wait for the webview to be properly ready before we init
		webviewPanel.webview.onDidReceiveMessage(e => {
			if (e.type === 'ready') {
				this.postMessage(webviewPanel, 'init', {
					value: document.initialContent
				});
			}
		});
	}

	private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<PawDrawDocument>>();
	public readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

	public saveCustomDocument(document: PawDrawDocument, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.save(cancellation);
	}

	public saveCustomDocumentAs(document: PawDrawDocument, destination: vscode.Uri, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.saveAs(destination, cancellation);
	}

	public revertCustomDocument(document: PawDrawDocument, cancellation: vscode.CancellationToken): Thenable<void> {
		return document.revert(cancellation);
	}

	public backupCustomDocument(document: PawDrawDocument, context: vscode.CustomDocumentBackupContext, cancellation: vscode.CancellationToken): Thenable<vscode.CustomDocumentBackup> {
		return document.backup(context.destination, cancellation);
	}

	//#endregion

	/**
	 * Get the static HTML used for in our editor's webviews.
	 */
	private getHtmlForWebview(webview: vscode.Webview): string {
		// Local path to script and css for the webview
		const scriptUri = webview.asWebviewUri(vscode.Uri.file(
			path.join(this._context.extensionPath, 'media', 'pawDraw.js')
		));
		const styleUri = webview.asWebviewUri(vscode.Uri.file(
			path.join(this._context.extensionPath, 'media', 'pawDraw.css')
		));

		// Use a nonce to whitelist which scripts can be run
		const nonce = getNonce();

		return /* html */`
			<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
				Use a content security policy to only allow loading images from https or from our extension directory,
				and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} blob:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleUri}" rel="stylesheet" />

				<title>Paw Draw</title>
			</head>
			<body>
				<div class="drawing-canvas"></div>

				<div class="drawing-controls">
					<button data-color="black" class="black active" title="Black"></button>
					<button data-color="white" class="white" title="White"></button>
					<button data-color="red" class="red" title="Red"></button>
					<button data-color="green" class="green" title="Green"></button>
					<button data-color="blue" class="blue" title="Blue"></button>
				</div>
				
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
	}


	private _requestId = 1;
	private readonly _callbacks = new Map<number, (response: any) => void>();

	private postMessageWithResponse<R = unknown>(panel: vscode.WebviewPanel, type: string, body: any): Promise<R> {
		const requestId = this._requestId++;
		const p = new Promise<R>(resolve => this._callbacks.set(requestId, resolve));
		panel.webview.postMessage({ type, requestId, body });
		return p;
	}

	private postMessage(panel: vscode.WebviewPanel, type: string, body: any): void {
		panel.webview.postMessage({ type, body });
	}

	private onMessage(document: PawDrawDocument, message: any) {
		switch (message.type) {
			case 'stroke':
				document.makeEdit(message as PawDrawEdit);
				return;

			case 'response':
				const callback = this._callbacks.get(message.requestId);
				if (callback) {
					callback(message.body);
				}
				return;
		}
	}
}

async function exists(backupResource: vscode.Uri): Promise<boolean> {
	try {
		await vscode.workspace.fs.stat(backupResource);
		return true;
	} catch {
		return false;
	}
}

/**
 * Tracks all webviews.
 */
class WebviewCollection {

	private readonly webviews = new Set<{ readonly resource: string, readonly webviewPanel: vscode.WebviewPanel }>();

	/**
	 * Get all known webviews for a given uri.
	 */
	public *get(uri: vscode.Uri): Iterable<vscode.WebviewPanel> {
		const key = uri.toString();
		for (const entry of this.webviews) {
			if (entry.resource === key) {
				yield entry.webviewPanel;
			}
		}
	}

	/**
	 * Add a new webview to the collection.
	 */
	public add(uri: vscode.Uri, webviewPanel: vscode.WebviewPanel) {
		const entry = { resource: uri.toString(), webviewPanel };
		this.webviews.add(entry);

		webviewPanel.onDidDispose(() => {
			this.webviews.delete(entry);
		});
	}
}