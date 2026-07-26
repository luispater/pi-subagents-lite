import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../../src/agents/agent-manager.js";
import { AgentNavigator } from "../../src/ui/agent-navigator.js";

function makeRecord(id = "agent-12345678", status = "running"): any {
  return {
    id,
    display: {
      type: "Explore",
      description: "Inspect the project",
    },
    lifecycle: {
      status,
      startedAt: Date.now(),
    },
    execution: {
      session: {
        messages: [
          { role: "user", content: [{ type: "text", text: "Inspect the project" }] },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "I should inspect files." },
              { type: "toolCall", id: "tool-1", name: "read", arguments: { path: "README.md" } },
              { type: "text", text: "I found the project structure." },
            ],
          },
          {
            role: "toolResult",
            toolName: "read",
            isError: false,
            content: [{ type: "text", text: "# Project" }],
          },
        ],
        agent: { state: {} },
      },
    },
    stats: {
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      toolUses: 1,
      turnCount: 1,
      compactionCount: 0,
    },
  };
}

function makeManager(records: any[]): AgentManager {
  return {
    listAgents: () => records,
    getRecord: (id: string) => records.find(record => record.id === id),
  } as unknown as AgentManager;
}

function makeTheme(): any {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function makeComponent(text: string): any {
  return {
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeContainer(text: string): any {
  return {
    children: [makeComponent(text)],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeNamedComponent(text: string, name: string): any {
  const component = makeComponent(text);
  Object.defineProperty(component, "constructor", { value: { name } });
  return component;
}

function makeChatContainer(text: string): any {
  return {
    children: [makeNamedComponent(text, "UserMessageComponent")],
    render: () => [text],
    invalidate: vi.fn(),
  };
}

function makeTui(prefixCount = 1): any {
  const originalChat = makeChatContainer("parent chat");
  const originalPending = makeContainer("parent pending");
  const originalStatus = makeContainer("parent status");
  const chatIndex = prefixCount;
  const pendingIndex = chatIndex + 1;
  const statusIndex = chatIndex + 2;
  const editorIndex = chatIndex + 4;
  const belowIndex = chatIndex + 5;
  const footerIndex = chatIndex + 6;
  const originalFooter = {
    render: () => ["parent cwd", "parent stats"],
    invalidate: vi.fn(),
  };
  Object.defineProperty(originalFooter, "constructor", {
    value: { name: "FooterComponent" },
  });
  return {
    chatIndex,
    pendingIndex,
    statusIndex,
    editorIndex,
    belowIndex,
    footerIndex,
    originalChat,
    originalPending,
    originalStatus,
    originalFooter,
    children: [
      ...Array.from({ length: prefixCount }, (_, index) => makeContainer(`header ${index}`)),
      originalChat,
      originalPending,
      originalStatus,
      makeContainer("above widgets"),
      makeContainer("editor"),
      makeContainer("below widgets"),
      originalFooter,
    ],
    terminal: {
      columns: 120,
      rows: 40,
      write: vi.fn(),
    },
    requestRender: vi.fn(),
  };
}

function makeUI(editorText: { value: string }) {
  const widgets = new Map<string, any>();
  const theme = makeTheme();
  const baseEditor = {
    getText: () => editorText.value,
    setText: (text: string) => { editorText.value = text; },
    handleInput: vi.fn(),
    wantsKeyRelease: true,
    actionHandlers: new Map<string, () => void>(),
    addToHistory: vi.fn(),
    render: () => [],
    invalidate: vi.fn(),
  };
  let editorFactory: any = () => baseEditor;
  return {
    widgets,
    theme,
    baseEditor,
    get editorFactory() { return editorFactory; },
    ctx: {
      get theme() { return theme; },
      getEditorComponent: () => editorFactory,
      getEditorText: () => editorText.value,
      notify: vi.fn(),
      setEditorComponent: vi.fn((factory: any) => { editorFactory = factory; }),
      setEditorText: vi.fn((text: string) => { editorText.value = text; }),
      setWidget: vi.fn((key: string, content: any) => {
        if (content === undefined) widgets.delete(key);
        else widgets.set(key, content);
      }),
    },
  };
}

function mountSelector(ui: ReturnType<typeof makeUI>, tui = makeTui()): any {
  const selectorFactory = ui.widgets.get("agent-navigator-selector");
  expect(selectorFactory).toBeTypeOf("function");
  const selector = selectorFactory(tui, ui.theme);
  const editor = ui.editorFactory(tui, {}, {});
  const editorContainer = tui.children[tui.editorIndex];
  if (editorContainer?.children) editorContainer.children = [editor];
  const below = tui.children[tui.belowIndex];
  if (below?.children) below.children.push(selector);
  selector.render(120);
  return { tui, selector };
}

describe("AgentNavigator", () => {
  let navigator: AgentNavigator | undefined;

  afterEach(() => {
    navigator?.dispose();
    vi.useRealTimers();
  });

  it("registers a below-editor selector containing main and subagents", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();

    const { selector } = mountSelector(ui);
    const text = selector.render(120).join("\n");

    expect(text).toContain("Main agent");
    expect(text).toContain("Explore agent-12");
    expect(text).toContain("●");
    expect(text).toContain("○");
    expect(ui.ctx.setWidget).toHaveBeenCalledWith(
      "agent-navigator-selector",
      expect.any(Function),
      { placement: "belowEditor" },
    );
  });

  it("animates the running status icon on the refresh timer", () => {
    vi.useFakeTimers();
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    expect(selector.render(120).join("\n")).toContain("⠋ Explore");

    vi.advanceTimersByTime(80);
    expect(selector.render(120).join("\n")).toContain("⠙ Explore");
    expect(tui.requestRender).toHaveBeenCalled();

    vi.advanceTimersByTime(80);
    expect(selector.render(120).join("\n")).toContain("⠹ Explore");
  });

  it("requires Enter before changing the active agent", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);

    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.children[tui.chatIndex]).not.toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).not.toBe(tui.originalPending);
    expect(tui.children[tui.statusIndex]).not.toBe(tui.originalStatus);
    expect(tui.children[tui.footerIndex]).not.toBe(tui.originalFooter);
    expect(tui.terminal.write).toHaveBeenCalledWith("\x1b[3J");
  });

  it("keeps the selected agent focused after confirmation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const text = selector.render(120).join("\n");
    expect(text).toContain("Agents · ↑↓ choose");
    expect(text).toContain("› ● ⠋ Explore");
    expect(navigator.handleTerminalInput("\x1b[A")).toEqual({ consume: true });
    expect(navigator.selectedId()).toBe(record.id);
    expect(selector.render(120).join("\n")).toContain("› ○ Main agent");
  });

  it("Escape cancels a highlighted candidate without switching", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui, selector } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    expect(selector.render(120).join("\n")).toContain("› ○ ⠋ Explore");

    navigator.handleTerminalInput("\x1b");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
  });

  it("restores the parent chat, pending, and status regions after confirmation", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).toBe(record.id);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    expect(navigator.selectedId()).toBe(record.id);
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.pendingIndex]).toBe(tui.originalPending);
    expect(tui.children[tui.statusIndex]).toBe(tui.originalStatus);
    expect(tui.children[tui.footerIndex]).toBe(tui.originalFooter);
  });

  it("decorates the editor and forwards printable input after leaving the list", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    const editor = ui.editorFactory(makeTui(), {}, {});
    expect(editor.wantsKeyRelease).toBe(true);
    editor.handleInput("\x1b[B");
    expect(ui.baseEditor.handleInput).not.toHaveBeenCalled();

    editor.handleInput("x");
    expect(ui.baseEditor.handleInput).toHaveBeenCalledWith("x");
  });

  it("routes ordinary editor submits before Pi can queue them on Main", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    const routeInput = vi.fn().mockResolvedValue(true);
    navigator = new AgentNavigator(makeManager([record]), routeInput);
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const editor = ui.editorFactory(makeTui(), {}, {});
    const parentSubmit = vi.fn();
    editor.onSubmit = parentSubmit;
    (ui.baseEditor as any).onSubmit("continue the child");

    expect(routeInput).toHaveBeenCalledWith(record.id, "continue the child");
    expect(ui.baseEditor.addToHistory).toHaveBeenCalledWith("continue the child");
    expect(parentSubmit).not.toHaveBeenCalled();

    const parentFollowUp = vi.fn();
    editor.actionHandlers.set("app.message.followUp", parentFollowUp);
    ui.baseEditor.setText("follow up the child");
    ui.baseEditor.actionHandlers.get("app.message.followUp")?.();
    expect(routeInput).toHaveBeenCalledWith(record.id, "follow up the child");
    expect(parentFollowUp).not.toHaveBeenCalled();
    expect(ui.baseEditor.getText()).toBe("");

    (ui.baseEditor as any).onSubmit("/agents");
    expect(parentSubmit).toHaveBeenCalledWith("/agents");
  });

  it("does not enter the selector when the editor contains text", () => {
    const record = makeRecord();
    const editorText = { value: "draft" };
    const ui = makeUI(editorText);
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    mountSelector(ui);

    expect(navigator.handleTerminalInput("\x1b[B")).toBeUndefined();
    expect(navigator.selectedId()).toBeNull();
  });

  it("renders the selected subagent conversation as the root chat", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const lines = tui.children[tui.chatIndex].render(120);
    const text = lines.join("\n");
    expect(text).toContain("Explore · agent-12 · running");
    expect(text).toContain("Inspect the project");
    expect(text).toContain("I should inspect files.");
    expect(text).toContain("read");
    expect(text).toContain("I found the project structure.");
    expect(text).toContain("# Project");
    expect(ui.widgets.has("agent-navigator-transcript")).toBe(false);
  });

  it("replaces Main footer stats with the selected subagent state", () => {
    const record = makeRecord();
    Object.assign(record.execution.session, {
      model: {
        id: "child-model",
        provider: "test",
        reasoning: true,
        contextWindow: 128_000,
      },
      thinkingLevel: "high",
      autoCompactionEnabled: true,
      modelRegistry: { isUsingOAuth: () => false },
      getSessionStats: () => ({
        tokens: {
          input: 12_000,
          output: 3_000,
          cacheRead: 20_000,
          cacheWrite: 0,
          total: 35_000,
        },
        cost: 0.25,
      }),
      getContextUsage: () => ({ percent: 25, contextWindow: 128_000 }),
      sessionManager: {
        getEntries: () => [],
      },
    });
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const footerLines = tui.children[tui.footerIndex].render(120);
    expect(footerLines[0]).toBe("parent cwd");
    expect(footerLines[1]).toContain("↑12k");
    expect(footerLines[1]).toContain("25.0%/128k (auto)");
    expect(footerLines[1]).toContain("child-model • high");
    expect(footerLines[1]).not.toContain("parent stats");
  });

  it("hides a one-line Main custom footer while a subagent is selected", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.originalFooter.render = () => ["main-model • xhigh"];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    const footerLines = tui.children[tui.footerIndex].render(120);
    expect(footerLines).toHaveLength(1);
    expect(footerLines[0]).not.toContain("main-model");
  });

  it("adopts a footer replaced by another extension while Main is selected", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    const replacementFooter = {
      render: () => ["replacement cwd", "replacement stats"],
      invalidate: vi.fn(),
    };
    tui.children[tui.footerIndex] = replacementFooter;

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");

    expect(tui.children[tui.footerIndex]).toBe(replacementFooter);
  });

  it("reconciles a footer appended by another extension on the child screen", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    const replacementFooter = {
      render: () => ["replacement cwd", "replacement stats"],
      invalidate: vi.fn(),
    };
    const staleChildFooter = tui.children[tui.footerIndex];
    tui.children.push(replacementFooter);
    tui.originalFooter.render = () => { throw new Error("disposed footer rendered"); };

    expect(staleChildFooter.render(120)).toEqual([]);
    expect(tui.children).toHaveLength(tui.footerIndex + 1);
    expect(tui.children[tui.footerIndex]).not.toBe(replacementFooter);
    expect(tui.requestRender).toHaveBeenCalled();

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[A");
    navigator.handleTerminalInput("\r");
    expect(tui.children[tui.footerIndex]).toBe(replacementFooter);
  });

  it("keeps footer reconciliation active while a completed child is selected", () => {
    const record = makeRecord("agent-12345678", "completed");
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    expect((navigator as any).refreshTimer).toBeUndefined();
    mountSelector(ui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect((navigator as any).refreshTimer).toBeDefined();
  });

  it("does not start a refresh timer before a TUI context is attached", () => {
    navigator = new AgentNavigator(makeManager([makeRecord()]));

    navigator.ensureTimer();

    expect((navigator as any).refreshTimer).toBeUndefined();
  });

  it("falls back to the main screen when the selected record disappears", () => {
    const records = [makeRecord()];
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager(records));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    expect(navigator.selectedId()).not.toBeNull();

    records.length = 0;
    navigator.update();

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(ui.widgets.size).toBe(0);
  });

  it("restores root components without writing to the terminal during dispose", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const { tui } = mountSelector(ui);
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");
    tui.terminal.write.mockClear();

    navigator.dispose();
    navigator = undefined;

    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(tui.children[tui.footerIndex]).toBe(tui.originalFooter);
    expect(tui.terminal.write).not.toHaveBeenCalled();
  });

  it("supports Pi layouts with a loaded-resources container before chat", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui(2);
    tui.originalChat.children = [];
    const firstHeader = tui.children[0];
    const loadedResources = tui.children[1];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBe(record.id);
    expect(tui.children[tui.chatIndex]).not.toBe(tui.originalChat);
    expect(tui.children[0]).toBe(firstHeader);
    expect(tui.children[1]).toBe(loadedResources);
    expect(ui.ctx.notify).not.toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it("rejects an unknown root region inserted between status and widgets", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui(1);
    tui.originalChat.children = [
      makeNamedComponent("skill invocation", "SkillInvocationMessageComponent"),
    ];
    tui.children.splice(tui.statusIndex + 1, 0, makeContainer("unknown region"));
    tui.editorIndex += 1;
    tui.belowIndex += 1;
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(tui.children[tui.chatIndex]).toBe(tui.originalChat);
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });

  it("rejects switching when the Pi root layout is unsupported", () => {
    const record = makeRecord();
    const ui = makeUI({ value: "" });
    navigator = new AgentNavigator(makeManager([record]));
    navigator.setUICtx(ui.ctx as any);
    navigator.ensureTimer();
    const tui = makeTui();
    tui.children = [makeComponent("unknown")];
    mountSelector(ui, tui);

    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\x1b[B");
    navigator.handleTerminalInput("\r");

    expect(navigator.selectedId()).toBeNull();
    expect(ui.ctx.notify).toHaveBeenCalledWith(
      "Subagent screen switching is unavailable: unsupported Pi TUI layout",
      "warning",
    );
  });
});
