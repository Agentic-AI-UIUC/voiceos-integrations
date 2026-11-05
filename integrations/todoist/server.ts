import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Composio } from "@composio/core";
import { z } from "zod";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";

// Composio owns OAuth, token storage/refresh, and Todoist requests.
// This adapter only saves this installation's identity and connection reference.
const server = new McpServer({ name: "composio-todoist", version: "1.0.10" });
// BEGIN TOOL CATALOG
const catalog: any = {
  "version": "20260731_00",
  "tools": [
    {
      "name": "create_task",
      "title": "Create task",
      "slug": "TODOIST_CREATE_TASK",
      "description": "Create a Todoist task. Use when asked to add a task, reminder, or recurring task. Put scheduling in due_string or exactly one precise due field. Resolve project and section IDs using lookups; never guess IDs.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "CreateTaskRequest",
        "required": [
          "content"
        ],
        "properties": {
          "order": {
            "type": "integer",
            "title": "Order",
            "examples": [
              1,
              2,
              3
            ],
            "description": "Non-zero integer value used to sort tasks under the same parent."
          },
          "labels": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "title": "Labels",
            "examples": [
              [
                "Food",
                "Shopping"
              ]
            ],
            "description": "The task's labels (list of names for personal/shared labels). Labels must already exist in Todoist; referencing non-existent labels may fail silently."
          },
          "content": {
            "type": "string",
            "title": "Content",
            "examples": [
              "Buy milk",
              "Call John about the project"
            ],
            "description": "Task content/title. Can contain markdown-formatted text and hyperlinks. Do NOT include due dates or times in this field - use due_string instead."
          },
          "due_date": {
            "type": "string",
            "title": "Due Date",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "examples": [
              "2023-12-25"
            ],
            "description": "Specific date in YYYY-MM-DD format relative to user's timezone. Use this for exact dates without time. For natural language dates, use due_string instead. Only one due_* field can be used at a time (except due_lang). Cannot express recurrence; one-off tasks only. Use due_string (e.g., 'every Friday') for recurring schedules."
          },
          "due_lang": {
            "type": "string",
            "title": "Due Lang",
            "pattern": "^[a-z]{2}$",
            "examples": [
              "en",
              "pt",
              "es",
              "fr",
              "de"
            ],
            "description": "2-letter ISO 639-1 language code for parsing due_string. Required when due_string is in a language other than English. Supported codes: da (Danish), de (German), en (English), es (Spanish), fi (Finnish), fr (French), it (Italian), ja (Japanese), ko (Korean), nb (Norwegian), nl (Dutch), pl (Polish), pt (Portuguese), ru (Russian), sv (Swedish), tw (Traditional Chinese), zh (Chinese)."
          },
          "duration": {
            "type": "integer",
            "title": "Duration",
            "examples": [
              15,
              30,
              60
            ],
            "description": "Task duration amount as a positive integer. Must be used together with duration_unit. Use this field for task duration instead of embedding 'for X minutes' in due_string. Example: for a 15-minute task, set duration=15 and duration_unit='minute'.",
            "exclusiveMinimum": 0,
            "minimum": 1
          },
          "priority": {
            "type": "integer",
            "title": "Priority",
            "maximum": 4,
            "minimum": 1,
            "examples": [
              1,
              2,
              3,
              4
            ],
            "description": "Task priority from 1 (normal) to 4 (urgent)."
          },
          "parent_id": {
            "type": "string",
            "title": "Parent Id",
            "examples": [
              "2995104339"
            ],
            "description": "Parent task ID for creating subtasks. Use IDs from TODOIST_GET_ALL_TASKS or TODOIST_GET_ACTIVE_TASK."
          },
          "due_string": {
            "type": "string",
            "title": "Due String",
            "examples": [
              "tomorrow at 12:00",
              "next Monday at 15:00",
              "in 2 hours",
              "every Friday at 9am",
              "Jan 21, 2026"
            ],
            "description": "Human-defined due date in arbitrary format. Accepts natural language expressions like 'tomorrow', 'next Monday at 3pm', 'in 2 hours', 'every Friday'. Also accepts formatted dates like 'Jan 21, 2026' or ISO dates like '2026-01-21'. Value is interpreted using local time. IMPORTANT: If the due string is in a language other than English (e.g., 'esta semana' in Portuguese, 'ma\u00f1ana' in Spanish, 'demain' in French), you MUST also set the due_lang field with the appropriate 2-letter language code (e.g., 'pt' for Portuguese, 'es' for Spanish, 'fr' for French, 'de' for German), otherwise the API will reject it with 'Invalid date format'. Do NOT include duration phrases like 'for X minutes' or 'for X days' in this field - use the separate duration and duration_unit fields instead. If duration is included, it will be automatically extracted and applied to the duration fields. Only one due_* field can be used at a time (except due_lang)."
          },
          "project_id": {
            "type": "string",
            "title": "Project Id",
            "examples": [
              "2203306141"
            ],
            "description": "Project ID where the task will be created. Use IDs from TODOIST_GET_ALL_PROJECTS or TODOIST_CREATE_PROJECT. If not set, task is added to the user's Inbox. Project names are not unique; always use numeric IDs."
          },
          "section_id": {
            "type": "string",
            "title": "Section Id",
            "examples": [
              "2203306141"
            ],
            "description": "Section ID to put task into. Use IDs from TODOIST_GET_ALL_SECTIONS."
          },
          "assignee_id": {
            "type": "string",
            "title": "Assignee Id",
            "examples": [
              "53792166"
            ],
            "description": "The responsible user ID for shared tasks (numeric format)."
          },
          "description": {
            "type": "string",
            "title": "Description",
            "examples": [
              "Need to get 2 gallons of milk from the store",
              "Remember to bring the report"
            ],
            "description": "Additional notes or details about the task. Can contain markdown-formatted text and hyperlinks. IMPORTANT: Do NOT include due dates, times, or scheduling information here - use the due_string field for natural language dates (e.g., 'tomorrow at 2pm') or due_date/due_datetime for specific dates."
          },
          "due_datetime": {
            "type": "string",
            "title": "Due Datetime",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
            "examples": [
              "2023-12-25T12:00:00Z"
            ],
            "description": "Specific date and time in RFC3339 format in UTC. Use this for exact date and time. Only one due_* field can be used at a time (except due_lang). Cannot express recurrence; one-off tasks only. Use due_string for recurring schedules."
          },
          "duration_unit": {
            "enum": [
              "minute",
              "day"
            ],
            "type": "string",
            "title": "DurationUnit",
            "examples": [
              "minute",
              "day"
            ],
            "description": "Units for task duration in Todoist."
          }
        },
        "description": "Request model for creating a task."
      }
    },
    {
      "name": "update_task",
      "title": "Update task",
      "slug": "TODOIST_UPDATE_TASK",
      "description": "Update an existing Todoist task. Use when asked to rename, reschedule, reprioritize, assign, or change task labels or notes. Find the exact task with get_active_tasks first. Send only requested changes; labels replaces the entire label list.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "UpdateTaskRequest",
        "required": [
          "task_id"
        ],
        "properties": {
          "labels": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "title": "Labels",
            "examples": [
              [
                "Food",
                "Shopping"
              ]
            ],
            "description": "List of label names to assign to the task. Replaces the entire existing labels list \u2014 omit a label only if intentionally removing it. Labels must already exist in Todoist; non-existent names fail silently."
          },
          "content": {
            "type": "string",
            "title": "Content",
            "examples": [
              "Buy groceries and snacks"
            ],
            "description": "New content for the task."
          },
          "task_id": {
            "type": "string",
            "title": "Task Id",
            "examples": [
              "2995104339"
            ],
            "description": "The ID of the task to update."
          },
          "due_date": {
            "type": "string",
            "title": "Due Date",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "examples": [
              "2023-12-31"
            ],
            "description": "Due date in YYYY-MM-DD format."
          },
          "due_lang": {
            "type": "string",
            "title": "Due Lang",
            "pattern": "^[a-z]{2}$",
            "examples": [
              "en",
              "fr",
              "de"
            ],
            "description": "Language code for parsing `due_string`, e.g., 'en'."
          },
          "duration": {
            "type": "integer",
            "title": "Duration",
            "examples": [
              15,
              30,
              60
            ],
            "description": "Positive integer for task duration amount (how long the task takes). Must be used together with duration_unit. This is separate from due date - use due_string/due_date/due_datetime for when the task is due.",
            "exclusiveMinimum": 0,
            "minimum": 1
          },
          "priority": {
            "type": "integer",
            "title": "Priority",
            "maximum": 4,
            "minimum": 1,
            "examples": [
              1,
              2,
              3,
              4
            ],
            "description": "Task priority from 1 (normal) to 4 (urgent)."
          },
          "due_string": {
            "type": "string",
            "title": "Due String",
            "examples": [
              "tomorrow at 17:00",
              "next Monday",
              "Jan 15 at 3pm"
            ],
            "description": "Human-readable due date string for natural language date parsing. Examples: 'tomorrow', 'next Monday', 'Jan 15 at 3pm', 'in 2 days'. Duration syntax like 'for X minutes' is automatically extracted and converted to the duration/duration_unit fields. Provide exactly one of due_string, due_date, or due_datetime per call \u2014 supplying multiple may cause silent failures. To clear an existing due date, pass 'no date'."
          },
          "assignee_id": {
            "type": "string",
            "title": "Assignee Id",
            "examples": [
              "1234567"
            ],
            "description": "User ID to assign the task to."
          },
          "description": {
            "type": "string",
            "title": "Description",
            "examples": [
              "Include fruits and vegetables"
            ],
            "description": "New description for the task."
          },
          "due_datetime": {
            "type": "string",
            "title": "Due Datetime",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
            "examples": [
              "2023-12-31T17:00:00Z"
            ],
            "description": "Due date and time in RFC3339 format."
          },
          "deadline_date": {
            "type": "string",
            "title": "Deadline Date",
            "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
            "examples": [
              "2026-03-15"
            ],
            "description": "Deadline date in YYYY-MM-DD format (premium feature)."
          },
          "duration_unit": {
            "enum": [
              "minute",
              "day"
            ],
            "type": "string",
            "title": "DurationUnit",
            "examples": [
              "minute",
              "day"
            ],
            "description": "Units for task duration in Todoist."
          },
          "target_name": {
            "type": "string",
            "title": "Selected target",
            "description": "Human-readable name/title from the lookup, for confirmation display only. Never invent a name or substitute it for the required ID."
          }
        },
        "description": "Request model for updating an existing task in Todoist."
      }
    },
    {
      "name": "close_task",
      "title": "Complete task",
      "slug": "TODOIST_CLOSE_TASK_V1",
      "description": "Complete a Todoist task. Use when asked to finish or check off a task. Find its ID with get_active_tasks. Recurring tasks advance to their next occurrence instead of permanently completing.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "CloseTaskV1Request",
        "required": [
          "task_id"
        ],
        "properties": {
          "task_id": {
            "type": "string",
            "title": "Task Id",
            "examples": [
              "6Xvwww8jQhrQjFPW",
              "2995104339"
            ],
            "description": "String ID of the task to close. Regular tasks are marked complete and moved to history along with their subtasks. Tasks with recurring due dates are scheduled to their next occurrence."
          },
          "target_name": {
            "type": "string",
            "title": "Selected target",
            "description": "Human-readable name/title from the lookup, for confirmation display only. Never invent a name or substitute it for the required ID."
          }
        },
        "description": "Request model for closing a task."
      }
    },
    {
      "name": "get_active_tasks",
      "title": "Get active tasks",
      "slug": "TODOIST_GET_ALL_TASKS",
      "description": "Read incomplete Todoist tasks. Use for a task list, tasks due today, overdue tasks, or finding IDs before updating or completing a task. Use valid Todoist filter syntax and follow next_cursor for more results. Does not retrieve completed tasks.",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "title": "GetAllTasksRequest",
        "properties": {
          "ids": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "title": "Ids",
            "examples": [
              [
                "6Xvwww9XFpHQc2qW",
                "6Xvwww8jQhrQjFPW"
              ]
            ],
            "description": "List of task IDs to retrieve (alphanumeric string IDs)."
          },
          "lang": {
            "type": "string",
            "title": "Lang",
            "examples": [
              "en",
              "es"
            ],
            "description": "Language code for parsing date/times in queries."
          },
          "limit": {
            "type": "integer",
            "title": "Limit",
            "minimum": 1,
            "examples": [
              50,
              100
            ],
            "description": "The number of tasks to return per page. Default is 50."
          },
          "cursor": {
            "type": "string",
            "title": "Cursor",
            "description": "Cursor for pagination. Provide the next_cursor value from previous response to get next page."
          },
          "filter": {
            "type": "string",
            "title": "Filter",
            "examples": [
              "today | overdue",
              "7 days",
              "-7 days",
              "created after: -14 days",
              "p1 & !#Work",
              "#Personal",
              "search: meeting",
              "search: yoga | search: gym",
              "due after: 2024-01-01",
              "no due date"
            ],
            "description": "Filter tasks using Todoist filter syntax. This endpoint only returns INCOMPLETE tasks. Terms must be valid keywords or reference existing entities; arbitrary text causes 400 errors. Supported filters: predefined keywords ('today', 'overdue', 'no due date', etc.), priority ('p1'-'p4'), projects ('#Name'), labels ('@Name'), relative dates ('7 days', '-7 days'), date filters ('due before: YYYY-MM-DD'), created/deadline ('created after: -14 days'), search ('search: keyword'). Operators: '&' (AND), '|' (OR), '!' (NOT). DO NOT USE: 'completed', '!completed', 'completed after' - these cause 400 errors on this endpoint (use TODOIST_GET_COMPLETED_TASKS_BY_COMPLETION_DATE instead)."
          }
        }
      }
    },
    {
      "name": "create_project",
      "title": "Create project",
      "slug": "TODOIST_CREATE_PROJECT2",
      "description": "Create a Todoist project. Use when asked to make a new project or subproject. Find a parent project ID with list_projects; clarify duplicate names.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "TodoistCreateProject2Request",
        "required": [
          "name"
        ],
        "properties": {
          "name": {
            "type": "string",
            "title": "Name",
            "examples": [
              "Work Tasks",
              "Personal Goals"
            ],
            "description": "The project name. This is the only required field."
          },
          "color": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "integer"
              }
            ],
            "title": "Color",
            "examples": [
              "blue",
              "berry_red",
              41
            ],
            "description": "Project color. Can be either a color name (e.g., 'berry_red', 'blue') or a numeric color code. Default is 'charcoal'."
          },
          "parent_id": {
            "anyOf": [
              {
                "type": "string"
              },
              {
                "type": "integer"
              }
            ],
            "title": "Parent Id",
            "examples": [
              "2203306141",
              2203306141
            ],
            "description": "Parent project ID. If provided, creates this project as a sub-project. Can be either a string or integer ID."
          },
          "view_style": {
            "type": "string",
            "title": "View Style",
            "examples": [
              "list",
              "board"
            ],
            "description": "View style of the project. Can be 'list' or 'board'.",
            "enum": [
              "list",
              "board"
            ]
          },
          "description": {
            "type": "string",
            "title": "Description",
            "examples": [
              "Project for tracking work-related tasks"
            ],
            "description": "Description of the project. Optional field."
          },
          "is_favorite": {
            "type": "boolean",
            "title": "Is Favorite",
            "examples": [
              true,
              false
            ],
            "description": "Whether the project is a favorite for the user. Default is false."
          },
          "workspace_id": {
            "type": "integer",
            "title": "Workspace Id",
            "examples": [
              123456
            ],
            "description": "Workspace ID. If provided, creates a workspace project instead of a personal project."
          }
        }
      }
    },
    {
      "name": "delete_project",
      "title": "Delete project",
      "slug": "TODOIST_DELETE_PROJECT2",
      "description": "Delete a Todoist project and its contents. Use only when explicitly asked to delete a project. First resolve its exact ID and name using list_projects. Clarify ambiguous names before proposing deletion.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "TodoistDeleteProject2Request",
        "required": [
          "project_id"
        ],
        "properties": {
          "project_id": {
            "type": "string",
            "title": "Project Id",
            "examples": [
              "2203306141",
              "6fq4qcJ8x47WJh6g"
            ],
            "description": "The ID of the project to delete. Can be numeric or alphanumeric format."
          },
          "target_name": {
            "type": "string",
            "title": "Selected target",
            "description": "Human-readable name/title from the lookup, for confirmation display only. Never invent a name or substitute it for the required ID."
          }
        },
        "description": "Request model for deleting a project using API v1."
      }
    },
    {
      "name": "create_section",
      "title": "Create section",
      "slug": "TODOIST_CREATE_SECTION_V1",
      "description": "Create a section inside an existing Todoist project. Use when asked to add a section. Resolve the project ID with list_projects before proposing the action.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "CreateSectionV1Request",
        "required": [
          "name",
          "project_id"
        ],
        "properties": {
          "name": {
            "type": "string",
            "title": "Name",
            "examples": [
              "Backlog",
              "In Progress",
              "Done"
            ],
            "description": "Name of the new section. This will be the section heading in the project."
          },
          "order": {
            "type": "integer",
            "title": "Order",
            "examples": [
              1,
              2,
              5
            ],
            "description": "Position of the new section in the project. Lower values appear first. If not specified, the section will be added to the end."
          },
          "project_id": {
            "type": "string",
            "title": "Project Id",
            "examples": [
              "6XvwwRvRfmCjM5PW",
              "6fm7p873Gr4m66Gw"
            ],
            "description": "ID of the project to add the section to. Must be a new-format alphanumeric string ID. Legacy numeric project IDs are not supported by the v1 API."
          }
        },
        "description": "Request model for creating a new section using API v1."
      }
    },
    {
      "name": "delete_section",
      "title": "Delete section",
      "slug": "TODOIST_DELETE_SECTION2",
      "description": "Delete a Todoist section and its tasks. Use only when explicitly asked to delete a section. Resolve its exact ID using list_sections within the selected project; clarify ambiguity.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "DeleteSection2Request",
        "required": [
          "section_id"
        ],
        "properties": {
          "section_id": {
            "type": "string",
            "title": "Section Id",
            "examples": [
              "6fvWm9G4XJvWRcfF",
              "82181370"
            ],
            "description": "ID of the section to delete. This will delete the section and all tasks within it."
          },
          "target_name": {
            "type": "string",
            "title": "Selected target",
            "description": "Human-readable name/title from the lookup, for confirmation display only. Never invent a name or substitute it for the required ID."
          }
        },
        "description": "Request model for deleting a section."
      }
    },
    {
      "name": "get_productivity_stats",
      "title": "Get productivity stats",
      "slug": "TODOIST_GET_PRODUCTIVITY_STATS",
      "description": "Read Todoist productivity statistics. Use for karma, completion totals, daily or weekly completion history, and productivity questions. Report only values returned by Todoist.",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "title": "GetProductivityStatsRequest",
        "properties": {},
        "description": "Request model for retrieving productivity statistics. No parameters required."
      }
    },
    {
      "name": "list_projects",
      "title": "List Todoist projects",
      "slug": "TODOIST_GET_ALL_PROJECTS",
      "description": "Read Todoist projects. Use when asked to show projects or to resolve project names into IDs before an approved action. Names may repeat: clarify ambiguous matches. Follow next_cursor for more results.",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "title": "GetAllProjectsRequest",
        "properties": {
          "limit": {
            "type": "integer",
            "title": "Limit",
            "minimum": 1,
            "description": "The number of projects to return per page. Defaults to server default if not provided."
          },
          "cursor": {
            "type": "string",
            "title": "Cursor",
            "description": "Pagination cursor from a previous response. Use the next_cursor value to fetch the next page of results."
          }
        }
      }
    },
    {
      "name": "list_sections",
      "title": "List Todoist sections",
      "slug": "TODOIST_LIST_SECTIONS",
      "description": "Read Todoist sections, optionally restricted to a project ID. Use when asked for sections or to find the exact section ID before an approved action. Follow next_cursor for more results.",
      "readOnly": true,
      "inputSchema": {
        "type": "object",
        "title": "ListSectionsRequest",
        "properties": {
          "limit": {
            "type": "integer",
            "title": "Limit",
            "minimum": 1,
            "examples": [
              50,
              100
            ],
            "description": "The number of objects to return in a page. Default is 50."
          },
          "cursor": {
            "type": "string",
            "title": "Cursor",
            "examples": [
              "eyJwYWdlIjogMn0"
            ],
            "description": "Pagination cursor for fetching the next page of results. Use the next_cursor value from a previous response."
          },
          "project_id": {
            "type": "string",
            "title": "Project Id",
            "examples": [
              "2203306141"
            ],
            "description": "String ID of the project to get sections from. If omitted or null, get sections from all projects."
          }
        },
        "description": "Request model for listing sections with pagination support."
      }
    },
    {
      "name": "list_labels",
      "title": "List labels",
      "readOnly": true,
      "slug": "TODOIST_LIST_LABELS",
      "description": "Read personal Todoist labels and resolve label names into IDs. Use when asked to list labels or find an exact label before an update or deletion. Clarify duplicate names and follow next_cursor for more results. Use create_label, update_label, or delete_label for changes.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "limit": {
            "type": "integer",
            "title": "Limit",
            "default": 50,
            "minimum": 1,
            "examples": [
              50,
              100
            ],
            "description": "The number of objects to return in a page. Default is 50."
          },
          "cursor": {
            "type": "string",
            "title": "Cursor",
            "examples": [
              "eyJpZCI6ICI3MTg0MzI5OCIsICJvcmRlciI6IDB9"
            ],
            "description": "Cursor for pagination. Use the next_cursor value from the previous response to get the next page of results."
          }
        }
      }
    },
    {
      "name": "create_label",
      "title": "Create label",
      "readOnly": false,
      "slug": "TODOIST_CREATE_LABEL_V1",
      "description": "Create a personal Todoist label. Use when asked to add a new label. Review its name and requested settings before confirming.",
      "inputSchema": {
        "type": "object",
        "required": ["name"],
        "properties": {
          "name": { "type": "string", "minLength": 1, "maxLength": 128, "description": "Name of the new label." },
          "color": { "anyOf": [{ "type": "string" }, { "type": "integer" }], "description": "Color name or numeric color code. Defaults to charcoal if omitted." },
          "order": { "type": "integer", "description": "Position in the label list." },
          "is_favorite": { "type": "boolean", "description": "Whether to mark the label as a favorite. Defaults to false if omitted." }
        }
      }
    },
    {
      "name": "update_label",
      "title": "Update label",
      "readOnly": false,
      "slug": "TODOIST_UPDATE_LABEL_V1_SECOND",
      "description": "Update a personal Todoist label. Use when asked to rename a label or change its color, order, or favorite status. Resolve the exact ID with list_labels first, clarify ambiguous names, and send only requested changes.",
      "inputSchema": {
        "type": "object",
        "required": ["label_id"],
        "properties": {
          "label_id": { "type": "string", "description": "ID of the label to update." },
          "target_name": { "type": "string", "description": "Existing label name from list_labels, for confirmation display only. Never substitute it for label_id." },
          "name": { "type": "string", "minLength": 1, "maxLength": 128, "description": "New label name. Omit to leave unchanged." },
          "color": { "anyOf": [{ "type": "string" }, { "type": "integer" }], "description": "New color name or numeric color code. Omit to leave unchanged." },
          "order": { "type": "integer", "description": "New position in the label list. Omit to leave unchanged." },
          "is_favorite": { "type": "boolean", "description": "New favorite status. Omit to leave unchanged." }
        }
      }
    },
    {
      "name": "delete_label",
      "title": "Delete label",
      "slug": "TODOIST_DELETE_LABEL_V1",
      "description": "Delete a personal Todoist label and remove it from every task that uses it. Use only when explicitly asked to delete a label. Resolve its exact ID and name with list_labels, clarify ambiguous names, and require confirmation. Tasks themselves are not deleted.",
      "readOnly": false,
      "inputSchema": {
        "type": "object",
        "title": "DeleteLabelV1Request",
        "required": [
          "label_id"
        ],
        "properties": {
          "label_id": {
            "type": "string",
            "title": "Label Id",
            "examples": [
              "2182932094"
            ],
            "description": "The ID of the personal label to delete. All instances of the label will be removed from tasks."
          },
          "target_name": {
            "type": "string",
            "title": "Selected label",
            "description": "Human-readable label name from list_labels, for confirmation display only. Never substitute it for label_id."
          }
        },
        "description": "Request model for deleting a personal label."
      }
    }
  ]
};
// END TOOL CATALOG
const stateFile = new URL("./.composio-auth.json", import.meta.url);
type State = { userId: string; accountId?: string; pending?: { id: string; url: string }; needsReauthorization?: boolean };
let client: Composio | undefined;
let connecting: Promise<any> | undefined;
let disconnecting: Promise<any> | undefined;

function api() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("Add your Composio API key in Todoist settings first.");
  return client ??= new Composio({ apiKey, baseURL: "https://backend.composio.dev", allowTracking: false });
}

async function save(state: State) {
  const temporary = new URL(`./.composio-auth.${randomUUID()}.tmp`, import.meta.url);
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function load(): Promise<State> {
  try {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    if (typeof state.userId !== "string" || !state.userId.startsWith("voiceos-")) {
      throw new Error("Invalid local Todoist identity. Reset the local connection state before connecting.");
    }
    return state;
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    const state = { userId: `voiceos-${randomUUID()}` };
    await save(state);
    return state;
  }
}

function result(data: object, title: string, message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({
    ...data,
    _voiceos_glance: { blocks: [
      { type: "header", title: "Todoist", trailing: title },
      { type: "keyValue", pairs: [["Status", message]] },
    ] },
  }) }] };
}

class TodoistError extends Error {
  constructor(public code: string, message: string, public reconnectRequired = false) { super(message); }
}

function isTimeout(error: unknown): boolean {
  // Composio wraps transport failures; preserve timeout guidance through causes.
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error) && seen.size < 8) {
    seen.add(error);
    const current = error as { name?: string; message?: string; cause?: unknown };
    if (current.name === "AbortError" || current.name === "TimeoutError"
      || /timed?\s*out|aborted/i.test(current.message ?? "")) return true;
    error = current.cause;
  }
  return false;
}

function failure(error: unknown) {
  let message = error instanceof Error ? error.message : "Composio request failed.";
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (key) message = message.split(key).join("[redacted]");
  message = message.replace(/https?:\/\/[^\s"<>]+/g, "[link redacted]").slice(0, 500);
  const code = error instanceof TodoistError ? error.code : "REQUEST_FAILED";
  const reconnectRequired = error instanceof TodoistError && error.reconnectRequired;
  return { ...result({ error: message, code, reconnectRequired }, "Error", message), isError: true };
}

async function progress(extra: any, message: string, done = false) {
  const token = extra?._meta?.progressToken;
  if (token === undefined) return; // VoiceOS still displays its normal tool loading state.
  try {
    await extra.sendNotification({ method: "notifications/progress", params: {
      progressToken: token, progress: done ? 100 : 0, total: 100, message,
    } });
  } catch { /* A progress display failure must never change an operation's outcome. */ }
}

async function notifyWrite(message: string) {
  try {
    await server.server.request({
      method: "voiceos/reminders/trigger", params: { message: message.slice(0, 1900), speak: false },
    } as any, z.object({ notificationId: z.string() }), { timeout: 4000 });
    return true;
  } catch {
    console.error("VoiceOS could not queue the Todoist result notification; the tool result is still available.");
    return false;
  }
}

async function withFeedback(title: string, write: boolean, extra: any, run: () => Promise<any>) {
  await progress(extra, `${title}…`);
  let output: any;
  try { output = await run(); } catch (error) { output = failure(error); }
  await progress(extra, `${title}: ${output.isError ? "failed" : "finished"}`, true);
  if (write) {
    const payload = JSON.parse(output.content.find((block: any) => block.type === "text").text);
    payload.notificationQueued = await notifyWrite(output.isError
      ? `Todoist — ${title} ${payload.code === "OUTCOME_UNKNOWN" ? "outcome unconfirmed" : "failed"}: ${payload.error ?? "Request failed."}`
      : `Todoist — ${title} completed.`);
    output.content.find((block: any) => block.type === "text").text = JSON.stringify(payload);
  }
  return output;
}

function accountResult(connected: boolean, status: string, message: string, extraData: object = {}) {
  const data = { connected, status, message, ...extraData };
  const initial = JSON.stringify(data).replace(/</g, "\\u003c");
  // This small result widget is needed for account controls. It never touches
  // credentials: calls go through VoiceOS's uiCallable tool bridge.
  const html = `<!doctype html><html><meta charset="utf-8"><style>
    *{box-sizing:border-box;scrollbar-width:none}::-webkit-scrollbar{display:none}
    :root{--k-radius:26px;--ink:#fff;--muted:#b5b5b5;--line:#ffffff26}
    html[data-theme=light]{--ink:#171717;--muted:#555;--line:#0002}
    body{margin:0;padding:20px;color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;background:transparent}
    h3{margin:0 0 8px;font-size:18px}p{margin:0 0 18px;color:var(--muted)}
    .buttons{display:flex;gap:12px;flex-wrap:wrap}button{min-height:44px;border:1px solid var(--line);border-radius:12px;padding:10px 18px;background:transparent;color:var(--ink);font:inherit;cursor:pointer}
    button.primary{background:#db4035;border-color:#db4035;color:white}button:disabled{opacity:.5;cursor:default}
    [aria-busy=true] #status:before{content:"";display:inline-block;width:10px;height:10px;border:2px solid var(--line);border-top-color:#db4035;border-radius:50%;animation:spin .8s linear infinite;margin-right:7px}
    @keyframes spin{to{transform:rotate(360deg)}}
    </style><body><h3>Todoist account</h3><p id="status" role="status" aria-live="polite"></p>
    <div class="buttons"><button id="account" class="primary" disabled></button><button id="refresh" disabled>Refresh</button></div>
    <script>(()=>{
      let data=${initial},capable=false,pending=null;
      const account=document.getElementById('account'),refresh=document.getElementById('refresh'),status=document.getElementById('status');
      function paint(){status.textContent=data.message;account.textContent=data.connected?'Disconnect':'Connect';account.disabled=refresh.disabled=!capable||!!pending;document.body.setAttribute('aria-busy',String(!!pending));resize()}
      function resize(){if(!document.hidden&&document.documentElement.offsetWidth){const height=Math.ceil(document.documentElement.getBoundingClientRect().height);if(height>=8)parent.postMessage({type:'voiceos:resize',height},'*')}}
      function call(name){if(!capable||pending)return;const bytes=new Uint32Array(4);crypto.getRandomValues(bytes);const id=Array.from(bytes,n=>n.toString(16)).join('_');
        const timer=setTimeout(()=>{if(pending&&pending.id===id){pending=null;data.message='No final response received. Refresh status before trying again.';paint()}},210000);
        pending={id,timer};data.message=name==='connect_account'?'Waiting for browser authorization…':name==='disconnect_account'?'Disconnecting Todoist…':'Checking connection…';paint();
        parent.postMessage({type:'voiceos:invokeTool',name,args:{},requestId:id},'*')}
      addEventListener('message',event=>{if(event.source!==parent||!event.data)return;const m=event.data;
        if(m.type==='voiceos:init'){capable=!!(m.capabilities&&m.capabilities.invokeTool);document.documentElement.dataset.theme=m.theme&&m.theme.mode||'dark';if(typeof m.radius==='number')document.documentElement.style.setProperty('--k-radius',Math.max(0,Math.min(48,m.radius))+'px');if(!capable)data.message+=' Use voice commands to connect or disconnect on this VoiceOS version.';paint()}
        if(m.type==='voiceos:toolResult'&&pending&&m.requestId===pending.id&&['completed','failed','cancelled','unknown'].includes(m.status)){
          clearTimeout(pending.timer);pending=null;let payload;try{const block=m.result&&m.result.content&&m.result.content.find(x=>x.type==='text');if(block)payload=JSON.parse(block.text)}catch{}
          if(payload&&typeof payload.connected==='boolean')data=payload;
          else data.message=payload&&payload.error||m.error||(m.status==='cancelled'?'Cancelled.':m.status==='completed'?'Request finished. Refresh to verify connection status.':'Could not verify the outcome. Refresh status before retrying.');paint()}
      });
      account.onclick=()=>call(data.connected?'disconnect_account':'connect_account');refresh.onclick=()=>call('connection_status');
      if(window.ResizeObserver)new ResizeObserver(resize).observe(document.documentElement);paint();
    })()</script></body></html>`;
  return { content: [{ type: "text" as const, text: JSON.stringify({
    ...data, _voiceos_glance: { blocks: [{ type: "widget", html, height: 210, label: "Todoist account controls", data }] },
  }) }] };
}

async function savedAccount(state: State) {
  const id = state.pending?.id ?? state.accountId;
  if (!id) return undefined;
  let account;
  try { account = await api().connectedAccounts.get(id, { signal: AbortSignal.timeout(8000) }); }
  catch (error: any) {
    if (error.status === 404 || error.cause?.status === 404) return undefined;
    if (error.status === 401 || error.cause?.status === 401) throw new TodoistError("API_KEY_REJECTED", "Composio rejected the saved API key. Update it in Todoist settings; reconnecting Todoist alone will not fix the key.");
    throw error;
  }
  if (account.toolkit.slug !== "todoist") throw new Error("Saved connection is not a Todoist connection.");
  return account;
}

async function activeAccount(state: State) {
  const account = await savedAccount(state);
  return account?.status === "ACTIVE" && !account.isDisabled ? account : undefined;
}

async function requireAccount(state: State) {
  if (state.needsReauthorization) throw new TodoistError("AUTH_REJECTED", 'Todoist rejected the saved authorization. Say "connect me to Todoist" to authorize again.', true);
  const account = await savedAccount(state);
  if (!account) throw new TodoistError("NOT_CONNECTED", 'Todoist is disconnected or its saved connection was removed. Say "connect me to Todoist".', true);
  if (account.status === "EXPIRED") throw new TodoistError("AUTH_EXPIRED", 'Your Todoist authorization expired. Say "connect me to Todoist" to authorize again.', true);
  if (account.status === "REVOKED") throw new TodoistError("AUTH_REVOKED", 'Your Todoist authorization was revoked. Say "connect me to Todoist" to authorize again.', true);
  if (account.isDisabled) throw new TodoistError("AUTH_DISABLED", 'Your Todoist connection is disabled. Say "connect me to Todoist" to link it again.', true);
  if (["INITIATED", "INITIALIZING", "PENDING"].includes(account.status)) throw new TodoistError("AUTH_PENDING", 'Todoist authorization is waiting for approval in your browser. Finish it, then refresh your connection status.');
  if (account.status !== "ACTIVE") throw new TodoistError("AUTH_INACTIVE", `Todoist authorization is ${account.status.toLowerCase()}. Say "connect me to Todoist" to authorize again.`, true);
  return account;
}

async function connect() {
  const state = await load();
  const existing = await activeAccount(state);
  if (existing && (!state.needsReauthorization || state.pending?.id === existing.id)) {
    state.accountId = existing.id;
    delete state.pending;
    delete state.needsReauthorization;
    await save(state);
    return accountResult(true, "Connected", "Todoist authorization verified.");
  }
  if (state.pending) {
    let pending;
    try { pending = await api().connectedAccounts.get(state.pending.id); }
    catch (error: any) {
      if (error.status !== 404 && error.cause?.status !== 404) throw error;
    }
    if (!pending || !["INITIATED", "INITIALIZING", "PENDING"].includes(pending.status)) {
      delete state.pending;
      await save(state);
    }
  }
  if (!state.pending) {
    const session = await api().sessions.create(state.userId, {
      toolkits: ["todoist"],
      tools: { todoist: { enable: catalog.tools.map((tool: any) => tool.slug) } },
    });
    const request = await session.authorize("todoist");
    if (!request.redirectUrl || new URL(request.redirectUrl).protocol !== "https:") {
      throw new Error("Composio did not return a valid authorization link.");
    }
    state.pending = { id: request.id, url: request.redirectUrl };
    await save(state);
  }
  // Only an explicit Connect request opens the OAuth consent page.
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", [state.pending!.url], { timeout: 8000 }, error => error ? reject(error) : resolve());
  });
  let account;
  try { account = await api().connectedAccounts.waitForConnection(state.pending.id, 180000); }
  catch (error: any) {
    if (/timed?\s*out/i.test(error.message ?? "")) throw new TodoistError("AUTH_PENDING", "Todoist authorization has not finished yet. Complete it in your browser, then refresh the connection status. Your pending link is saved.");
    throw error;
  }
  if (account.toolkit.slug !== "todoist" || account.status !== "ACTIVE" || account.isDisabled) {
    throw new Error("Todoist authorization is not active.");
  }
  state.accountId = account.id;
  delete state.pending;
  delete state.needsReauthorization;
  await save(state);
  return accountResult(true, "Connected", "Todoist authorization verified. Your saved connection is ready to use.");
}

server.registerTool("connect_account", {
  title: "Connect Todoist",
  description: "Connect Todoist using Composio OAuth. Use when the user says connect me to Todoist or authorize Todoist. Reuse this installation's verified connection; otherwise open browser authorization and wait. This does not read or change tasks.",
  inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false },
}, async (_input, extra) => withFeedback("Connect Todoist", true, extra, async () => {
    if (disconnecting) throw new Error("A Todoist disconnect is still running. Wait for it to finish before connecting.");
    if (!connecting) connecting = connect().finally(() => { connecting = undefined; });
    return await connecting;
}));

server.registerTool("connection_status", {
  title: "Todoist account", description: "Show Todoist connection status and Connect/Disconnect controls. Use for account settings, connection status, or expired authorization. Does not start OAuth.",
  inputSchema: {}, annotations: { readOnlyHint: true, destructiveHint: false },
}, async (_input, extra) => withFeedback("Check connection", false, extra, async () => {
  const state = await load();
  const account = await savedAccount(state);
  const connected = account?.status === "ACTIVE" && !account.isDisabled && !state.needsReauthorization;
  const status = state.needsReauthorization ? "Authorization rejected" : connected ? "Connected" : account?.isDisabled ? "Disabled" : account?.status ?? "Disconnected";
  const message = connected ? "Todoist is connected and ready to use."
    : state.needsReauthorization ? "Todoist rejected your saved authorization. Connect again to authorize."
    : status === "EXPIRED" ? "Your Todoist authorization expired. Connect again to authorize."
    : status === "REVOKED" ? "Your Todoist authorization was revoked. Connect again to authorize."
    : ["INITIATED", "INITIALIZING", "PENDING"].includes(status) ? "Finish authorizing Todoist in your browser, then refresh."
    : "Todoist is disconnected. Connect to authorize in your browser.";
  return accountResult(Boolean(connected), status, message);
}));

async function disconnect() {
  if (connecting) throw new Error("Todoist authorization is still running. Finish or wait for it before disconnecting.");
  const state = await load();
  let providerRevoked = true;
  for (const id of new Set([state.accountId, state.pending?.id].filter(Boolean) as string[])) {
    let account;
    try { account = await api().connectedAccounts.get(id, { signal: AbortSignal.timeout(8000) }); }
    catch (error: any) { if (error.status === 404 || error.cause?.status === 404) continue; throw error; }
    if (account.toolkit.slug !== "todoist") throw new Error("Refusing to disconnect a non-Todoist connection.");
    if (account.status === "REVOKED") continue;
    try {
      const revoked = await api().connectedAccounts.revoke(id, { signal: AbortSignal.timeout(12000) });
      if (revoked.connectedAccount.status !== "REVOKED") throw new Error("Composio did not confirm that Todoist access was revoked. Refresh status before retrying.");
    }
    catch (error: any) {
      // Some providers cannot revoke programmatically; disable the Composio
      // connection instead and explicitly distinguish this from provider revocation.
      const status = error.status ?? error.cause?.status;
      if (![400, 409].includes(status)) throw error;
      if (!account.isDisabled) await api().connectedAccounts.disable(id, { signal: AbortSignal.timeout(8000) });
      providerRevoked = false;
    }
  }
  delete state.accountId;
  delete state.pending;
  delete state.needsReauthorization;
  await save(state);
  return accountResult(false, "Disconnected", providerRevoked
    ? "Todoist is disconnected. No tasks or projects were deleted."
    : "Todoist is disconnected in Composio. To also remove provider consent, revoke Composio in Todoist Settings → Integrations.", { providerRevoked });
}

server.registerTool("disconnect_account", {
  title: "Disconnect Todoist", description: "Disconnect this installation's Todoist connection. Use only when explicitly asked to disconnect or unlink Todoist. Revokes authorization where supported; otherwise disables the Composio connection. Never deletes Todoist data.",
  inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false },
}, async (_input, extra) => withFeedback("Disconnect Todoist", true, extra, async () => {
  if (!disconnecting) disconnecting = disconnect().finally(() => { disconnecting = undefined; });
  return await disconnecting;
}));

// Convert the inspected JSON input definitions into MCP's Zod schemas. Keep
// optional values absent so partial updates never inject unwanted defaults.
function fieldSchema(field: any): z.ZodTypeAny {
  let value: z.ZodTypeAny;
  if (field.anyOf) {
    value = z.union(field.anyOf.map(fieldSchema) as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  } else if (field.enum) {
    value = z.enum(field.enum as [string, ...string[]]);
  } else if (field.type === "string") {
    let text = z.string();
    if (field.minLength !== undefined) text = text.min(field.minLength);
    if (field.maxLength !== undefined) text = text.max(field.maxLength);
    value = text;
  } else if (field.type === "integer" || field.type === "number") {
    let number = z.number();
    if (field.type === "integer") number = number.int();
    if (field.minimum !== undefined) number = number.min(field.minimum);
    if (field.maximum !== undefined) number = number.max(field.maximum);
    value = number;
  } else if (field.type === "boolean") value = z.boolean();
  else if (field.type === "array") value = z.array(fieldSchema(field.items));
  else throw new Error(`Unsupported input schema type: ${field.type}`);
  return field.description ? value.describe(field.description) : value;
}

function inputShape(schema: any): z.ZodRawShape {
  return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, field]) => {
    let validator = fieldSchema(field);
    if (!(schema.required ?? []).includes(name)) validator = validator.optional();
    return [name, validator];
  }));
}

function validateArguments(name: string, args: Record<string, any>) {
  for (const key of ["content", "name", "task_id", "project_id", "section_id", "label_id"]) {
    if (typeof args[key] === "string" && !args[key].trim()) throw new Error(`${key} cannot be blank.`);
  }
  if (name === "create_task" || name === "update_task") {
    if (["due_string", "due_date", "due_datetime"].filter(key => args[key] !== undefined).length > 1) {
      throw new Error("Provide only one of due_string, due_date, or due_datetime.");
    }
    if ((args.duration !== undefined) !== (args.duration_unit !== undefined)) {
      throw new Error("Provide duration and duration_unit together.");
    }
    if (name === "create_task" && args.order === 0) throw new Error("Task order must be non-zero.");
    if (name === "update_task" && !Object.keys(args).some(key => key !== "task_id")) {
      throw new Error("Choose at least one task field to update.");
    }
  }
  if (name === "update_label" && !Object.keys(args).some(key => key !== "label_id")) {
    throw new Error("Choose at least one label field to update.");
  }
}

function listPage(data: any, keys: string[], depth = 0): { items: any[]; nextCursor?: string } {
  if (Array.isArray(data)) return { items: data };
  if (depth < 4 && data && typeof data === "object") {
    for (const key of ["results", ...keys, "items", "data", "response"]) {
      if (data[key] !== undefined) {
        const page = listPage(data[key], keys, depth + 1);
        return { ...page, nextCursor: data.next_cursor ?? page.nextCursor };
      }
    }
  }
  throw new Error("Unexpected list response from Composio; no empty list was assumed.");
}

function operationResult(tool: any, args: Record<string, any>, data: any) {
  const listKeys: Record<string, string> = {
    list_projects: "projects", list_sections: "sections", get_active_tasks: "tasks", list_labels: "labels",
  };
  const entity = listKeys[tool.name];
  const payload: Record<string, any> = { success: true, operation: tool.name, data };
  const blocks: any[] = [{ type: "header", title: tool.title }];
  if (entity) {
    const page = listPage(data, [entity]);
    payload[entity] = page.items;
    if (page.nextCursor) payload.next_cursor = page.nextCursor;
    blocks[0].trailing = `${page.items.length} returned`;
    if (page.items.length) {
      blocks.push({ type: "list", rows: page.items.slice(0, 6).map(item => ({
        title: String(item.name ?? item.content ?? item.id ?? "Item").slice(0, 60),
        ...(item.id ? { subtitle: `ID: ${item.id}` } : {}),
      })) });
    } else blocks.push({ type: "keyValue", pairs: [["Results", "No items returned"]] });
    if (page.nextCursor) blocks.push({ type: "keyValue", pairs: [["More results", "Ask for the next page"]] });
  } else if (tool.name === "get_productivity_stats") {
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unexpected productivity statistics response.");
    const stats = data.data ?? data;
    const items = [["Karma", stats.karma], ["Completed", stats.completed_count ?? stats.total_completed]]
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([label, value]) => ({ label, value: String(value) }));
    blocks.push(items.length ? { type: "stats", items } : { type: "keyValue", pairs: [["Status", "Productivity statistics retrieved"]] });
  } else {
    payload.arguments = args;
    const selected = args.target_name ?? args.content ?? args.name ?? args.task_id ?? args.project_id ?? args.section_id ?? args.label_id;
    blocks.push({ type: "keyValue", pairs: [
      ["Status", `${tool.title} succeeded`],
      ...(selected ? [["Item", String(selected).slice(0, 180)]] : []),
    ] });
  }
  return { content: [{ type: "text" as const, text: JSON.stringify({ ...payload, _voiceos_glance: { blocks } }) }] };
}

for (const tool of catalog.tools) {
  server.registerTool(tool.name, {
    title: tool.title, description: tool.description, inputSchema: z.object(inputShape(tool.inputSchema)).strict(),
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: ["delete_project", "delete_section", "delete_label"].includes(tool.name), openWorldHint: true },
  }, async (input: Record<string, any>, extra) => withFeedback(tool.title,
    !tool.readOnly, extra, async () => {
      const { target_name, ...args } = input;
      validateArguments(tool.name, args);
      const state = await load();
      const account = await requireAccount(state);
      // A single selected action, no fallback tool names and no automatic OAuth.
      let response;
      try {
        response = await api().tools.execute(tool.slug, {
          userId: state.userId, connectedAccountId: account.id,
          arguments: args, version: catalog.version,
        }, { signal: AbortSignal.timeout(20000) });
      } catch (error: any) {
        if (isTimeout(error)) {
          throw new TodoistError("OUTCOME_UNKNOWN", tool.readOnly
            ? "Todoist took too long to respond. Try the read request again."
            : "Todoist did not return a final response in time. The change may have completed; check Todoist before retrying to avoid a duplicate.");
        }
        throw error;
      }
      if (!response.successful) {
        const detail = typeof response.error === "string" ? response.error
          : (response.error as any)?.message ?? (response.error as any)?.detail ?? "Composio could not complete the selected Todoist operation.";
        if (/revoked/i.test(detail) || (/expired|invalid|unauthoriz|authentication/i.test(detail) && /token|oauth|credential|authoriz|connection/i.test(detail))) {
          state.needsReauthorization = true;
          await save(state);
        }
        if (/revoked/i.test(detail)) throw new TodoistError("AUTH_REVOKED", 'Your Todoist authorization was revoked. Say "connect me to Todoist" to authorize again.', true);
        if (/expired/i.test(detail) && /token|oauth|authoriz|connection/i.test(detail)) throw new TodoistError("AUTH_EXPIRED", 'Your Todoist authorization expired. Say "connect me to Todoist" to authorize again.', true);
        if (/invalid|unauthoriz|authentication/i.test(detail) && /token|oauth|credential|authoriz|connection/i.test(detail)) throw new TodoistError("AUTH_REJECTED", 'Todoist rejected the saved authorization. Check your Todoist connection and authorize again if needed.', true);
        throw new Error(detail);
      }
      return operationResult(tool, { ...args, ...(target_name ? { target_name } : {}) }, response.data);
  }));
}

await server.connect(new StdioServerTransport());
