import fs from "node:fs";
import path from "node:path";

const STATE_PATH = process.env.NOTIFY_STATE_PATH || path.join(process.cwd(), "state", "notify-state.json");
const COOLDOWN_MS = Number(process.env.NOTIFY_COOLDOWN_MS ?? 30 * 60 * 1000); // 30m

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf-8"));
  } catch {
    return { lastSentAtByKey: {} };
  }
}

function saveState(st) {
  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, JSON.stringify(st, null, 2));
}

export function shouldSend(key, now = Date.now()) {
  const st = loadState();
  const last = st.lastSentAtByKey[key] ?? 0;
  if (now - last < COOLDOWN_MS) return false;
  st.lastSentAtByKey[key] = now;
  saveState(st);
  return true;
}

export function getState() {
  return loadState();
}

export function setState(mutator) {
  const st = loadState();
  mutator(st);
  saveState(st);
}
