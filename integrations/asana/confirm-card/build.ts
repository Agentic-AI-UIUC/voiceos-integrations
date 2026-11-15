/**
 * Builds the confirmation cards (create_task, update_task, create_project,
 * create_goal, delete_project, add_comment, complete_task) and writes them into voiceos.integration.json
 * (tools[name].confirmation.root):
 *
 *   card.css   how they look
 *   card.js    the task editors' behaviour (date/time pickers, list fields)
 *   build.ts   the markup (this file), plus a tiny script for the simple cards;
 *              widgetKit wraps markup, CSS and script into one page
 *
 * delete_project, add_comment and complete_task are declarative "card" confirmations instead
 * (see `declarative` below): VoiceOS gives widget confirmations only a floating
 * Confirm and no Cancel (issue #34), while a card's footer has a real Cancel.
 *
 * Run `bun confirm-card/build.ts` after editing any of them. VoiceOS caches the
 * manifest at install time, so the integration must be refreshed afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { renderCustom, markHtml } from "../widgetKit.ts";

const dir = import.meta.dir;
const read = (file: string) => readFileSync(`${dir}/${file}`, "utf8");
const manifestPath = `${dir}/../voiceos.integration.json`;

// Inline icons (the card can't load images over the network).
const chevron = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3.75L5 6.25l2.5-2.5"/></svg>`;
const calIcon = `<svg class="as-ic" width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.75" y="2.75" width="10.5" height="9.5" rx="2"/><path d="M1.75 5.75h10.5M4.75 1.25v2.5M9.25 1.25v2.5"/></svg>`;

// data-voiceos-key binds an element to a tool argument (see card.js).
// Popovers sit right after their row; card.js positions them absolutely.

const header = (chip: string, placeholder = "Task name") => `<div class="as-head">${markHtml()}<span class="as-chip">${chip}</span></div>
<input class="as-title" data-voiceos-key="name" placeholder="${placeholder}" spellcheck="false" autocomplete="off" />`;

/** The description, a quiet two-line field under the title (bound to `notes`). */
const notesField = `<textarea class="as-notes" data-voiceos-key="notes" rows="2" placeholder="Add a description" spellcheck="false"></textarea>`;

/** Due date + time on one row (70/30), with the calendar and time-list popovers. */
const dueRow = dueRowFor(true);

/** The due row; projects and goals have a date only (no time button, no time list). */
function dueRowFor(withTime: boolean): string {
  const timeButton = withTime ? `<button type="button" class="as-val as-time" data-menu="due_time" data-none="No time" aria-expanded="false" aria-label="Due time" hidden><span></span>${chevron}</button>` : "";
  return `
<input type="hidden" id="as-due_on" data-voiceos-key="due_on" />
${withTime ? `<input type="hidden" id="as-due_time" data-voiceos-key="due_time" />` : ""}
<div class="as-row"><span class="as-lbl">Due</span><button type="button" class="as-val" data-menu="cal" id="as-due-btn" aria-expanded="false" aria-haspopup="dialog">${calIcon}<span></span>${chevron}</button>${timeButton}</div>
<div class="as-pop" id="as-pop-cal" role="dialog" aria-label="Due date" hidden>
<div class="as-quick"><button type="button" class="as-c" data-q="today">Today</button><button type="button" class="as-c" data-q="tomorrow">Tomorrow</button><button type="button" class="as-c" data-q="mon">Next Mon</button><button type="button" class="as-clear" id="as-clear">Clear</button></div>
<div class="as-calh"><button type="button" id="as-prev" aria-label="Previous month">&lsaquo;</button><span id="as-month"></span><button type="button" id="as-next" aria-label="Next month">&rsaquo;</button></div><div class="as-grid" id="as-grid"></div>
</div>
${withTime ? `<div class="as-pop" id="as-pop-due_time" hidden><div class="as-list" role="listbox" aria-label="Due time"></div></div>` : ""}`;
}

/**
 * A list-backed field: a hidden input bound to the tool argument `key`, the
 * row's button, and its popover list. card.js fills the list from the
 * `<key>_choices` argument; `none` labels the empty choice.
 */
const menuRow = (key: string, label: string, none: string) => `
<input type="hidden" id="as-${key}" data-voiceos-key="${key}" />
<div class="as-row"><span class="as-lbl">${label}</span><button type="button" class="as-val" data-menu="${key}" data-none="${none}" aria-expanded="false"><span></span>${chevron}</button></div>
<div class="as-pop" id="as-pop-${key}" hidden><div class="as-list" role="listbox" aria-label="${label}"></div></div>`;

const page = (rows: string) => `<div class="as">\n${rows}\n</div>`;

const cards: Record<string, { markup: string; height: number; script?: string }> = {
  create_task: {
    markup: page(`${header("New task")}
${notesField}
${dueRow}
${menuRow("project", "Project", "No project")}
${menuRow("section", "Section", "Default section")}`),
    height: 280,
  },
  update_task: {
    markup: page(`${header("Update task")}
${notesField}
${dueRow}
${menuRow("assignee", "Assignee", "Unassigned")}
${menuRow("project", "Project", "No project")}
${menuRow("section", "Section", "Keep section")}`),
    height: 310,
  },
  create_project: {
    markup: page(`${header("New project", "Project name")}
${notesField}
${dueRowFor(false)}
${menuRow("team", "Team", "No team")}
${menuRow("view", "View", "Default (List)")}`),
    height: 260,
  },
  create_goal: {
    markup: page(`${header("New goal", "Goal name")}
${notesField}
${dueRowFor(false)}
${menuRow("owner", "Owner", "Me")}
${menuRow("time_period", "Period", "No time period")}`),
    height: 260,
  },
};

/** Footer with VoiceOS's own Cancel and Confirm buttons. */
const actions = (confirm: string, color = "accent") => [
  {
    type: "actions",
    items: [
      { label: "Cancel", role: "cancel" },
      { label: confirm, role: "confirm", color },
    ],
  },
];

/** Declarative confirmations; `{{arg}}` shows or binds a tool argument. The server re-checks names and counts. */
const declarative: Record<string, object> = {
  // Irreversible: the card says what goes with the project.
  delete_project: {
    type: "card",
    title: "Delete project",
    children: [
      {
        type: "stack",
        direction: "vertical",
        gap: "md",
        children: [
          { type: "text", text: "{{project_name}}", variant: "title", color: "danger" },
          { type: "divider" },
          {
            type: "stack",
            direction: "vertical",
            gap: "xs",
            children: [
              {
                type: "text",
                text: "⚠️ {{tasks_deleted}} will be deleted with it",
                variant: "subtitle",
                color: "danger",
              },
              { type: "text", text: "Subtasks are deleted with their parent task." },
              { type: "text", text: "Tasks with an assignee or in another project are kept." },
              { type: "text", text: "This can't be undone", color: "danger" },
            ],
          },
        ],
      },
    ],
    footer: actions("Delete project", "danger"),
  },
  add_comment: {
    type: "card",
    title: "Add comment",
    children: [
      {
        type: "stack",
        direction: "vertical",
        gap: "md",
        children: [
          // "On <task>" left-aligned on one line, the task name large, as on the old widget card.
          // Both texts use VoiceOS's default line height ("body" sets 1.55), so aligning their boxes'
          // bottom edges puts them on one baseline; centring them would not.
          {
            type: "stack",
            direction: "horizontal",
            gap: "sm",
            align: "end",
            children: [
              { type: "text", text: "On", variant: "caption" },
              { type: "text", text: "{{task_name}}", variant: "title", maxLines: 1 },
            ],
          },
          {
            type: "textField",
            bind: "{{text}}",
            placeholder: "Write a comment",
            multiline: true,
            required: true,
          },
        ],
      },
    ],
    footer: actions("Add comment"),
  },
  complete_task: {
    type: "card",
    title: "Complete task",
    children: [{ type: "text", text: "{{task_name}}", variant: "title" }],
    footer: actions("Confirm"),
  },
};

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
for (const [name, root] of Object.entries(declarative)) {
  const tool = manifest.tools.find((t: any) => t.name === name);
  if (!tool?.confirmation) throw new Error(`${name} has no confirmation card in the manifest`);
  tool.confirmation = { schemaVersion: 1, root };
  console.log(`${name} confirmation card: declarative card`);
}
for (const [name, { markup, height, script }] of Object.entries(cards)) {
  // The card script must run before widgetKit's bridge script, which renderCustom appends after the body.
  const card = renderCustom({
    accent: "#f06a6a",
    css: read("card.css"),
    body: `${markup}\n<script>${script ?? read("card.js")}</script>`,
    mode: "confirm",
    height,
  });
  const root = manifest.tools.find((t: any) => t.name === name)?.confirmation?.root;
  if (!root) throw new Error(`${name} has no confirmation card in the manifest`);
  root.html = card.html;
  root.height = card.height;
  console.log(`${name} confirmation card: ${card.html.length} chars, height ${card.height}`);
}
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
