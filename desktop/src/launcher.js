// Launcher (app origin, tauri://localhost). No bundler — plain ES module using
// the global-less invoke via window.__TAURI_INTERNALS__ is NOT used; instead we
// import the IPC primitive Tauri injects for module scripts:
// `core.invoke` from the @tauri-apps/api package is unavailable without a
// bundler, so we use the documented raw invoke bridge.
const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);

const RECENT_KEY = "pear-desktop:recent-workspaces";

function recents() {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

function saveRecent(url) {
  const list = [url, ...recents().filter((u) => u !== url)].slice(0, 5);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

function connect(url) {
  saveRecent(url);
  window.location.href = url;
}

// Recent workspaces list
const recentEl = document.getElementById("recent");
for (const url of recents()) {
  const a = document.createElement("a");
  a.textContent = url;
  a.addEventListener("click", () => connect(url));
  recentEl.appendChild(a);
}

// Connect form
const form = document.getElementById("connect-form");
const input = document.getElementById("url");
input.value = recents()[0] ?? "http://localhost:3001";
form.addEventListener("submit", (e) => {
  e.preventDefault();
  connect(input.value.trim());
});

// Local workspace (app-managed server)
const localBtn = document.getElementById("local-start");
const localStatus = document.getElementById("local-status");

async function pollLocalUntilRunning() {
  for (;;) {
    const info = await invoke("local_workspace_status");
    localStatus.textContent = info.message;
    if (info.status === "running" && info.webUrl) return info.webUrl;
    if (info.status === "error") throw new Error(info.message);
    if (info.status === "stopped") throw new Error("local workspace stopped unexpectedly");
    await new Promise((r) => setTimeout(r, 500));
  }
}

localBtn.addEventListener("click", async () => {
  localBtn.disabled = true;
  localStatus.textContent = "starting…";
  try {
    // Kick off the start; poll status for progress (the start invoke itself
    // resolves only when fully up, so race it with the poller for live text).
    const startP = invoke("local_workspace_start");
    const url = await Promise.race([
      startP.then((info) => info.webUrl),
      pollLocalUntilRunning(),
    ]);
    localStatus.textContent = "up — opening…";
    window.location.href = url;
  } catch (err) {
    localStatus.textContent = String(err?.message ?? err);
    localBtn.disabled = false;
  }
});

// If the local stack is already up (e.g. navigated back), reflect it.
invoke("local_workspace_status")
  .then((info) => {
    if (info.status === "running" && info.webUrl) {
      localBtn.textContent = "Open local workspace";
      localStatus.textContent = "already running";
    }
  })
  .catch(() => undefined);

// Engine detection (also proves IPC works on the app origin)
invoke("engines_detect")
  .then((engines) => {
    document.getElementById("engines").textContent = engines
      .map((e) => `${e.displayName}: ${e.installed ? e.version : "not installed"}`)
      .join(" · ");
  })
  .catch((err) => {
    document.getElementById("engines").textContent = `engine detection failed: ${err}`;
  });
