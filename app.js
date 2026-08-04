(function () {
  "use strict";

  const STORAGE_KEY = "pm-app-state-v1";

  const STATUSES = [
    { key: "todo", label: "К выполнению" },
    { key: "inprogress", label: "В работе" },
    { key: "done", label: "Готово" },
  ];

  const PRIORITY_LABEL = { low: "Низкий", medium: "Средний", high: "Высокий" };

  /** @returns {{projects: Array, activeProjectId: string|null}} */
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { projects: [], activeProjectId: null };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.projects)) return { projects: [], activeProjectId: null };
      return parsed;
    } catch (e) {
      console.error("Не удалось прочитать сохранённые данные", e);
      return { projects: [], activeProjectId: null };
    }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function uid() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  let state = loadState();

  // DOM refs
  const projectListEl = document.getElementById("projectList");
  const projectTitleEl = document.getElementById("projectTitle");
  const projectStatsEl = document.getElementById("projectStats");
  const boardEl = document.getElementById("board");
  const emptyStateEl = document.getElementById("emptyState");

  const addProjectBtn = document.getElementById("addProjectBtn");
  const editProjectBtn = document.getElementById("editProjectBtn");
  const deleteProjectBtn = document.getElementById("deleteProjectBtn");
  const addTaskBtn = document.getElementById("addTaskBtn");

  const projectDialog = document.getElementById("projectDialog");
  const projectForm = document.getElementById("projectForm");
  const projectNameInput = document.getElementById("projectName");
  const projectDialogTitle = document.getElementById("projectDialogTitle");
  const cancelProjectBtn = document.getElementById("cancelProjectBtn");

  const taskDialog = document.getElementById("taskDialog");
  const taskForm = document.getElementById("taskForm");
  const taskDialogTitle = document.getElementById("taskDialogTitle");
  const taskIdInput = document.getElementById("taskId");
  const taskNameInput = document.getElementById("taskName");
  const taskDescriptionInput = document.getElementById("taskDescription");
  const taskPriorityInput = document.getElementById("taskPriority");
  const taskDueDateInput = document.getElementById("taskDueDate");
  const taskStatusInput = document.getElementById("taskStatus");
  const cancelTaskBtn = document.getElementById("cancelTaskBtn");

  let editingProjectId = null; // set when projectDialog is used for rename

  function getActiveProject() {
    return state.projects.find((p) => p.id === state.activeProjectId) || null;
  }

  function selectProject(id) {
    state.activeProjectId = id;
    saveState();
    render();
  }

  function render() {
    renderProjectList();
    renderBoard();
  }

  function renderProjectList() {
    projectListEl.innerHTML = "";
    state.projects.forEach((project) => {
      const li = document.createElement("li");
      li.textContent = project.name;
      if (project.id === state.activeProjectId) li.classList.add("active");

      const count = document.createElement("span");
      count.className = "count";
      count.textContent = project.tasks.length;
      li.appendChild(count);

      li.addEventListener("click", () => selectProject(project.id));
      projectListEl.appendChild(li);
    });
  }

  function renderBoard() {
    const project = getActiveProject();
    boardEl.innerHTML = "";

    const hasProjects = state.projects.length > 0;
    emptyStateEl.hidden = hasProjects;
    boardEl.hidden = !hasProjects;

    editProjectBtn.disabled = !project;
    deleteProjectBtn.disabled = !project;
    addTaskBtn.disabled = !project;

    if (!project) {
      projectTitleEl.textContent = "Выберите проект";
      projectStatsEl.textContent = "";
      return;
    }

    projectTitleEl.textContent = project.name;
    const done = project.tasks.filter((t) => t.status === "done").length;
    const total = project.tasks.length;
    projectStatsEl.textContent = total
      ? `Выполнено ${done} из ${total} задач`
      : "Задач пока нет";

    STATUSES.forEach((status) => {
      const column = document.createElement("div");
      column.className = "column";
      column.dataset.status = status.key;

      const header = document.createElement("div");
      header.className = "column-header";
      const tasksInColumn = project.tasks.filter((t) => t.status === status.key);
      header.innerHTML = `<span>${status.label}</span><span>${tasksInColumn.length}</span>`;
      column.appendChild(header);

      tasksInColumn.forEach((task) => column.appendChild(renderTaskCard(task)));

      column.addEventListener("dragover", (e) => {
        e.preventDefault();
        column.classList.add("drag-over");
      });
      column.addEventListener("dragleave", () => column.classList.remove("drag-over"));
      column.addEventListener("drop", (e) => {
        e.preventDefault();
        column.classList.remove("drag-over");
        const taskId = e.dataTransfer.getData("text/plain");
        moveTask(taskId, status.key);
      });

      boardEl.appendChild(column);
    });
  }

  function renderTaskCard(task) {
    const card = document.createElement("div");
    card.className = "task-card";
    card.draggable = true;
    card.dataset.taskId = task.id;

    card.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/plain", task.id);
      card.classList.add("dragging");
    });
    card.addEventListener("dragend", () => card.classList.remove("dragging"));

    const title = document.createElement("div");
    title.className = "task-card-title";
    title.textContent = task.name;
    card.appendChild(title);

    if (task.description) {
      const desc = document.createElement("div");
      desc.className = "task-card-desc";
      desc.textContent = task.description;
      card.appendChild(desc);
    }

    const meta = document.createElement("div");
    meta.className = "task-card-meta";

    const priority = document.createElement("span");
    priority.className = `priority priority-${task.priority}`;
    priority.textContent = PRIORITY_LABEL[task.priority];
    meta.appendChild(priority);

    if (task.dueDate) {
      const due = document.createElement("span");
      due.className = "due-date";
      const isOverdue = task.status !== "done" && task.dueDate < todayIso();
      if (isOverdue) due.classList.add("overdue");
      due.textContent = formatDate(task.dueDate);
      meta.appendChild(due);
    }

    card.appendChild(meta);

    const actions = document.createElement("div");
    actions.className = "task-card-actions";

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.textContent = "Изменить";
    editBtn.addEventListener("click", () => openTaskDialog(task));
    actions.appendChild(editBtn);

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.textContent = "Удалить";
    deleteBtn.addEventListener("click", () => deleteTask(task.id));
    actions.appendChild(deleteBtn);

    card.appendChild(actions);

    return card;
  }

  function todayIso() {
    return new Date().toISOString().slice(0, 10);
  }

  function formatDate(iso) {
    const [y, m, d] = iso.split("-");
    return `${d}.${m}.${y}`;
  }

  function moveTask(taskId, newStatus) {
    const project = getActiveProject();
    if (!project) return;
    const task = project.tasks.find((t) => t.id === taskId);
    if (!task || task.status === newStatus) return;
    task.status = newStatus;
    saveState();
    render();
  }

  function deleteTask(taskId) {
    const project = getActiveProject();
    if (!project) return;
    if (!confirm("Удалить эту задачу?")) return;
    project.tasks = project.tasks.filter((t) => t.id !== taskId);
    saveState();
    render();
  }

  // --- Project dialog ---

  addProjectBtn.addEventListener("click", () => {
    editingProjectId = null;
    projectDialogTitle.textContent = "Новый проект";
    projectNameInput.value = "";
    projectDialog.showModal();
    projectNameInput.focus();
  });

  editProjectBtn.addEventListener("click", () => {
    const project = getActiveProject();
    if (!project) return;
    editingProjectId = project.id;
    projectDialogTitle.textContent = "Переименовать проект";
    projectNameInput.value = project.name;
    projectDialog.showModal();
    projectNameInput.focus();
  });

  cancelProjectBtn.addEventListener("click", () => projectDialog.close());

  projectForm.addEventListener("submit", () => {
    const name = projectNameInput.value.trim();
    if (!name) return;

    if (editingProjectId) {
      const project = state.projects.find((p) => p.id === editingProjectId);
      if (project) project.name = name;
    } else {
      const project = { id: uid(), name, tasks: [] };
      state.projects.push(project);
      state.activeProjectId = project.id;
    }
    saveState();
    render();
  });

  deleteProjectBtn.addEventListener("click", () => {
    const project = getActiveProject();
    if (!project) return;
    if (!confirm(`Удалить проект «${project.name}» вместе со всеми задачами?`)) return;
    state.projects = state.projects.filter((p) => p.id !== project.id);
    state.activeProjectId = state.projects.length ? state.projects[0].id : null;
    saveState();
    render();
  });

  // --- Task dialog ---

  function openTaskDialog(task) {
    if (task) {
      taskDialogTitle.textContent = "Изменить задачу";
      taskIdInput.value = task.id;
      taskNameInput.value = task.name;
      taskDescriptionInput.value = task.description || "";
      taskPriorityInput.value = task.priority;
      taskDueDateInput.value = task.dueDate || "";
      taskStatusInput.value = task.status;
    } else {
      taskDialogTitle.textContent = "Новая задача";
      taskForm.reset();
      taskIdInput.value = "";
      taskPriorityInput.value = "medium";
      taskStatusInput.value = "todo";
    }
    taskDialog.showModal();
    taskNameInput.focus();
  }

  addTaskBtn.addEventListener("click", () => openTaskDialog(null));
  cancelTaskBtn.addEventListener("click", () => taskDialog.close());

  taskForm.addEventListener("submit", () => {
    const project = getActiveProject();
    if (!project) return;

    const name = taskNameInput.value.trim();
    if (!name) return;

    const taskData = {
      name,
      description: taskDescriptionInput.value.trim(),
      priority: taskPriorityInput.value,
      dueDate: taskDueDateInput.value || null,
      status: taskStatusInput.value,
    };

    if (taskIdInput.value) {
      const task = project.tasks.find((t) => t.id === taskIdInput.value);
      if (task) Object.assign(task, taskData);
    } else {
      project.tasks.push({ id: uid(), ...taskData });
    }

    saveState();
    render();
  });

  // Init: pick first project as active if none selected
  if (!state.activeProjectId && state.projects.length) {
    state.activeProjectId = state.projects[0].id;
  }

  render();
})();
