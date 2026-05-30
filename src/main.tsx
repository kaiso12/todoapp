/* eslint-disable no-alert */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-call */
/* eslint-disable @typescript-eslint/no-misused-promises */
/* eslint-disable @typescript-eslint/no-floating-promises */
/* eslint-disable obsidianmd/prefer-window-timers */

import { App, Modal, Plugin } from "obsidian";
import React, { useEffect, useMemo, useState } from "react";
import { createRoot, Root } from "react-dom/client";

type Priority = 1 | 2 | 3 | 4;
type TimeFilter = "today" | "tomorrow" | "week" | "all";
type InlineField = "project" | "due" | "priority" | null;

type Project = {
  id: string;
  name: string;
  color: string;
};

type Task = {
  id: string;
  title: string;
  projectId: string;
  note?: string;
  notePath?: string;
  due?: string;
  priority: Priority;
  completed: boolean;
  order: number;
  createdAt: string;
  updatedAt: string;
};

type TodoAppData = {
  id: string;
  displayTitle: string;
  displaySubtitle?: string;
  projects: Project[];
  tasks: Task[];
};

const DATA_DIR = ".todoapp";
const NOTE_DIR = "TodoApp Notes";

const PROJECT_COLORS = [
  "#e44332",
  "#f39c12",
  "#2d9cdb",
  "#27ae60",
  "#9b59b6",
  "#e67e22",
  "#16a085",
  "#d35400"
];

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function addDaysIso(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function tomorrowIso() {
  return addDaysIso(1);
}

function makeId() {
  return Math.random().toString(36).slice(2, 10);
}

function sanitizeFilename(name: string) {
  return name
    .replace(/[\\/:*?"<>|#^[\]]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "task";
}

function parseBlockId(source: string): string {
  const trimmed = source.trim();
  if (!trimmed) return "default";

  const idLine = trimmed
    .split("\n")
    .map((x) => x.trim())
    .find((x) => x.startsWith("id:"));

  if (idLine) return idLine.replace("id:", "").trim() || "default";
  return (trimmed.split("\n")[0] ?? "default").trim() || "default";
}

function dateLabel(date?: string) {
  if (!date) return "No date";
  if (date === todayIso()) return "Today";
  if (date === tomorrowIso()) return "Tomorrow";

  const parts = date.split("-");
  const y = parts[0];
  const m = parts[1];
  const d = parts[2];

  if (!y || !m || !d) return date;
  return `${d}.${m}.${y}`;
}

function isOverdue(date?: string) {
  return !!date && date < todayIso();
}

function timeFilterLabel(filter: TimeFilter) {
  if (filter === "today") return "Today";
  if (filter === "tomorrow") return "Tomorrow";
  if (filter === "week") return "Week";
  return "All";
}


function stripTodoAppNoteMeta(raw: string) {
  let text = raw;

  // New format: YAML frontmatter is metadata, user content follows.
  text = text.replace(/^---[\s\S]*?---\s*/, "");

  // Old format cleanup from previous versions.
  text = text.replace(/^# .*\n+/, "");
  text = text.replace(/^- Project: .*\n- Priority: .*\n- Due: .*\n- Task ID: .*\n+/m, "");
  text = text.replace(/^## Notes\s*/m, "");

  return text.trimStart();
}

function makeNoteFileContent(task: Task, projectName: string, body: string) {
  return [
    "---",
    `todoapp_task_id: ${task.id}`,
    `todoapp_task_title: ${JSON.stringify(task.title)}`,
    `todoapp_project: ${JSON.stringify(projectName)}`,
    `todoapp_priority: P${task.priority}`,
    `todoapp_due: ${task.due || ""}`,
    "---",
    "",
    body.trimStart()
  ].join("\n");
}

class TaskNoteModal extends Modal {
  private textarea!: HTMLTextAreaElement;

  constructor(
    app: App,
    private notePath: string,
    private task: Task,
    private projectName: string
  ) {
    super(app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("todoapp-note-modal");

    const header = contentEl.createDiv({ cls: "todoapp-note-modal-header" });

    header.createEl("div", {
      cls: "todoapp-note-modal-title",
      text: this.task.title
    });

    header.createEl("div", {
      cls: "todoapp-note-modal-meta",
      text: `${this.projectName} · P${this.task.priority}${this.task.due ? ` · ${dateLabel(this.task.due)}` : ""}`
    });

    this.textarea = contentEl.createEl("textarea", {
      cls: "todoapp-note-modal-textarea",
      attr: {
        placeholder: "Write notes, context, decisions, links, next steps..."
      }
    });

    const raw = await this.app.vault.adapter.read(this.notePath);
    this.textarea.value = stripTodoAppNoteMeta(raw);

    const footer = contentEl.createDiv({ cls: "todoapp-note-modal-footer" });

    const save = footer.createEl("button", {
      cls: "todoapp-note-modal-save",
      text: "Save"
    });

    const close = footer.createEl("button", {
      cls: "todoapp-note-modal-close",
      text: "Close"
    });

    save.onclick = async () => {
      await this.save();
      this.close();
    };

    close.onclick = async () => {
      await this.save();
      this.close();
    };

    setTimeout(() => this.textarea.focus(), 50);
  }

  async save() {
    await this.app.vault.adapter.write(
      this.notePath,
      makeNoteFileContent(this.task, this.projectName, this.textarea.value)
    );
  }

  async onClose() {
    this.contentEl.empty();
  }
}

class TodoStore {
  constructor(public app: App) {}

  private path(id: string) {
    return `${DATA_DIR}/${id}.json`;
  }

  private async ensureFolder(path: string) {
    const parts = path.split("/").filter(Boolean);
    let current = "";

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;

      if (await this.app.vault.adapter.exists(current)) continue;

      try {
        await this.app.vault.adapter.mkdir(current);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);

        // Obsidian sometimes throws this even though the folder is usable.
        // For folders, "already exists" is a successful result.
        if (message.toLowerCase().includes("already exists")) continue;

        if (await this.app.vault.adapter.exists(current)) continue;
        throw e;
      }
    }
  }

  private defaultData(id: string): TodoAppData {
    return {
      id,
      displayTitle: "TodoApp",
      displaySubtitle: id,
      projects: [
        { id: "inbox", name: "Inbox", color: "#808080" },
        { id: "work", name: "Work", color: "#e44332" },
        { id: "personal", name: "Personal", color: "#2d9cdb" },
        { id: "health", name: "Health", color: "#27ae60" }
      ],
      tasks: []
    };
  }

  private migrate(data: any, id: string): TodoAppData {
    const fallback = this.defaultData(id);

    const projects: Project[] = Array.isArray(data.projects)
      ? data.projects.map((p: any, index: number) => ({
          id: String(p.id || makeId()),
          name: String(p.name || "Project"),
          color: String(p.color || PROJECT_COLORS[index % PROJECT_COLORS.length])
        }))
      : fallback.projects;

    const tasks: Task[] = Array.isArray(data.tasks)
      ? data.tasks.map((t: any, index: number) => ({
          id: String(t.id || makeId()),
          title: String(t.title || "Untitled task"),
          projectId: String(t.projectId || "inbox"),
          note: t.note ? String(t.note) : undefined,
          notePath: t.notePath ? String(t.notePath) : undefined,
          due: t.due ? String(t.due) : undefined,
          priority: ([1, 2, 3, 4].includes(Number(t.priority)) ? Number(t.priority) : 4) as Priority,
          completed: Boolean(t.completed),
          order: typeof t.order === "number" ? t.order : index,
          createdAt: String(t.createdAt || new Date().toISOString()),
          updatedAt: String(t.updatedAt || new Date().toISOString())
        }))
      : [];

    return {
      id: String(data.id || id),
      displayTitle: String(data.displayTitle || "TodoApp"),
      displaySubtitle: String(data.displaySubtitle || id),
      projects,
      tasks
    };
  }

  async load(id: string): Promise<TodoAppData> {
    await this.ensureFolder(DATA_DIR);

    const path = this.path(id);

    if (await this.app.vault.adapter.exists(path)) {
      const raw = await this.app.vault.adapter.read(path);
      return this.migrate(JSON.parse(raw), id);
    }

    const data = this.defaultData(id);
    await this.save(id, data);
    return data;
  }

  async save(id: string, data: TodoAppData) {
    await this.ensureFolder(DATA_DIR);
    await this.app.vault.adapter.write(this.path(id), JSON.stringify(data, null, 2));
  }

  async openTaskNote(appId: string, task: Task, data: TodoAppData): Promise<TodoAppData> {
    await this.ensureFolder(`${NOTE_DIR}/${appId}`);

    const notePath =
      task.notePath && !task.notePath.startsWith(".todoapp/")
        ? task.notePath
        : `${NOTE_DIR}/${appId}/${sanitizeFilename(task.title)}-${task.id}.md`;

    if (!(await this.app.vault.adapter.exists(notePath))) {
      const projectName = data.projects.find((p) => p.id === task.projectId)?.name || "Inbox";
      await this.app.vault.adapter.write(
        notePath,
        makeNoteFileContent(task, projectName, "")
      );
    }

    const next: TodoAppData = {
      ...data,
      tasks: data.tasks.map((t) =>
        t.id === task.id ? { ...t, notePath, updatedAt: new Date().toISOString() } : t
      )
    };

    await this.save(appId, next);

    return next;
  }

  async deleteTaskNote(path: string) {
    if (await this.app.vault.adapter.exists(path)) {
      await this.app.vault.adapter.remove(path);
    }
  }
}

function TodoWidget(props: { store: TodoStore; appId: string }) {
  const { store, appId } = props;

  const [data, setData] = useState<TodoAppData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [timeFilter, setTimeFilterRaw] = useState<TimeFilter>("all");
  const [projectFilter, setProjectFilterRaw] = useState<string>("all");

  const [newTitle, setNewTitle] = useState("");
  const [newProjectId, setNewProjectId] = useState("inbox");
  const [newDue, setNewDue] = useState("");
  const [newPriority, setNewPriority] = useState<Priority>(4);
  const [newProjectName, setNewProjectName] = useState("");

  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [editingField, setEditingField] = useState<InlineField>(null);
  const [renamingProjectId, setRenamingProjectId] = useState<string | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState("");
  function setTimeFilter(next: TimeFilter) {
    setTimeFilterRaw(next);

    if (next === "today") setNewDue(todayIso());
    if (next === "tomorrow") setNewDue(tomorrowIso());
  }

  function setProjectFilter(next: string) {
    setProjectFilterRaw(next);
    setTimeFilterRaw("all");

    if (next !== "all") setNewProjectId(next);
  }

  useEffect(() => {
    let alive = true;

    setError(null);
    store
      .load(appId)
      .then((loaded) => {
        if (!alive) return;
        setData(loaded);

        const firstProject = loaded.projects[0]?.id || "inbox";
        setNewProjectId((prev) => prev || firstProject);
      })
      .catch((e) => {
        console.error("[todoapp] failed to load", e);
        if (alive) setError(e instanceof Error ? e.message : String(e));
      });

    return () => {
      alive = false;
    };
  }, [appId, store]);

  async function update(next: TodoAppData) {
    setData(next);
    await store.save(appId, next);
  }

  function activeProjectForAdd() {
    return projectFilter !== "all" ? projectFilter : newProjectId;
  }

  function defaultDueForAdd() {
    if (newDue) return newDue;
    if (timeFilter === "today") return todayIso();
    if (timeFilter === "tomorrow") return tomorrowIso();
    return "";
  }

  async function addTask() {
    if (!data || !newTitle.trim()) return;

    const now = new Date().toISOString();
    const maxOrder = data.tasks.reduce((m, t) => Math.max(m, t.order || 0), 0);

    const task: Task = {
      id: makeId(),
      title: newTitle.trim(),
      projectId: activeProjectForAdd(),
      due: defaultDueForAdd() || undefined,
      priority: newPriority,
      completed: false,
      order: maxOrder + 1,
      createdAt: now,
      updatedAt: now
    };

    await update({ ...data, tasks: [task, ...data.tasks] });
    setNewTitle("");
  }

  async function patchTask(taskId: string, patch: Partial<Task>) {
    if (!data) return;

    await update({
      ...data,
      tasks: data.tasks.map((t) =>
        t.id === taskId ? { ...t, ...patch, updatedAt: new Date().toISOString() } : t
      )
    });
  }

  function matchesProject(task: Task, projectId = projectFilter) {
    return projectId === "all" || task.projectId === projectId;
  }

  function matchesTime(task: Task, filter = timeFilter) {
    const today = todayIso();
    const tomorrow = tomorrowIso();
    const week = addDaysIso(7);

    if (filter === "today") return task.due === today;
    if (filter === "tomorrow") return task.due === tomorrow;
    if (filter === "week") return !!task.due && task.due >= today && task.due <= week;
    return true;
  }

  const visibleTasks = useMemo(() => {
    if (!data) return [];

    return data.tasks
      .filter((t) => matchesProject(t) && matchesTime(t))
      .sort((a, b) => {
        const aDate = a.due || "9999-99-99";
        const bDate = b.due || "9999-99-99";
        if (aDate !== bDate) return aDate.localeCompare(bDate);
        if (a.completed !== b.completed) return Number(a.completed) - Number(b.completed);
        if (a.priority !== b.priority) return a.priority - b.priority;
        return a.order - b.order;
      });
  }, [data, projectFilter, timeFilter]);

  const timeCounts = useMemo(() => {
    if (!data) return { today: 0, tomorrow: 0, week: 0, all: 0 };

    const active = data.tasks.filter((t) => !t.completed && matchesProject(t));

    return {
      today: active.filter((t) => matchesTime(t, "today")).length,
      tomorrow: active.filter((t) => matchesTime(t, "tomorrow")).length,
      week: active.filter((t) => matchesTime(t, "week")).length,
      all: active.length
    };
  }, [data, projectFilter]);

  const sortedProjects = useMemo(() => {
    if (!data) return [];

    return [...data.projects].sort((a, b) => {
      if (a.id === "inbox") return -1;
      if (b.id === "inbox") return 1;

      const score = (projectId: string) => {
        const tasks = data.tasks.filter((t) => !t.completed && t.projectId === projectId);
        const today = tasks.filter((t) => t.due === todayIso()).length;
        const tomorrow = tasks.filter((t) => t.due === tomorrowIso()).length;
        return {
          today,
          tomorrow,
          total: tasks.length
        };
      };

      const aa = score(a.id);
      const bb = score(b.id);

      if (aa.today !== bb.today) return bb.today - aa.today;
      if (aa.tomorrow !== bb.tomorrow) return bb.tomorrow - aa.tomorrow;
      if (aa.total !== bb.total) return bb.total - aa.total;
      return a.name.localeCompare(b.name);
    });
  }, [data]);

  const groupedTasks = useMemo(() => {
    const groups = new Map<string, Task[]>();

    for (const task of visibleTasks) {
      const key = task.due || "__no_date__";
      groups.set(key, [...(groups.get(key) || []), task]);
    }

    return Array.from(groups.entries()).sort(([a], [b]) => {
      const aa = a === "__no_date__" ? "9999-99-99" : a;
      const bb = b === "__no_date__" ? "9999-99-99" : b;
      return aa.localeCompare(bb);
    });
  }, [visibleTasks]);

  async function moveTask(taskId: string, dir: -1 | 1) {
    if (!data) return;

    const index = visibleTasks.findIndex((t) => t.id === taskId);
    const other = visibleTasks[index + dir];
    const current = visibleTasks[index];

    if (!current || !other) return;

    await update({
      ...data,
      tasks: data.tasks.map((t) => {
        if (t.id === current.id) return { ...t, order: other.order };
        if (t.id === other.id) return { ...t, order: current.order };
        return t;
      })
    });
  }

  async function deleteTask(task: Task) {
    if (!data) return;

    if (!task.completed && !window.confirm(`Delete task "${task.title}"?`)) return;

    let deleteNote = false;
    if (task.notePath) {
      deleteNote = window.confirm("This task has a note. Delete the note too?");
    }

    if (deleteNote && task.notePath) {
      await store.deleteTaskNote(task.notePath);
    }

    await update({
      ...data,
      tasks: data.tasks.filter((t) => t.id !== task.id)
    });
  }

  async function openNote(task: Task) {
    if (!data) return;

    try {
      const next = await store.openTaskNote(appId, task, data);
      setData(next);

      const updatedTask = next.tasks.find((t) => t.id === task.id) || task;
      if (!updatedTask.notePath) return;

      const notePath = updatedTask.notePath;
      if (!notePath) return;

      new TaskNoteModal(
        store.app,
        notePath,
        updatedTask,
        projectName(updatedTask.projectId)
      ).open();
    } catch (e) {
      console.error("[todoapp] failed to open note", e);
      window.alert(e instanceof Error ? e.message : String(e));
    }
  }

  async function addProject() {
    if (!data || !newProjectName.trim()) return;

    const project: Project = {
      id: makeId(),
      name: newProjectName.trim(),
      color: PROJECT_COLORS[data.projects.length % PROJECT_COLORS.length] ?? "#808080"
    };

    await update({ ...data, projects: [...data.projects, project] });
    setNewProjectName("");
    setProjectFilter(project.id);
    setNewProjectId(project.id);
  }

  async function renameProject(project: Project, nextName: string) {
    if (!data || project.id === "inbox") return;

    const clean = nextName.trim();
    if (!clean) return;

    await update({
      ...data,
      projects: data.projects.map((p) =>
        p.id === project.id ? { ...p, name: clean } : p
      )
    });

    setRenamingProjectId(null);
    setRenamingProjectName("");
  }

  async function deleteProject(project: Project) {
    if (!data || project.id === "inbox") return;

    const hasTasks = data.tasks.some((t) => t.projectId === project.id);

    if (hasTasks) {
      window.alert("Project is not empty. Move or delete its tasks first.");
      return;
    }

    if (!window.confirm(`Delete project "${project.name}"?`)) return;

    const nextProjects = data.projects.filter((p) => p.id !== project.id);
    await update({ ...data, projects: nextProjects });

    if (projectFilter === project.id) setProjectFilter("all");
    if (newProjectId === project.id) setNewProjectId(nextProjects[0]?.id || "inbox");
  }

  if (error) {
    return (
      <div className="todoapp">
        <div className="todoapp-error">
          <strong>TodoApp failed to load.</strong>
          <div>{error}</div>
        </div>
      </div>
    );
  }

  if (!data) {
    return <div className="todoapp">Loading...</div>;
  }

  const projectName = (id: string) =>
    data.projects.find((p) => p.id === id)?.name ?? "Inbox";

  const projectColor = (id: string) =>
    data.projects.find((p) => p.id === id)?.color ?? "#808080";

  function projectStats(projectId: string) {
    const tasks = data!.tasks.filter((t) => !t.completed && t.projectId === projectId);

    return {
      today: tasks.filter((t) => t.due && t.due <= todayIso()).length,
      tomorrow: tasks.filter((t) => t.due === tomorrowIso()).length,
      total: tasks.length,
      priorityToday: tasks.filter((t) => t.due && t.due <= todayIso() && t.priority <= 2).length
    };
  }

  function projectCountClass(stats: { today: number; tomorrow: number; total: number }) {
    if (stats.today > 0) return "todoapp-count is-today-count";
    if (stats.tomorrow > 0) return "todoapp-count is-tomorrow-count";
    return "todoapp-count";
  }

  function projectCountValue(stats: { today: number; tomorrow: number; total: number }) {
    if (stats.today > 0) return stats.today;
    if (stats.tomorrow > 0) return stats.tomorrow;
    return stats.total;
  }

  function startInline(taskId: string, field: InlineField) {
    setEditingTask(taskId);
    setEditingField(field);
  }

  function stopInline() {
    setEditingTask(null);
    setEditingField(null);
  }

  return (
    <div className="todoapp">
      <div className="todoapp-header">
        <input
          className="todoapp-title-input"
          value={data.displayTitle}
          onChange={(e) => update({ ...data, displayTitle: e.target.value })}
        />
        <span className="todoapp-id">id: {appId}</span>
      </div>

      <div className="todoapp-projects">
        <button
          className={projectFilter === "all" ? "is-active" : ""}
          onClick={() => setProjectFilter("all")}
        >
          All
        </button>

        {sortedProjects.map((p) => {
          const stats = projectStats(p.id);

          return (
            <div
              className={[
                "todoapp-project-pill",
                projectFilter === p.id ? "is-active" : "",
                stats.today > 0 ? "has-today" : "",
                stats.priorityToday > 0 ? "has-priority-today" : ""
              ].join(" ")}
              key={p.id}
            >
              {renamingProjectId === p.id ? (
                <input
                  className="todoapp-project-rename-input"
                  autoFocus
                  value={renamingProjectName}
                  onChange={(e) => setRenamingProjectName(e.target.value)}
                  onBlur={() => {
                    setRenamingProjectId(null);
                    setRenamingProjectName("");
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameProject(p, renamingProjectName);
                    if (e.key === "Escape") {
                      setRenamingProjectId(null);
                      setRenamingProjectName("");
                    }
                  }}
                />
              ) : (
                <button
                  className="todoapp-project-main"
                  onClick={() => setProjectFilter(p.id)}
                >
                  <span className="todoapp-color-dot" style={{ backgroundColor: p.color }} />
                  {p.name}
                  <span className={projectCountClass(stats)}>{projectCountValue(stats)}</span>
                </button>
              )}

              {projectFilter === p.id && p.id !== "inbox" && renamingProjectId !== p.id && (
                <div className="todoapp-project-actions">
                  <button
                    title="Rename project"
                    aria-label="Rename project"
                    onClick={() => {
                      setRenamingProjectId(p.id);
                      setRenamingProjectName(p.name);
                    }}
                  >
                    ✎
                  </button>
                  <button
                    title="Delete project"
                    aria-label="Delete project"
                    onClick={() => deleteProject(p)}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>
          );
        })}

        <input
          className="todoapp-add-project-input"
          value={newProjectName}
          placeholder="+ project"
          onChange={(e) => setNewProjectName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addProject();
          }}
        />
      </div>

      <div className="todoapp-time-tabs">
        {(["all", "today", "tomorrow", "week"] as TimeFilter[]).map((filter) => (
          <button
            key={filter}
            className={timeFilter === filter ? "is-active" : ""}
            onClick={() => setTimeFilter(filter)}
          >
            {timeFilterLabel(filter)}
            <span>{timeCounts[filter]}</span>
          </button>
        ))}
      </div>

      <div className="todoapp-add">
        <input
          value={newTitle}
          placeholder={`Add task to ${projectName(activeProjectForAdd())}...`}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") addTask();
          }}
        />

        <select value={activeProjectForAdd()} onChange={(e) => setNewProjectId(e.target.value)}>
          {data.projects.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>

        <input type="date" value={newDue} onChange={(e) => setNewDue(e.target.value)} />

        <select value={newPriority} onChange={(e) => setNewPriority(Number(e.target.value) as Priority)}>
          <option value={1}>P1</option>
          <option value={2}>P2</option>
          <option value={3}>P3</option>
          <option value={4}>P4</option>
        </select>

        <button onClick={addTask}>Add</button>
      </div>

      <div className="todoapp-list">
        {visibleTasks.length === 0 ? (
          <div className="todoapp-empty">No tasks here.</div>
        ) : (
          groupedTasks.map(([date, tasks]) => (
            <div className="todoapp-date-group" key={date}>
              <div
                className={[
                  "todoapp-date-separator",
                  date !== "__no_date__" && date <= todayIso() ? "is-today" : "",
                  date === tomorrowIso() ? "is-tomorrow" : ""
                ].join(" ")}
              >
                <span>{dateLabel(date === "__no_date__" ? undefined : date)}</span>
              </div>

              {tasks.map((task) => {
                const isEditingProject = editingTask === task.id && editingField === "project";
                const isEditingDue = editingTask === task.id && editingField === "due";
                const isEditingPriority = editingTask === task.id && editingField === "priority";

                return (
                  <div
                    className={[
                      "todoapp-task",
                      task.completed ? "is-completed" : "",
                      `priority-${task.priority}`
                    ].join(" ")}
                    key={task.id}
                  >
                    <input
                      className="todoapp-checkbox"
                      type="checkbox"
                      checked={task.completed}
                      onChange={(e) => patchTask(task.id, { completed: e.target.checked })}
                    />

                    <div className="todoapp-task-main">
                      <input
                        className="todoapp-task-title-input"
                        value={task.title}
                        onChange={(e) => patchTask(task.id, { title: e.target.value })}
                      />

                      <div className="todoapp-task-meta">
                        {isEditingProject ? (
                          <select
                            autoFocus
                            className="todoapp-inline-select"
                            value={task.projectId}
                            onBlur={stopInline}
                            onChange={(e) => {
                              patchTask(task.id, { projectId: e.target.value });
                              stopInline();
                            }}
                          >
                            {data.projects.map((p) => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            ))}
                          </select>
                        ) : (
                          <button
                            className="todoapp-project-link"
                            style={{ color: projectColor(task.projectId) }}
                            onClick={() => startInline(task.id, "project")}
                          >
                            {projectName(task.projectId)}
                          </button>
                        )}

                        {isEditingDue ? (
                          <input
                            autoFocus
                            className="todoapp-inline-date"
                            type="date"
                            value={task.due || ""}
                            onBlur={stopInline}
                            onChange={(e) => {
                              patchTask(task.id, { due: e.target.value || undefined });
                              stopInline();
                            }}
                          />
                        ) : (
                          <button
                            className={[
                              "todoapp-date-link",
                              task.due === todayIso() ? "is-today" : "",
                              task.due === tomorrowIso() ? "is-tomorrow" : "",
                              isOverdue(task.due) ? "is-overdue" : ""
                            ].join(" ")}
                            onClick={() => startInline(task.id, "due")}
                          >
                            {dateLabel(task.due)}
                          </button>
                        )}

                        {isEditingPriority ? (
                          <select
                            autoFocus
                            className={`todoapp-inline-priority priority-${task.priority}`}
                            value={task.priority}
                            onBlur={stopInline}
                            onChange={(e) => {
                              patchTask(task.id, { priority: Number(e.target.value) as Priority });
                              stopInline();
                            }}
                          >
                            <option value={1}>P1</option>
                            <option value={2}>P2</option>
                            <option value={3}>P3</option>
                            <option value={4}>P4</option>
                          </select>
                        ) : (
                          <button
                            className={`todoapp-priority-link priority-${task.priority}`}
                            onClick={() => startInline(task.id, "priority")}
                          >
                            P{task.priority}
                          </button>
                        )}

                        <button className="todoapp-order-link" onClick={() => moveTask(task.id, -1)}>↑</button>
                        <button className="todoapp-order-link" onClick={() => moveTask(task.id, 1)}>↓</button>
                      </div>
                    </div>

                    <div className="todoapp-task-actions">
                      <button
                        className={task.notePath ? "todoapp-note has-note" : "todoapp-note"}
                        title={task.notePath ? "Open note" : "Create note"}
                        onClick={() => openNote(task)}
                      >
                        {task.notePath ? "✎ Note" : "+ Note"}
                      </button>
                      <button className="todoapp-delete" onClick={() => deleteTask(task)}>×</button>
                    </div>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default class TodoAppPlugin extends Plugin {
  roots: Root[] = [];

  async onload() {
    const store = new TodoStore(this.app);

    this.registerMarkdownCodeBlockProcessor("todoapp", async (source, el) => {
      const appId = parseBlockId(source);
      const container = el.createDiv();
      const root = createRoot(container);

      this.roots.push(root);
      root.render(<TodoWidget store={store} appId={appId} />);
    });
  }

  onunload() {
    for (const root of this.roots) {
      root.unmount();
    }

    this.roots = [];
  }
}
