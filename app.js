import { firebaseConfig, firebaseEnabled } from "./firebase-config.js";

const FIREBASE_SDK_VERSION = "10.12.5";
const LAST_NICKNAME_KEY = "onle:lastNickname";
const LEGACY_STORAGE_KEY = "onle:v1";

const todayISO = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const uid = () =>
  crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());

const makeInitialState = (nickname = "") => ({
  user: nickname ? { name: nickname } : null,
  view: "daily",
  calendarMode: "rate",
  selectedDate: todayISO(),
  settings: {
    lowColor: "#ffffff",
    midColor: "#a7e46f",
    highColor: "#14883e",
  },
  projects: [
    { id: "p-onle", name: "ONLE 만들기", parentId: "", createdAt: todayISO() },
    { id: "p-health", name: "생활 루틴", parentId: "", createdAt: todayISO() },
  ],
  tasks: [
    {
      id: "t-1",
      title: "오늘의 첫 화면 설계하기",
      detail: "로그인 위젯과 기본 내비게이션 방향 잡기",
      projectId: "p-onle",
      date: todayISO(),
      done: true,
      createdAt: todayISO(),
    },
    {
      id: "t-2",
      title: "샐러드 해먹기",
      detail: "",
      projectId: "",
      date: todayISO(),
      done: false,
      createdAt: todayISO(),
    },
  ],
});

const defaultState = makeInitialState();

let state = structuredClone(defaultState);
let storage = null;
let activeNickname = "";
let unsubscribeRemote = null;
let saveTimer = null;
let applyingRemoteState = false;
let syncStatus = firebaseEnabled ? "Firebase 준비 중" : "로컬 모드";

class LocalUserStorage {
  constructor(nickname) {
    this.nickname = nickname;
    this.key = `onle:user:${nickname}`;
  }

  async load() {
    const legacy = localStorage.getItem(LEGACY_STORAGE_KEY);
    const stored = localStorage.getItem(this.key) || legacy;
    if (!stored) return null;
    return JSON.parse(stored);
  }

  async save(nextState) {
    localStorage.setItem(this.key, JSON.stringify(nextState));
    localStorage.setItem(LAST_NICKNAME_KEY, this.nickname);
  }

  subscribe(callback) {
    const onStorage = (event) => {
      if (event.key !== this.key || !event.newValue) return;
      callback(JSON.parse(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }
}

class FirebaseUserStorage {
  constructor(nickname, firebase) {
    this.nickname = nickname;
    this.firebase = firebase;
    this.local = new LocalUserStorage(nickname);
    this.docRef = firebase.doc(firebase.db, "users", nickname);
  }

  async load() {
    const localState = await this.local.load();
    const snapshot = await this.firebase.getDoc(this.docRef);
    if (!snapshot.exists()) {
      if (localState) await this.save(localState);
      return localState;
    }

    const data = snapshot.data();
    const remoteState = data.state || null;
    if (remoteState) await this.local.save(remoteState);
    return remoteState || localState;
  }

  async save(nextState) {
    await this.local.save(nextState);
    await this.firebase.setDoc(
      this.docRef,
      {
        nickname: this.nickname,
        state: nextState,
        updatedAt: this.firebase.serverTimestamp(),
      },
      { merge: true },
    );
  }

  subscribe(callback) {
    return this.firebase.onSnapshot(this.docRef, (snapshot) => {
      if (!snapshot.exists()) return;
      const data = snapshot.data();
      if (data.state) callback(data.state);
    });
  }
}

async function createFirebaseStorage(nickname) {
  const appModule = await import(
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-app.js`
  );
  const firestoreModule = await import(
    `https://www.gstatic.com/firebasejs/${FIREBASE_SDK_VERSION}/firebase-firestore.js`
  );

  const app = appModule.getApps().length
    ? appModule.getApp()
    : appModule.initializeApp(firebaseConfig);
  const db = firestoreModule.getFirestore(app);
  return new FirebaseUserStorage(nickname, { db, ...firestoreModule });
}

function normalizeNickname(value) {
  return String(value || "")
    .trim()
    .replaceAll("/", "-")
    .replaceAll("\\", "-")
    .slice(0, 64);
}

function mergeState(loadedState, nickname) {
  return {
    ...structuredClone(defaultState),
    ...loadedState,
    user: { name: nickname },
    tasks: Array.isArray(loadedState?.tasks) ? loadedState.tasks : defaultState.tasks,
    projects: Array.isArray(loadedState?.projects)
      ? loadedState.projects
      : defaultState.projects,
    settings: { ...defaultState.settings, ...(loadedState?.settings || {}) },
  };
}

async function openUser(nickname) {
  activeNickname = normalizeNickname(nickname);
  if (!activeNickname) return;

  syncStatus = firebaseEnabled ? "Firebase 연결 중" : "로컬 모드";
  render();

  if (unsubscribeRemote) {
    unsubscribeRemote();
    unsubscribeRemote = null;
  }

  try {
    storage = firebaseEnabled
      ? await createFirebaseStorage(activeNickname)
      : new LocalUserStorage(activeNickname);
    const loaded = await storage.load();
    state = mergeState(loaded || makeInitialState(activeNickname), activeNickname);
    localStorage.setItem(LAST_NICKNAME_KEY, activeNickname);
    syncStatus = firebaseEnabled ? "Firebase 동기화됨" : "로컬 저장됨";

    unsubscribeRemote = storage.subscribe((remoteState) => {
      if (!remoteState || applyingRemoteState) return;
      applyingRemoteState = true;
      state = mergeState(remoteState, activeNickname);
      syncStatus = firebaseEnabled ? "Firebase에서 업데이트됨" : "로컬 업데이트됨";
      render();
      applyingRemoteState = false;
    });

    await saveStateNow();
  } catch (error) {
    console.error(error);
    storage = new LocalUserStorage(activeNickname);
    const loaded = await storage.load();
    state = mergeState(loaded || makeInitialState(activeNickname), activeNickname);
    syncStatus = "Firebase 실패, 로컬 저장 중";
  }

  render();
}

function scheduleSave() {
  if (!state.user || !storage || applyingRemoteState) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveStateNow, 350);
}

async function saveStateNow() {
  if (!state.user || !storage) return;
  try {
    syncStatus = firebaseEnabled && storage instanceof FirebaseUserStorage ? "저장 중" : "로컬 저장 중";
    await storage.save(state);
    syncStatus = firebaseEnabled && storage instanceof FirebaseUserStorage ? "Firebase 동기화됨" : "로컬 저장됨";
  } catch (error) {
    console.error(error);
    syncStatus = "저장 실패";
  }
}

function percent(done, total) {
  return total ? Math.round((done / total) * 100) : 0;
}

function projectTaskIds(projectId) {
  const descendants = new Set([projectId]);
  let changed = true;
  while (changed) {
    changed = false;
    state.projects.forEach((project) => {
      if (
        project.parentId &&
        descendants.has(project.parentId) &&
        !descendants.has(project.id)
      ) {
        descendants.add(project.id);
        changed = true;
      }
    });
  }
  return state.tasks.filter((task) => descendants.has(task.projectId));
}

function projectRate(projectId) {
  const tasks = projectTaskIds(projectId);
  return percent(tasks.filter((task) => task.done).length, tasks.length);
}

function dayTasks(date) {
  return state.tasks.filter((task) => task.date === date);
}

function dayRate(date) {
  const tasks = dayTasks(date);
  return percent(tasks.filter((task) => task.done).length, tasks.length);
}

function render() {
  const app = document.querySelector("#app");
  if (!state.user) {
    app.innerHTML = renderWelcome();
    bindWelcome();
    return;
  }

  app.innerHTML = `
    <div class="shell">
      ${renderSidebar()}
      <main class="main">
        ${renderTopbar()}
        <section class="view ${state.view === "daily" ? "active" : ""}">${renderDaily()}</section>
        <section class="view ${state.view === "projects" ? "active" : ""}">${renderProjects()}</section>
        <section class="view ${state.view === "calendar" ? "active" : ""}">${renderCalendar()}</section>
        <section class="view ${state.view === "settings" ? "active" : ""}">${renderSettings()}</section>
      </main>
      ${renderBottomNav()}
      <button class="fab" title="추가" data-action="${state.view === "projects" ? "open-project-modal" : "open-task-modal"}">+</button>
    </div>
  `;
  bindApp();
}

function renderWelcome() {
  const lastNickname = localStorage.getItem(LAST_NICKNAME_KEY) || "";
  return `
    <main class="welcome">
      <section class="welcome-card">
        <h1>ONLE</h1>
        <p>닉네임별 저장소를 열어 오늘의 일, 프로젝트, 달력 기록을 동기화합니다.</p>
        <form class="form" id="login-form">
          <div class="field">
            <label for="name">닉네임</label>
            <input id="name" name="name" value="${escapeHtml(lastNickname)}" placeholder="예: MeeNGooK" autocomplete="username" required />
          </div>
          <p class="helper-text">${firebaseEnabled ? "Firebase Firestore 동기화 사용" : "Firebase 설정 전이라 로컬 저장소 사용"}</p>
          <button class="primary-button" type="submit">저장소 열기</button>
        </form>
      </section>
    </main>
  `;
}

function renderSidebar() {
  return `
    <aside class="sidebar">
      <div class="brand">
        <h1>ONLE</h1>
        <p>${escapeHtml(state.user.name)}의 오늘</p>
      </div>
      <nav class="nav">
        ${navButton("daily", "1", "일일 플래너", "Daily")}
        ${navButton("projects", "2", "프로젝트", "Projects")}
        ${navButton("calendar", "3", "달력", "Calendar")}
      </nav>
      <div class="sidebar-spacer"></div>
      <button class="settings-button ${state.view === "settings" ? "active" : ""}" data-view="settings">
        <span class="nav-icon">⚙</span><span>설정</span><span class="badge">색상</span>
      </button>
    </aside>
  `;
}

function renderBottomNav() {
  return `
    <nav class="bottom-nav">
      ${bottomButton("daily", "1", "오늘")}
      ${bottomButton("projects", "2", "프로젝트")}
      ${bottomButton("calendar", "3", "달력")}
      ${bottomButton("settings", "⚙", "설정")}
    </nav>
  `;
}

function navButton(view, icon, label, badge) {
  return `
    <button class="${state.view === view ? "active" : ""}" data-view="${view}">
      <span class="nav-icon">${icon}</span><span>${label}</span><span class="badge">${badge}</span>
    </button>
  `;
}

function bottomButton(view, icon, label) {
  return `<button class="${state.view === view ? "active" : ""}" data-view="${view}"><strong>${icon}</strong><span>${label}</span></button>`;
}

function renderTopbar() {
  const todayTasks = dayTasks(todayISO());
  const doneToday = todayTasks.filter((task) => task.done).length;
  const projectTasks = state.tasks.filter((task) => task.projectId);
  const projectDone = projectTasks.filter((task) => task.done).length;
  const titles = {
    daily: "일일 플래너",
    projects: "프로젝트",
    calendar: "달력",
    settings: "설정",
  };
  return `
    <header class="topbar">
      <div>
        <h2>${titles[state.view]}</h2>
        <p>${new Date().toLocaleDateString("ko-KR", { month: "long", day: "numeric", weekday: "long" })}</p>
      </div>
      <div class="stat-row">
        <div class="stat"><strong>${percent(doneToday, todayTasks.length)}%</strong><span>하루 달성률</span></div>
        <div class="stat"><strong>${percent(projectDone, projectTasks.length)}%</strong><span>프로젝트 달성률</span></div>
      </div>
    </header>
  `;
}

function renderDaily() {
  const tasks = dayTasks(state.selectedDate);
  return `
    <div class="grid">
      <section class="panel">
        <div class="panel-header">
          <h3>${state.selectedDate === todayISO() ? "오늘 할 일" : state.selectedDate}</h3>
          <button class="ghost-button" data-action="open-task-modal">할 일 추가</button>
        </div>
        <div class="task-list">
          ${tasks.length ? tasks.map(renderTask).join("") : `<div class="empty">아직 등록된 일이 없습니다.</div>`}
        </div>
      </section>
    </div>
  `;
}

function renderTask(task) {
  const project = state.projects.find((item) => item.id === task.projectId);
  return `
    <article class="task-item">
      <button class="check ${task.done ? "done" : ""}" title="완료" data-action="toggle-task" data-id="${task.id}">✓</button>
      <div>
        <p class="task-title ${task.done ? "done" : ""}">${escapeHtml(task.title)}</p>
        <div class="task-meta">
          ${task.detail ? `<span>${escapeHtml(task.detail)}</span>` : ""}
          ${project ? `<span class="chip">${escapeHtml(project.name)}</span>` : `<span class="chip">개인</span>`}
        </div>
      </div>
      <button class="text-button danger-button" data-action="delete-task" data-id="${task.id}">삭제</button>
    </article>
  `;
}

function renderProjects() {
  const roots = state.projects.filter((project) => !project.parentId);
  return `
    <section class="panel">
      <div class="panel-header">
        <h3>프로젝트 진행률</h3>
        <button class="ghost-button" data-action="open-project-modal">프로젝트 추가</button>
      </div>
      <div class="project-grid">
        ${roots.length ? roots.map(renderProjectCard).join("") : `<div class="empty">프로젝트를 추가해보세요.</div>`}
      </div>
    </section>
  `;
}

function renderProjectCard(project) {
  const children = state.projects.filter((item) => item.parentId === project.id);
  const tasks = projectTaskIds(project.id);
  const rate = projectRate(project.id);
  return `
    <article class="project-card">
      <div class="project-fill" style="height:${rate}%"></div>
      <div class="project-content">
        <div>
          <h4>${escapeHtml(project.name)}</h4>
          <p class="project-small">${tasks.filter((task) => task.done).length}/${tasks.length} tasks · ${children.length} sub</p>
        </div>
        <div>
          <div class="project-percent">${rate}%</div>
          <button class="ghost-button" data-action="open-subproject-modal" data-id="${project.id}">소프로젝트 추가</button>
        </div>
      </div>
    </article>
  `;
}

function renderCalendar() {
  return `
    <section class="panel">
      <div class="panel-header">
        <h3>${new Date(state.selectedDate).toLocaleDateString("ko-KR", { year: "numeric", month: "long" })}</h3>
        <div class="calendar-tools">
          <div class="segmented">
            <button class="${state.calendarMode === "rate" ? "active" : ""}" data-calendar-mode="rate">달성률</button>
            <button class="${state.calendarMode === "count" ? "active" : ""}" data-calendar-mode="count">개수</button>
          </div>
        </div>
      </div>
      <div class="calendar-grid">
        ${["일", "월", "화", "수", "목", "금", "토"].map((day) => `<div class="weekday">${day}</div>`).join("")}
        ${calendarCells().map(renderDay).join("")}
      </div>
    </section>
  `;
}

function calendarCells() {
  const base = new Date(state.selectedDate);
  const first = new Date(base.getFullYear(), base.getMonth(), 1);
  const start = new Date(first);
  start.setDate(first.getDate() - first.getDay());
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start);
    date.setDate(start.getDate() + index);
    return date;
  });
}

function renderDay(date) {
  const iso = todayISO(date);
  const tasks = dayTasks(iso);
  const value = state.calendarMode === "rate" ? dayRate(iso) : Math.min(tasks.length * 20, 100);
  const base = new Date(state.selectedDate);
  const outside = date.getMonth() !== base.getMonth();
  return `
    <button class="day ${outside ? "outside" : ""} ${iso === state.selectedDate ? "selected" : ""}"
      style="background:${heatColor(value)}"
      data-action="select-day"
      data-date="${iso}">
      <span>${date.getDate()}</span>
      <small>${state.calendarMode === "rate" ? `${dayRate(iso)}%` : `${tasks.length}개`}</small>
    </button>
  `;
}

function renderSettings() {
  return `
    <section class="panel">
      <div class="panel-header"><h3>달력 색상</h3></div>
      <form class="form modal-body" id="settings-form">
        <div class="field"><label>낮음</label><input name="lowColor" type="color" value="${state.settings.lowColor}" /></div>
        <div class="field"><label>중간</label><input name="midColor" type="color" value="${state.settings.midColor}" /></div>
        <div class="field"><label>높음</label><input name="highColor" type="color" value="${state.settings.highColor}" /></div>
        <div class="sync-card">
          <strong>${escapeHtml(activeNickname)}</strong>
          <span>${escapeHtml(syncStatus)}</span>
        </div>
        <button class="primary-button" type="submit">저장</button>
        <button class="text-button" type="button" data-action="switch-user">다른 닉네임 열기</button>
      </form>
    </section>
  `;
}

function openTaskModal() {
  const projectOptions = state.projects
    .map((project) => `<option value="${project.id}">${escapeHtml(project.name)}</option>`)
    .join("");
  showModal(`
    <form id="task-form">
      <div class="modal-header"><strong>할 일 추가</strong><button class="text-button" type="button" data-action="close-modal">닫기</button></div>
      <div class="modal-body form">
        <div class="field"><label>제목</label><input name="title" placeholder="예: 샐러드 해먹기" required /></div>
        <label class="toggle-row"><input type="checkbox" name="useDetail" /> 세부 내용 사용</label>
        <div class="field hidden" data-field="detail"><label>세부 내용</label><textarea name="detail"></textarea></div>
        <label class="toggle-row"><input type="checkbox" name="useProject" /> 프로젝트에 연결</label>
        <div class="field hidden" data-field="project"><label>프로젝트</label><select name="projectId"><option value="">개인</option>${projectOptions}</select></div>
        <div class="field"><label>날짜</label><input name="date" type="date" value="${state.selectedDate}" /></div>
      </div>
      <div class="modal-actions"><button class="text-button" type="button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">OK</button></div>
    </form>
  `);
}

function openProjectModal(parentId = "") {
  showModal(`
    <form id="project-form" data-parent-id="${parentId}">
      <div class="modal-header"><strong>${parentId ? "소프로젝트 추가" : "프로젝트 추가"}</strong><button class="text-button" type="button" data-action="close-modal">닫기</button></div>
      <div class="modal-body form">
        <div class="field"><label>프로젝트명</label><input name="name" placeholder="예: 시험 준비" required /></div>
      </div>
      <div class="modal-actions"><button class="text-button" type="button" data-action="close-modal">Cancel</button><button class="primary-button" type="submit">OK</button></div>
    </form>
  `);
}

function showModal(content) {
  document.body.insertAdjacentHTML("beforeend", `<div class="modal"><section class="modal-card">${content}</section></div>`);
  bindModal();
}

function closeModal() {
  document.querySelector(".modal")?.remove();
}

function bindWelcome() {
  document.querySelector("#login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const nickname = normalizeNickname(form.get("name"));
    if (!nickname) return;
    state = makeInitialState(nickname);
    await openUser(nickname);
  });
}

function bindApp() {
  document.querySelectorAll("[data-view]").forEach((button) => {
    button.addEventListener("click", () => {
      state.view = button.dataset.view;
      scheduleSave();
      render();
    });
  });

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", () => handleAction(button));
  });

  document.querySelectorAll("[data-calendar-mode]").forEach((button) => {
    button.addEventListener("click", () => {
      state.calendarMode = button.dataset.calendarMode;
      scheduleSave();
      render();
    });
  });

  document.querySelector("#settings-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.settings.lowColor = String(form.get("lowColor"));
    state.settings.midColor = String(form.get("midColor"));
    state.settings.highColor = String(form.get("highColor"));
    scheduleSave();
    render();
  });
}

function bindModal() {
  document
    .querySelectorAll(".modal [data-action='close-modal']")
    .forEach((button) => button.addEventListener("click", closeModal));
  document.querySelector(".modal").addEventListener("click", (event) => {
    if (event.target.classList.contains("modal")) closeModal();
  });

  document.querySelector("input[name='useDetail']")?.addEventListener("change", (event) => {
    document.querySelector("[data-field='detail']").classList.toggle("hidden", !event.target.checked);
  });
  document.querySelector("input[name='useProject']")?.addEventListener("change", (event) => {
    document.querySelector("[data-field='project']").classList.toggle("hidden", !event.target.checked);
  });

  document.querySelector("#task-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.tasks.push({
      id: uid(),
      title: String(form.get("title")).trim(),
      detail: form.get("useDetail") ? String(form.get("detail")).trim() : "",
      projectId: form.get("useProject") ? String(form.get("projectId")) : "",
      date: String(form.get("date") || todayISO()),
      done: false,
      createdAt: todayISO(),
    });
    closeModal();
    scheduleSave();
    render();
  });

  document.querySelector("#project-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    state.projects.push({
      id: uid(),
      name: String(form.get("name")).trim(),
      parentId: event.currentTarget.dataset.parentId,
      createdAt: todayISO(),
    });
    closeModal();
    scheduleSave();
    render();
  });
}

function handleAction(button) {
  const { action, id, date } = button.dataset;
  if (action === "open-task-modal") openTaskModal();
  if (action === "open-project-modal") openProjectModal();
  if (action === "open-subproject-modal") openProjectModal(id);
  if (action === "switch-user") {
    if (unsubscribeRemote) unsubscribeRemote();
    state = structuredClone(defaultState);
    render();
  }
  if (action === "toggle-task") {
    const task = state.tasks.find((item) => item.id === id);
    if (task) task.done = !task.done;
    scheduleSave();
    render();
  }
  if (action === "delete-task") {
    state.tasks = state.tasks.filter((task) => task.id !== id);
    scheduleSave();
    render();
  }
  if (action === "select-day") {
    if (state.selectedDate === date) state.view = "daily";
    state.selectedDate = date;
    scheduleSave();
    render();
  }
}

function heatColor(value) {
  const low = hexToRgb(state.settings.lowColor);
  const mid = hexToRgb(state.settings.midColor);
  const high = hexToRgb(state.settings.highColor);
  const ratio = Math.max(0, Math.min(100, value)) / 100;
  const from = ratio < 0.5 ? low : mid;
  const to = ratio < 0.5 ? mid : high;
  const local = ratio < 0.5 ? ratio * 2 : (ratio - 0.5) * 2;
  return `rgb(${mix(from.r, to.r, local)}, ${mix(from.g, to.g, local)}, ${mix(from.b, to.b, local)})`;
}

function mix(a, b, ratio) {
  return Math.round(a + (b - a) * ratio);
}

function hexToRgb(hex) {
  const clean = hex.replace("#", "");
  return {
    r: parseInt(clean.slice(0, 2), 16),
    g: parseInt(clean.slice(2, 4), 16),
    b: parseInt(clean.slice(4, 6), 16),
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

const lastNickname = localStorage.getItem(LAST_NICKNAME_KEY);
if (lastNickname) {
  state = makeInitialState(lastNickname);
  openUser(lastNickname);
} else {
  render();
}
