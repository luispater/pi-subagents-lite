/**
 * agent-navigator.ts — Keyboard-driven main/subagent view switching.
 *
 * The selector is rendered below the editor. Selecting a subagent replaces
 * Pi's root chat/pending/status components with the child transcript while
 * preserving the editor, agent widgets, and footer. The original components
 * remain alive off-screen and are restored when Main agent is selected.
 */

import {
  CustomEditor,
  type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type AutocompleteProvider,
  type Component,
  type EditorComponent,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRecord } from "../types.js";
import { summarizeToolArgs } from "./format.js";
import { renderAgentFooterStats } from "./agent-footer.js";
import { SPINNER } from "./agent-widget.js";
import type { Theme } from "./types.js";

const SELECTOR_WIDGET_KEY = "agent-navigator-selector";
const REFRESH_INTERVAL_MS = 80;
const TOOL_RESULT_CHAR_LIMIT = 4000;
const PI_0801_ROOT_CHILDREN = 8;
const PI_08010_ROOT_CHILDREN = 9;
const ROOT_REGIONS_AFTER_CHAT = 6;
const MAIN_CHAT_COMPONENT_PATTERN = /^(?:UserMessage|AssistantMessage|ToolExecution|BashExecution|SkillInvocationMessage|CustomEntry|CustomMessage|CompactionSummaryMessage|BranchSummaryMessage|Armin|Daxnuts|EarendilAnnouncement)Component$/;
const CLEAR_SCROLLBACK_SEQUENCE = "\x1b[3J";

type NavigatorUICtx = Pick<
  ExtensionUIContext,
  | "getEditorComponent"
  | "getEditorText"
  | "notify"
  | "setEditorComponent"
  | "setEditorText"
  | "setWidget"
  | "theme"
>;

type NavigationEntry = { id: string | null; record?: AgentRecord };

type MessageLike = {
  role: string;
  content?: unknown;
  toolName?: string;
  isError?: boolean;
  command?: string;
  output?: string;
  summary?: string;
};

interface ScreenSwapState {
  tui: TUI;
  rootChildren: Component[];
  chatIndex: number;
  pendingIndex: number;
  statusIndex: number;
  footerIndex: number;
  originalChat: Component;
  originalPending: Component;
  originalStatus: Component;
  originalFooter: Component;
  transcript: Component;
  emptyPending: Component;
  emptyStatus: Component;
  childFooter: Component;
  active: boolean;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((item): item is { type: string; text: string } =>
      typeof item === "object"
      && item !== null
      && (item as { type?: string }).type === "text"
      && typeof (item as { text?: unknown }).text === "string",
    )
    .map(item => item.text)
    .join("");
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter(item =>
    typeof item === "object"
    && item !== null
    && (item as { type?: string }).type === "image"
  ).length;
}

function formatToolCall(item: Record<string, unknown>): string {
  const name = typeof item.name === "string" ? item.name : "tool";
  const args = item.arguments && typeof item.arguments === "object"
    ? item.arguments as Record<string, unknown>
    : undefined;
  return `▸ ${name}${summarizeToolArgs(name, args)}`;
}

function appendWrapped(lines: string[], text: string, width: number): void {
  const wrapWidth = Math.max(1, width - 2);
  const sourceLines = text.split("\n");
  for (const sourceLine of sourceLines) {
    if (!sourceLine) {
      lines.push("");
      continue;
    }
    const wrapped = wrapTextWithAnsi(sourceLine, wrapWidth);
    lines.push(...wrapped.map(line => `  ${line}`));
  }
}

function statusIcon(record: AgentRecord, spinnerFrame: string): string {
  switch (record.lifecycle.status) {
    case "running": return spinnerFrame;
    case "queued": return "◦";
    case "completed": return "✓";
    case "turn_limited": return "✓";
    case "stopped": return "■";
    case "error": return "✗";
    case "aborted": return "✗";
  }
}

function isComponent(value: unknown): value is Component {
  return typeof value === "object"
    && value !== null
    && typeof (value as Component).render === "function"
    && typeof (value as Component).invalidate === "function";
}

function isContainerLike(value: unknown): value is Component & { children: Component[] } {
  return isComponent(value)
    && Array.isArray((value as { children?: unknown }).children);
}

function containsComponent(root: Component & { children: Component[] }, target: Component): boolean {
  for (const child of root.children) {
    if (child === target) return true;
    if (isContainerLike(child) && containsComponent(child, target)) return true;
  }
  return false;
}

function containsMainChatComponent(root: Component & { children: Component[] }): boolean {
  for (const child of root.children) {
    if (MAIN_CHAT_COMPONENT_PATTERN.test(child.constructor?.name ?? "")) return true;
    if (isContainerLike(child) && containsMainChatComponent(child)) return true;
  }
  return false;
}

function emptyComponent(): Component {
  return {
    render: () => [],
    invalidate: () => {},
  };
}

class ForwardingActionMap extends Map<string, () => void> {
  constructor(
    private base: Map<string, () => void>,
    private wrapFollowUp: (handler: () => void) => () => void,
  ) {
    super();
  }

  override set(action: string, handler: () => void): this {
    this.base.set(
      action,
      action === "app.message.followUp" ? this.wrapFollowUp(handler) : handler,
    );
    return this;
  }
}

/** Editor decorator that receives navigation keys only while the editor is focused. */
class AgentNavigationEditor implements EditorComponent, Focusable {
  private parentOnSubmit: ((text: string) => void) | undefined;
  private forwardedActions: ForwardingActionMap | undefined;

  constructor(
    private base: EditorComponent,
    private navigator: AgentNavigator,
  ) {}

  get focused(): boolean {
    return (this.base as Partial<Focusable>).focused ?? false;
  }

  get wantsKeyRelease(): boolean | undefined {
    return this.base.wantsKeyRelease;
  }

  set focused(value: boolean) {
    if ("focused" in this.base) {
      (this.base as EditorComponent & Focusable).focused = value;
    }
  }

  get onSubmit(): ((text: string) => void) | undefined {
    return this.parentOnSubmit;
  }

  set onSubmit(handler: ((text: string) => void) | undefined) {
    this.parentOnSubmit = handler;
    this.base.onSubmit = (text) => {
      if (this.navigator.handleEditorSubmit(text)) {
        this.base.addToHistory?.(text);
        return;
      }
      handler?.(text);
    };
  }

  get onChange(): ((text: string) => void) | undefined {
    return this.base.onChange;
  }

  set onChange(handler: ((text: string) => void) | undefined) {
    this.base.onChange = handler;
  }

  get borderColor(): ((text: string) => string) | undefined {
    return this.base.borderColor;
  }

  set borderColor(color: ((text: string) => string) | undefined) {
    this.base.borderColor = color;
  }

  get actionHandlers(): Map<string, () => void> | undefined {
    const baseActions = (this.base as unknown as { actionHandlers?: Map<string, () => void> }).actionHandlers;
    if (!baseActions) return undefined;
    this.forwardedActions ??= new ForwardingActionMap(
      baseActions,
      (parentHandler) => () => {
        const text = this.base.getExpandedText?.() ?? this.base.getText();
        if (this.navigator.handleEditorSubmit(text)) {
          this.base.addToHistory?.(text.trim());
          this.base.setText("");
          return;
        }
        parentHandler();
      },
    );
    return this.forwardedActions;
  }

  get onEscape(): (() => void) | undefined {
    return (this.base as unknown as { onEscape?: () => void }).onEscape;
  }

  set onEscape(handler: (() => void) | undefined) {
    (this.base as unknown as { onEscape?: () => void }).onEscape = handler;
  }

  get onCtrlD(): (() => void) | undefined {
    return (this.base as unknown as { onCtrlD?: () => void }).onCtrlD;
  }

  set onCtrlD(handler: (() => void) | undefined) {
    (this.base as unknown as { onCtrlD?: () => void }).onCtrlD = handler;
  }

  get onPasteImage(): (() => void) | undefined {
    return (this.base as unknown as { onPasteImage?: () => void }).onPasteImage;
  }

  set onPasteImage(handler: (() => void) | undefined) {
    (this.base as unknown as { onPasteImage?: () => void }).onPasteImage = handler;
  }

  get onExtensionShortcut(): ((data: string) => void) | undefined {
    return (this.base as unknown as { onExtensionShortcut?: (data: string) => void }).onExtensionShortcut;
  }

  set onExtensionShortcut(handler: ((data: string) => void) | undefined) {
    (this.base as unknown as { onExtensionShortcut?: (data: string) => void }).onExtensionShortcut = handler;
  }

  render(width: number): string[] {
    return this.base.render(width);
  }

  handleInput(data: string): void {
    const result = this.navigator.handleTerminalInput(data);
    if (!result?.consume) this.base.handleInput(data);
  }

  invalidate(): void {
    this.base.invalidate();
  }

  getText(): string {
    return this.base.getText();
  }

  setText(text: string): void {
    this.base.setText(text);
  }

  addToHistory(text: string): void {
    this.base.addToHistory?.(text);
  }

  insertTextAtCursor(text: string): void {
    this.base.insertTextAtCursor?.(text);
  }

  getExpandedText(): string {
    return this.base.getExpandedText?.() ?? this.base.getText();
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.base.setAutocompleteProvider?.(provider);
  }

  setPaddingX(padding: number): void {
    this.base.setPaddingX?.(padding);
  }

  setAutocompleteMaxVisible(maxVisible: number): void {
    this.base.setAutocompleteMaxVisible?.(maxVisible);
  }
}

export class AgentNavigator {
  private uiCtx: NavigatorUICtx | undefined;
  /** Agent whose transcript and input routing are active. Null means parent. */
  private selectedAgentId: string | null = null;
  /** Candidate row moved by Up/Down while the selector has focus. */
  private highlightedAgentId: string | null = null;
  private listFocused = false;
  private spinnerFrame = 0;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private selectorRegistered = false;
  private selectorTui: TUI | undefined;
  private screenSwap: ScreenSwapState | undefined;
  private layoutWarningShown = false;
  private restoreEditor: (() => void) | undefined;
  private navigationEditor: AgentNavigationEditor | undefined;

  constructor(
    private manager: AgentManager,
    private routeInput?: (agentId: string, text: string) => Promise<boolean>,
  ) {}

  setUICtx(ctx: NavigatorUICtx): void {
    if (ctx === this.uiCtx) return;
    if (this.restoreMainScreen()) this.clearScrollbackAndRender();
    this.restoreEditor?.();
    this.uiCtx = ctx;
    this.selectorRegistered = false;
    this.selectorTui = undefined;
    this.screenSwap = undefined;
    this.layoutWarningShown = false;

    const previousEditor = ctx.getEditorComponent();
    ctx.setEditorComponent((tui, theme, keybindings) => {
      const base = previousEditor?.(tui, theme, keybindings)
        ?? new CustomEditor(tui, theme, keybindings);
      const editor = new AgentNavigationEditor(base, this);
      this.navigationEditor = editor;
      return editor;
    });
    this.restoreEditor = () => {
      ctx.setEditorComponent(previousEditor);
      this.navigationEditor = undefined;
    };
    this.update();
  }

  selectedId(): string | null {
    if (this.selectedAgentId && !this.manager.getRecord(this.selectedAgentId)) {
      this.selectedAgentId = null;
      this.highlightedAgentId = null;
      this.listFocused = false;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
      this.update();
    }
    return this.selectedAgentId;
  }

  ensureTimer(): void {
    if (!this.uiCtx) return;
    if (!this.refreshTimer) {
      this.refreshTimer = setInterval(() => {
        this.spinnerFrame = (this.spinnerFrame + 1) % SPINNER.length;
        this.update();
      }, REFRESH_INTERVAL_MS);
    }
    this.update();
  }

  /** Route ordinary editor submissions before Pi can enqueue them on Main. */
  handleEditorSubmit(text: string): boolean {
    const agentId = this.selectedId();
    const trimmed = text.trim();
    if (
      !agentId
      || !trimmed
      || trimmed.startsWith("/")
      || trimmed.startsWith("!")
      || !this.routeInput
    ) {
      return false;
    }

    void this.routeInput(agentId, trimmed)
      .then((accepted) => {
        if (accepted) return;
        this.uiCtx?.setEditorText(text);
        this.uiCtx?.notify("Selected subagent is not available for interaction", "warning");
      })
      .catch(() => {
        this.uiCtx?.setEditorText(text);
        this.uiCtx?.notify("Failed to send input to selected subagent", "warning");
      });
    return true;
  }

  /**
   * Enter the list from an empty editor with Down. Up/Down only moves the
   * candidate row; Enter confirms the switch and keeps the active row focused.
   * Escape or Up above Main returns input to the editor.
   */
  handleTerminalInput(data: string): { consume?: boolean } | undefined {
    const entries = this.navigationEntries();
    if (entries.length <= 1) return undefined;

    if (!this.listFocused) {
      if (matchesKey(data, Key.down) && this.uiCtx?.getEditorText() === "") {
        this.listFocused = true;
        this.highlightedAgentId = this.selectedAgentId;
        this.requestRender();
        return { consume: true };
      }
      return undefined;
    }

    if (matchesKey(data, Key.escape)) {
      this.listFocused = false;
      this.highlightedAgentId = this.selectedAgentId;
      this.requestRender();
      return { consume: true };
    }

    if (matchesKey(data, Key.enter)) {
      const candidate = this.highlightedAgentId;
      if (!this.activate(candidate)) {
        this.highlightedAgentId = this.selectedAgentId;
      }
      this.update();
      return { consume: true };
    }

    const highlightedIndex = Math.max(
      0,
      entries.findIndex(entry => entry.id === this.highlightedAgentId),
    );

    if (matchesKey(data, Key.up)) {
      if (highlightedIndex === 0) {
        this.listFocused = false;
        this.highlightedAgentId = this.selectedAgentId;
      } else {
        this.highlightedAgentId = entries[highlightedIndex - 1]?.id ?? null;
      }
      this.requestRender();
      return { consume: true };
    }

    if (matchesKey(data, Key.down)) {
      if (highlightedIndex < entries.length - 1) {
        this.highlightedAgentId = entries[highlightedIndex + 1]?.id ?? null;
      }
      this.requestRender();
      return { consume: true };
    }

    if (data.length === 1 && data.charCodeAt(0) >= 32) {
      this.listFocused = false;
      this.highlightedAgentId = this.selectedAgentId;
      this.requestRender();
    }
    return undefined;
  }

  private navigationEntries(): NavigationEntry[] {
    return [
      { id: null },
      ...this.manager.listAgents().map(record => ({ id: record.id, record })),
    ];
  }

  private activate(id: string | null): boolean {
    if (id === this.selectedAgentId) return true;
    if (id && !this.manager.getRecord(id)) return false;

    if (id) {
      if (!this.swapToSubagentScreen()) {
        this.warnUnsupportedLayout();
        return false;
      }
      this.selectedAgentId = id;
    } else {
      this.selectedAgentId = null;
      this.restoreMainScreen();
    }

    this.highlightedAgentId = this.selectedAgentId;
    this.clearScrollbackAndRender();
    if (id && !this.refreshTimer) this.ensureTimer();
    return true;
  }

  private captureScreen(tui: TUI, selector: Component): void {
    if (this.screenSwap?.tui === tui) return;
    if (this.restoreMainScreen()) this.clearScrollbackAndRender();

    const rootChildren = tui.children;
    const belowMatches = rootChildren
      .map((child, index) => ({ child, index }))
      .filter(({ child }) => isContainerLike(child) && containsComponent(child, selector));
    const widgetBelowIndex = belowMatches[0]?.index ?? -1;
    const knownRootLength = rootChildren.length === PI_0801_ROOT_CHILDREN
      || rootChildren.length === PI_08010_ROOT_CHILDREN;
    const chatIndex = rootChildren.length - ROOT_REGIONS_AFTER_CHAT - 1;
    const pendingIndex = chatIndex + 1;
    const statusIndex = chatIndex + 2;
    const widgetAboveIndex = chatIndex + 3;
    const editorIndex = chatIndex + 4;
    const originalChat = rootChildren[chatIndex];
    const originalPending = rootChildren[pendingIndex];
    const originalStatus = rootChildren[statusIndex];
    const widgetAbove = rootChildren[widgetAboveIndex];
    const editorContainer = rootChildren[editorIndex];
    const widgetBelow = rootChildren[widgetBelowIndex];
    const footerIndex = widgetBelowIndex + 1;
    const originalFooter = rootChildren[footerIndex];
    // In 0.80.10 this slot is loaded resources. A main-message component here
    // instead identifies an older layout shifted by an unknown middle region.
    const shiftedChatCandidate = rootChildren.length === PI_08010_ROOT_CHILDREN
      ? rootChildren[chatIndex - 1]
      : undefined;
    const looksLikeShifted0801Layout = isContainerLike(shiftedChatCandidate)
      && containsMainChatComponent(shiftedChatCandidate);
    if (
      !knownRootLength
      || belowMatches.length !== 1
      || widgetBelowIndex !== rootChildren.length - 2
      || chatIndex < 1
      || looksLikeShifted0801Layout
      || !isContainerLike(originalChat)
      || !isContainerLike(originalPending)
      || !isContainerLike(originalStatus)
      || !isContainerLike(widgetAbove)
      || !isContainerLike(editorContainer)
      || !isContainerLike(widgetBelow)
      || !this.navigationEditor
      || !containsComponent(editorContainer, this.navigationEditor)
      || !isComponent(originalFooter)
    ) {
      this.screenSwap = undefined;
      this.warnUnsupportedLayout();
      return;
    }

    const transcript: Component = {
      render: (width) => this.renderActiveTranscript(width),
      invalidate: () => {},
    };
    const childFooter = this.createChildFooter(originalFooter);
    this.screenSwap = {
      tui,
      rootChildren,
      chatIndex,
      pendingIndex,
      statusIndex,
      footerIndex,
      originalChat,
      originalPending,
      originalStatus,
      originalFooter,
      transcript,
      emptyPending: emptyComponent(),
      emptyStatus: emptyComponent(),
      childFooter,
      active: false,
    };
  }

  private createChildFooter(originalFooter: Component): Component {
    let childFooter: Component;
    childFooter = {
      render: (width) => {
        const screen = this.screenSwap;
        if (screen?.active && screen.childFooter === childFooter) {
          this.syncExternalFooter(screen);
          if (screen.childFooter !== childFooter) {
            screen.tui.requestRender();
            return [];
          }
        }
        return this.renderChildFooter(originalFooter, width);
      },
      invalidate: () => originalFooter.invalidate(),
    };
    return childFooter;
  }

  private adoptFooter(screen: ScreenSwapState, originalFooter: Component): void {
    screen.originalFooter = originalFooter;
    screen.childFooter = this.createChildFooter(originalFooter);
  }

  /** Keep footer ownership correct when another extension calls setFooter(). */
  private syncExternalFooter(screen: ScreenSwapState): void {
    const children = screen.rootChildren;
    if (
      screen.active
      && children[screen.footerIndex] === screen.childFooter
      && children.length === screen.footerIndex + 2
      && isComponent(children[screen.footerIndex + 1])
    ) {
      children.splice(screen.footerIndex, 1);
      this.adoptFooter(screen, children[screen.footerIndex]);
      children[screen.footerIndex] = screen.childFooter;
      return;
    }

    if (children.length !== screen.footerIndex + 1) return;
    const currentFooter = children[screen.footerIndex];
    if (!isComponent(currentFooter)) return;

    if (screen.active) {
      if (currentFooter !== screen.childFooter) {
        this.adoptFooter(screen, currentFooter);
        children[screen.footerIndex] = screen.childFooter;
      }
    } else if (currentFooter !== screen.originalFooter) {
      this.adoptFooter(screen, currentFooter);
    }
  }

  private swapToSubagentScreen(): boolean {
    const screen = this.screenSwap;
    if (!screen) return false;
    this.syncExternalFooter(screen);

    const currentChat = screen.rootChildren[screen.chatIndex];
    const currentPending = screen.rootChildren[screen.pendingIndex];
    const currentStatus = screen.rootChildren[screen.statusIndex];
    const currentFooter = screen.rootChildren[screen.footerIndex];
    const chatCompatible = currentChat === screen.originalChat || currentChat === screen.transcript;
    const pendingCompatible = currentPending === screen.originalPending || currentPending === screen.emptyPending;
    const statusCompatible = currentStatus === screen.originalStatus || currentStatus === screen.emptyStatus;
    const footerCompatible = currentFooter === screen.originalFooter || currentFooter === screen.childFooter;
    if (!chatCompatible || !pendingCompatible || !statusCompatible || !footerCompatible) return false;

    screen.rootChildren[screen.chatIndex] = screen.transcript;
    screen.rootChildren[screen.pendingIndex] = screen.emptyPending;
    screen.rootChildren[screen.statusIndex] = screen.emptyStatus;
    screen.rootChildren[screen.footerIndex] = screen.childFooter;
    screen.active = true;
    return true;
  }

  private restoreMainScreen(): boolean {
    const screen = this.screenSwap;
    if (!screen?.active) return false;
    this.syncExternalFooter(screen);

    let restored = false;
    if (screen.rootChildren[screen.chatIndex] === screen.transcript) {
      screen.rootChildren[screen.chatIndex] = screen.originalChat;
      restored = true;
    }
    if (screen.rootChildren[screen.pendingIndex] === screen.emptyPending) {
      screen.rootChildren[screen.pendingIndex] = screen.originalPending;
      restored = true;
    }
    if (screen.rootChildren[screen.statusIndex] === screen.emptyStatus) {
      screen.rootChildren[screen.statusIndex] = screen.originalStatus;
      restored = true;
    }
    if (screen.rootChildren[screen.footerIndex] === screen.childFooter) {
      screen.rootChildren[screen.footerIndex] = screen.originalFooter;
      restored = true;
    }
    screen.active = false;
    return restored;
  }

  private warnUnsupportedLayout(): void {
    if (this.layoutWarningShown) return;
    this.layoutWarningShown = true;
    this.uiCtx?.notify(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  }

  private clearScrollbackAndRender(): void {
    const tui = this.screenSwap?.tui ?? this.selectorTui;
    if (!tui) return;
    try { tui.terminal.write(CLEAR_SCROLLBACK_SEQUENCE); } catch { /* best effort */ }
    tui.requestRender(true);
  }

  private requestRender(): void {
    const tui = this.screenSwap?.tui ?? this.selectorTui;
    tui?.requestRender();
  }

  private renderSelector(tui: TUI, theme: Theme): string[] {
    const entries = this.navigationEntries();
    const focusId = this.listFocused ? this.highlightedAgentId : this.selectedAgentId;
    const focusIndex = Math.max(0, entries.findIndex(entry => entry.id === focusId));
    const maxVisible = Math.max(2, Math.floor(tui.terminal.rows / 3));
    const visibleCount = Math.min(entries.length, maxVisible);
    const maxStart = Math.max(0, entries.length - visibleCount);
    const start = Math.min(maxStart, Math.max(0, focusIndex - Math.floor(visibleCount / 2)));
    const end = start + visibleCount;
    const visibleEntries = entries.slice(start, end);

    const hint = this.listFocused
      ? "↑↓ choose · Enter select · Esc editor"
      : "empty editor + ↓ to choose";
    const lines = [theme.fg("dim", `Agents · ${hint}`)];
    const spinnerFrame = SPINNER[this.spinnerFrame];

    if (start > 0) {
      lines.push(theme.fg("dim", `  ↑ ${start} hidden`));
    }

    for (const entry of visibleEntries) {
      const active = entry.id === this.selectedAgentId;
      const highlighted = this.listFocused && entry.id === this.highlightedAgentId;
      const circle = active ? theme.fg("accent", "●") : theme.fg("dim", "○");
      const focus = highlighted ? theme.fg("accent", "›") : " ";
      if (!entry.record) {
        const label = highlighted ? theme.bold("Main agent") : "Main agent";
        lines.push(truncateToWidth(`${focus} ${circle} ${label}`, tui.terminal.columns));
        continue;
      }

      const record = entry.record;
      const icon = statusIcon(record, spinnerFrame);
      const shortId = record.id.slice(0, 8);
      const label = `${record.display.type} ${shortId}`;
      const status = record.lifecycle.status === "running" ? "" : ` ${record.lifecycle.status}`;
      const text = highlighted ? theme.bold(label) : label;
      lines.push(truncateToWidth(
        `${focus} ${circle} ${theme.fg(record.lifecycle.status === "running" ? "accent" : "dim", icon)} ${text}${theme.fg("dim", status)}`,
        tui.terminal.columns,
      ));
    }

    if (end < entries.length) {
      lines.push(theme.fg("dim", `  ↓ ${entries.length - end} hidden`));
    }

    return lines;
  }

  private renderChildFooter(originalFooter: Component, width: number): string[] {
    const originalLines = originalFooter.render(width);
    const record = this.selectedAgentId
      ? this.manager.getRecord(this.selectedAgentId)
      : undefined;
    const theme = this.uiCtx?.theme;
    if (!record || !theme) return originalLines;

    const childStats = renderAgentFooterStats(record, theme, width);
    if (originalFooter.constructor?.name === "FooterComponent" && originalLines.length >= 2) {
      return [originalLines[0], childStats, ...originalLines.slice(2)];
    }
    return [childStats];
  }

  private renderActiveTranscript(width: number): string[] {
    const record = this.selectedAgentId
      ? this.manager.getRecord(this.selectedAgentId)
      : undefined;
    if (!record) return [];

    const theme = this.uiCtx?.theme;
    if (!theme) return [];
    return this.buildTranscriptLines(record, theme, width)
      .map(line => truncateToWidth(line, width));
  }

  private buildTranscriptLines(record: AgentRecord, theme: Theme, width: number): string[] {
    const shortId = record.id.slice(0, 8);
    const status = record.lifecycle.status;
    const lines: string[] = [
      theme.fg("accent", theme.bold(`${record.display.type} · ${shortId} · ${status}`)),
      theme.fg("dim", "─".repeat(Math.max(1, width))),
    ];

    const session = record.execution.session;
    if (!session) {
      lines.push(theme.fg("dim", status === "queued" ? "Waiting in queue…" : "Starting agent session…"));
      return lines;
    }

    const messages = session.messages as unknown as MessageLike[];
    for (const message of messages) {
      this.appendMessage(lines, message, theme, width);
    }

    const streamingMessage = (session.agent.state as unknown as { streamingMessage?: MessageLike }).streamingMessage;
    if (streamingMessage) {
      this.appendMessage(lines, streamingMessage, theme, width);
    }

    if (record.error) {
      lines.push(theme.fg("error", `Error: ${record.error}`));
    }

    return lines;
  }

  private appendMessage(lines: string[], message: MessageLike, theme: Theme, width: number): void {
    switch (message.role) {
      case "user": {
        const text = textFromContent(message.content);
        const images = imageCount(message.content);
        if (!text && images === 0) return;
        lines.push("");
        lines.push(theme.fg("accent", theme.bold("User")));
        if (text) appendWrapped(lines, text, width);
        if (images > 0) {
          appendWrapped(lines, theme.fg("dim", `[${images} image${images === 1 ? "" : "s"}]`), width);
        }
        return;
      }
      case "assistant": {
        if (!Array.isArray(message.content)) return;
        lines.push("");
        lines.push(theme.bold("Assistant"));
        for (const item of message.content as Array<Record<string, unknown>>) {
          if (item.type === "text" && typeof item.text === "string") {
            appendWrapped(lines, item.text, width);
          } else if (item.type === "thinking" && typeof item.thinking === "string") {
            lines.push(theme.fg("dim", "  Thinking"));
            appendWrapped(lines, theme.fg("dim", item.thinking), width);
          } else if (item.type === "toolCall") {
            appendWrapped(lines, theme.fg("dim", formatToolCall(item)), width);
          }
        }
        return;
      }
      case "toolResult": {
        const text = textFromContent(message.content);
        const clipped = text.length > TOOL_RESULT_CHAR_LIMIT
          ? `${text.slice(0, TOOL_RESULT_CHAR_LIMIT)}\n… (tool result truncated)`
          : text;
        const icon = message.isError ? theme.fg("error", "✗") : theme.fg("success", "✓");
        lines.push(`${icon} ${theme.fg("dim", message.toolName ?? "tool")}`);
        if (clipped) appendWrapped(lines, theme.fg("dim", clipped), width);
        return;
      }
      case "bashExecution": {
        lines.push("");
        lines.push(theme.fg("accent", `$ ${message.command ?? ""}`));
        if (message.output) appendWrapped(lines, message.output, width);
        return;
      }
      case "compactionSummary":
      case "branchSummary": {
        lines.push("");
        lines.push(theme.fg("dim", message.role === "compactionSummary" ? "Compaction summary" : "Branch summary"));
        if (message.summary) appendWrapped(lines, message.summary, width);
        return;
      }
    }
  }

  update(): void {
    if (!this.uiCtx) return;

    const records = this.manager.listAgents();
    if (this.screenSwap) this.syncExternalFooter(this.screenSwap);
    if (records.length === 0) {
      this.selectedAgentId = null;
      this.highlightedAgentId = null;
      this.listFocused = false;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
      this.unregisterWidgets();
      if (this.refreshTimer) {
        clearInterval(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      return;
    }

    if (this.selectedAgentId && !records.some(record => record.id === this.selectedAgentId)) {
      this.selectedAgentId = null;
      if (this.restoreMainScreen()) this.clearScrollbackAndRender();
    }
    if (this.highlightedAgentId && !records.some(record => record.id === this.highlightedAgentId)) {
      this.highlightedAgentId = this.selectedAgentId;
    }

    if (!this.selectorRegistered) {
      this.uiCtx.setWidget(SELECTOR_WIDGET_KEY, (tui, theme) => {
        this.selectorTui = tui;
        const selector: Component = {
          render: () => {
            this.captureScreen(tui, selector);
            return this.renderSelector(tui, theme);
          },
          invalidate: () => {},
        };
        return selector;
      }, { placement: "belowEditor" });
      this.selectorRegistered = true;
    }

    this.requestRender();

    if (!this.selectedAgentId && !records.some(record =>
      record.lifecycle.status === "running" || record.lifecycle.status === "queued"
    ) && this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private unregisterWidgets(): void {
    if (this.selectorRegistered) {
      this.uiCtx?.setWidget(SELECTOR_WIDGET_KEY, undefined);
      this.selectorRegistered = false;
      this.selectorTui = undefined;
    }
  }

  dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.restoreMainScreen()) this.requestRender();
    this.unregisterWidgets();
    this.screenSwap = undefined;
    this.restoreEditor?.();
    this.restoreEditor = undefined;
    this.uiCtx = undefined;
  }
}
