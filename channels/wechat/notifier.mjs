#!/usr/bin/env node
// Agent Hub -> WeChat result notifier.
// Polls channel-api for terminal task events and forwards a formatted message to a local
// delivery endpoint (e.g. a codex2wechat /notify patch) or any webhook. Runs beside the bridge.
//
// Required environment:
//   HUB              Agent Hub project URL (https://<ref>.supabase.co)
//   CHANNEL_SECRET   channel-api shared secret
//   NOTIFY_URL       endpoint that accepts {"text": "..."} POSTs (loopback recommended)
// Optional:
//   NOTIFY_TOKEN     bearer token for NOTIFY_URL
//   CURSOR_FILE      cursor persistence path (default ~/.agent-hub/notifier-cursor)
//   POLL_SECONDS     poll interval (default 5)
//   ADMIN_URL        dashboard URL appended to messages

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const hub = required("HUB");
const secret = required("CHANNEL_SECRET");
const notifyUrl = required("NOTIFY_URL");
const cursorFile = expand(process.env.CURSOR_FILE ?? "~/.agent-hub/notifier-cursor");
const pollSeconds = Math.max(2, Number(process.env.POLL_SECONDS ?? 5) || 5);

function required(name) {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`${name} is required\n`);
    process.exit(1);
  }
  return value;
}

function expand(value) {
  return value.startsWith("~/") ? path.join(homedir(), value.slice(2)) : value;
}

async function readCursor() {
  try {
    return Number(await readFile(cursorFile, "utf8")) || 0;
  } catch {
    return 0;
  }
}

async function writeCursor(cursor) {
  await mkdir(path.dirname(cursorFile), { recursive: true, mode: 0o700 });
  await writeFile(cursorFile, String(cursor), { mode: 0o600 });
}

const statusLabels = {
  "task.done": "✅ 完成",
  "task.failed": "❌ 失败",
  "task.timeout": "⏱ 超时",
  "task.cancelled": "🚫 已取消",
  "task.question": "🙋 需要拍板",
};

async function outputFileLines(taskId) {
  try {
    const response = await fetch(`${hub}/functions/v1/channel-api`, {
      method: "POST",
      headers: { "x-channel-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ action: "files", task_id: taskId, direction: "out" }),
    });
    if (!response.ok) return [];
    const { files } = await response.json();
    return (files ?? []).filter((file) => file.url).slice(0, 5).map((file) => `📎 ${file.name}: ${file.url}`);
  } catch {
    return [];
  }
}

function formatEvent(event) {
  const lines = [
    `${statusLabels[event.kind] ?? event.kind}【${event.agent_name ?? "未分配"}】${event.task_title ?? event.task_id}`,
  ];
  if (event.kind === "task.question") {
    if (event.question) lines.push(`问题:${event.question}`);
    if (event.options) lines.push(`选项:${event.options}`);
    lines.push(`回复「答复 ${String(event.task_id ?? "").slice(0, 8)} 你的决定」继续执行`);
  } else if (event.task_result) {
    lines.push(event.task_result.slice(0, 800));
  }
  if (process.env.ADMIN_URL) lines.push(`详情:${process.env.ADMIN_URL}`);
  return lines.join("\n");
}

async function fetchEvents(sinceId) {
  const response = await fetch(`${hub}/functions/v1/channel-api`, {
    method: "POST",
    headers: { "x-channel-secret": secret, "content-type": "application/json" },
    body: JSON.stringify({ action: "events", since_id: sinceId, limit: 20 }),
  });
  if (!response.ok) throw new Error(`channel-api events failed: ${response.status} ${await response.text()}`);
  return response.json();
}

async function deliver(text, eventId) {
  const headers = { "content-type": "application/json" };
  if (process.env.NOTIFY_TOKEN) headers.authorization = `Bearer ${process.env.NOTIFY_TOKEN}`;
  const response = await fetch(notifyUrl, {
    method: "POST",
    headers,
    body: JSON.stringify({ text, source_id: `hub-event-${eventId}` }),
  });
  if (!response.ok) throw new Error(`notify delivery failed: ${response.status} ${await response.text()}`);
}

let cursor = await readCursor();
process.stdout.write(`notifier started, cursor=${cursor}, poll=${pollSeconds}s\n`);

for (;;) {
  try {
    const { events, cursor: next } = await fetchEvents(cursor);
    for (const event of events ?? []) {
      // WeChat-sourced tasks always notify; other sources notify too so the phone stays informed.
      let text = formatEvent(event);
      if (event.kind === "task.done" && event.task_id) {
        const links = await outputFileLines(event.task_id);
        if (links.length) text = `${text}\n${links.join("\n")}`;
      }
      await deliver(text, event.id);
      cursor = event.id;
      await writeCursor(cursor);
    }
    if (typeof next === "number" && next > cursor && !(events ?? []).length) {
      cursor = next;
      await writeCursor(cursor);
    }
  } catch (error) {
    process.stderr.write(`notifier error: ${error instanceof Error ? error.message : String(error)}\n`);
  }
  await new Promise((resolve) => setTimeout(resolve, pollSeconds * 1000));
}
