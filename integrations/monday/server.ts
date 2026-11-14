import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Composio } from "@composio/core";
import { z } from "zod";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const server = new McpServer({ name: "composio-monday", version: "0.1.3" });
const stateFile = new URL("./.composio-auth.json", import.meta.url);
const stateSchema = z
  .object({
    userId: z.string().startsWith("voiceos-monday-"),
    accountId: z.string().min(1).optional(),
    pending: z
      .object({
        id: z.string().min(1),
        url: z.string().url().startsWith("https://"),
      })
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Output = {
  connected: boolean;
  status: string;
  message: string;
  authorizationUrl?: string;
  providerRevoked?: boolean;
};
type ReadOutput = {
  resultType: "boards" | "tasks" | "board_choices" | "board_members" | "comments";
  boardName?: string;
  groupName?: string;
  itemName?: string;
  pending_item?: { draft_id: string; item_name: string };
  status: string;
  message: string;
  records: Record<string, unknown>[];
  pagination: Record<string, unknown>;
};
const mondayVersion = "20261101_00";
const readActions = [
  "MONDAY_BOARDS",
  "MONDAY_GET_ITEMS",
  "MONDAY_ITEMS_PAGE",
  "MONDAY_LIST_GROUPS",
  "MONDAY_COLUMNS",
  "MONDAY_LIST_USERS",
  "MONDAY_GET_ME",
  "MONDAY_GET_TEAMS",
  "MONDAY_GET_WORKSPACES",
] as const;
const membershipActions = ["MONDAY_ADD_USERS_TO_BOARD", "MONDAY_DELETE_SUBSCRIBERS_FROM_BOARD"] as const;
const writeActions = ["MONDAY_CREATE_ITEM", "MONDAY_CREATE_UPDATE", "MONDAY_EDIT_UPDATE", "MONDAY_DELETE_UPDATE", "MONDAY_CREATE_BOARD", ...membershipActions] as const;
const approvedActions = [...readActions, ...writeActions];
type Action = (typeof approvedActions)[number];
type WriteOutput = { status: string; message: string; id: string; completedColumns?: string[] };
type CreatedBoardOutput = WriteOutput & {
  name: string;
  url: string | null;
  item_destination?: { board_id: number; item_name?: string };
  item_follow_up?: string;
};
const id = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = () => z.array(id()).min(1).max(100);
const nonempty = () => z.string().trim().min(1);
const columnValues = () => z.union([z.string(), z.record(z.unknown())]);
const itemName = () => nonempty().max(256);
const draftId = () => z.string().uuid();
const memberRole = z.enum(["subscriber", "owner"]);
const memberBoardInput = {
  board_name: nonempty().max(256),
  workspace_name: nonempty().max(256).optional(),
  board_id: id().optional(),
};
const listBoardMembersSchema = z.object(memberBoardInput).strict();
const prepareManageUsersSchema = z.object({
  ...memberBoardInput,
  operation: z.enum(["add", "remove"]),
  people: z.array(z.object({ person: nonempty().max(320), role: memberRole.optional() }).strict()).min(1).max(100),
  replaces_draft_id: draftId().optional(),
}).strict();
const memberPreview = z.object({ name: nonempty(), email: nonempty(), role: memberRole }).strict();
const manageUsersSchema = z.object({
  draft_id: draftId(),
  operation: z.enum(["add", "remove"]),
  board: nonempty(),
  people: z.array(memberPreview).min(1).max(100),
  warnings: z.array(nonempty()).max(2),
}).strict();
type ManageUsersInput = z.infer<typeof manageUsersSchema>;
type MemberRole = z.infer<typeof memberRole>;
type MemberChange = z.infer<typeof memberPreview> & { id: number; before?: MemberRole };
type MembershipQuestion = { question: string; matching_boards?: { board_id: number; board_name: string; workspace_name: string }[] };
type MembershipPreparation = MembershipQuestion | { manage_users_arguments: ManageUsersInput; message?: string };
type MembershipResult = { status: string; message: string };
const membershipDrafts = new Map<string, {
  accountId: string;
  board: BoardActionTarget;
  args: ManageUsersInput;
  changes: MemberChange[];
  actorId?: number;
  expires: number;
}>();
const activeMembershipWrites = new Set<string>();
const prepareCreateItemSchema = z.object({
  board_id: id().optional(),
  board_name: nonempty().max(256).optional(),
  item_name: itemName().optional(),
  group_id: nonempty().optional(),
  column_values: columnValues().optional(),
  replaces_draft_id: draftId().optional(),
  revises_item_name: itemName().optional(),
}).strict();
const createItemPreview = z.object({
  board: z.string(),
  groups: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  columns: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
}).strict();
const createItemSchema = z.object({
  draft_id: draftId(),
  item_name: itemName(),
  group_id: nonempty(),
  preview: createItemPreview,
}).strict();
type CreateItemPreview = z.infer<typeof createItemPreview>;
type CreateItemInput = z.infer<typeof prepareCreateItemSchema>;
type CreateItemDraft = {
  preview?: CreateItemPreview;
  args?: { board_id: string; column_values?: string };
  itemName: string;
  groupId?: string;
  groupTitle?: string;
  columns: Record<string, unknown>;
  columnTitles?: Record<string, string>;
  columnTypes?: Record<string, unknown>;
  carriedByTitle?: boolean;
  carriedGroupByTitle?: boolean;
  retired?: boolean;
  accountId: string;
  expires: number;
};
type PrepareCreateItemOutput = {
  status: string;
  message: string;
  create_item_arguments?: z.infer<typeof createItemSchema>;
  board?: { name: string; groups: Record<string, unknown>[]; columns: Record<string, unknown>[] };
};
const createItemDrafts = new Map<string, CreateItemDraft>();
const prepareCreateItemDescription = "Use this tool for item creation or edits to the latest pending Create item confirmation. A correction to the board on an Archive board or Delete board confirmation belongs to prepare_archive_board or prepare_delete_board, respectively. Start every Monday item creation here. An explicit item rename, or \"change the name to …\" while the Create item confirmation is active, changes item_name. Pass the new item_name and replaces_draft_id, or revises_item_name with the previous item name. Omit board and group fields unless the user asks to change them. Never use create_board for an item rename. If it is unclear which name the user means, ask whether they mean the board or the item. A follow-up such as 'change the board to voiceos' after a Create item card means change the pending item's destination. For that correction, call this tool with the new board_name and replaces_draft_id. If the pending ID is missing from the context, pass revises_item_name with the exact pending item's name from this conversation. If neither is known, ask which pending item should go on the requested board. Board renaming is unavailable. Omitted group and column arguments are carried over on a revision; ask if a requested value cannot be matched. For a new item, pass item_name and the board the user specified in the request, including a clear reference such as 'that board'. Use board_name or a verified board_id. If the user did not specify a destination, omit both board fields and ask the user to choose. Do not infer a destination from past requests or board lists. If the result is board_choices, ask its question as the final response for that turn and wait for the user to say or type a board name. This is a clarification, so do not open a confirmation yet. A bare board name after that question answers it, even if the reply contains no verb. Call prepare_create_item again with that board_name and pending_item.draft_id as replaces_draft_id, or use revises_item_name with pending_item.item_name if the draft ID is unavailable. Do not list boards or items in response to that choice. Once preparation returns create_item_arguments, call create_item for confirmation. This tool only reads Monday. With a resolved board and without item_name or a revision, it returns groups and columns. Pass optional group_id (ID or title; omit for the top group) and only requested column_values keyed by actual column ID or exact title. Use exact status labels, ISO dates, and Monday person names or IDs. Pass create_item_arguments verbatim to create_item. Never silently drop a requested value.";
const createItemDescription = "Use create_item_arguments from prepare_create_item verbatim. For a spoken or typed item rename, or a name edit while this card is active, call prepare_create_item with the pending item draft ID and new item_name. Keep the destination and other values. The confirmation lets the user edit the item name and choose a group on the selected board. Approval creates the item in the selected group. Never say an item was created unless the result confirms its ID. For a voice revision such as 'change the board to voiceos', call prepare_create_item with the new board_name and replaces_draft_id or the pending item's exact name in revises_item_name. Ask about any previously requested value with no clear match. Board renaming is unavailable. Do not retry a write automatically.";
const prepareUpdateItemSchema = z.object({
  board_id: id().optional(),
  board_name: nonempty().optional(),
  item_id: id().optional(),
  item_name: nonempty().optional(),
  column_values: columnValues().optional(),
  destination_group: nonempty().nullable().optional(),
  replaces_draft_id: draftId().optional(),
}).strict();
const updateItemPreview = z.object({
  board: z.string(),
  item: z.string(),
  changes: z.array(z.object({ label: z.string(), before: z.string(), after: z.string() }).strict()),
}).strict();
const updateItemValuesSchema = z.object({ draft_id: draftId(), preview: updateItemPreview }).strict();
type PrepareUpdateItemOutput = {
  status: string;
  message: string;
  question?: string;
  update_item_arguments?: z.infer<typeof updateItemValuesSchema>;
  update_item_details?: { board: string; item: string; columns: { id: string; title: string; type: string; labels: string[] }[] };
};
type UpdateItemChange = {
  id: string;
  type: string;
  label: string;
  before: unknown;
  expected: unknown;
  value: unknown;
  settings: unknown;
};
type UpdateItemDraft = {
  accountId: string;
  boardId: string;
  itemId: string;
  preview: z.infer<typeof updateItemPreview>;
  changes: UpdateItemChange[];
  destination?: ItemMoveDestination;
  requested: [string, unknown][];
  expires: number;
  revising?: boolean;
};
type ItemMoveDestination = { groupId: string; groupName: string; sourceGroupId: string; sourceGroupName: string };
const updateItemDrafts = new Map<string, UpdateItemDraft>();
const savingItems = new Set<string>();
const prepareUpdateItemDescription = "Start here when the user wants to edit an existing Monday item or move it to another group on its current board. For a request naming the board and item, call this directly with board_name and item_name. For example, for move task 1 in the testing board to group 2, pass board_name Testing, item_name Task 1, and destination_group Group 2. Do not call get_boards or get_items first when names are supplied. For an item already verified in this conversation, pass item_id and optional verified board_id. Keep IDs internal. If the result includes question, ask it and wait for the answer before preparing again. For a group move, pass destination_group as the group title or a verified group ID on the item’s current board. Include all requested column edits in the same call. With neither column_values nor destination_group this returns the item's editable columns and labels. Pass only requested changes keyed by actual column ID or exact title. Use name for the item name, existing labels for status/dropdown, ISO dates and UTC times, strings for text, numbers for numbers, and booleans for checkboxes. For People, use a name or {names: [...]}, or {operation: 'add' or 'remove', names: [...]} to preserve other assignees. Use null only for an explicit clear. Ask about any unresolved item, column, value, or person before opening a card. For a voice revision of an open Update item card, pass replaces_draft_id and only the parts being revised. If revising column_values, pass the complete desired column set. An omitted destination_group retains the pending move and null removes it. Omit item and board identifiers and names for revisions. Call update_item_values with update_item_arguments verbatim to show one confirmation. This tool only reads Monday.";
const updateItemValuesDescription = "Use update_item_arguments from prepare_update_item verbatim to show one Update item confirmation. Approval saves and verifies column edits first, then attempts the reviewed group move. A move may fail after edits are saved. Report both outcomes from the result. Use prepare_update_item for a voice revision before approval. Only report success if the result confirms the changes. Check Monday before retrying an unconfirmed save.";
const commentItemInput = {
  item_name: itemName().optional(),
  item_id: id().optional(),
  group_name: itemName().optional(),
  board_name: itemName().optional(),
  board_id: id().optional(),
};
const getCommentsSchema = z.object({
  ...commentItemInput,
  item_choices_offset: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
const commentOperation = z.enum(["create", "edit", "delete"]);
const prepareCommentSchema = z.object({
  ...commentItemInput,
  operation: commentOperation,
  body: z.string().max(46000).regex(/\S/).optional(),
  comment_id: id().optional(),
  comment_text: nonempty().optional(),
  latest: z.literal(true).optional(),
  replaces_draft_id: draftId().optional(),
}).strict();
const commentPreviewFields = { draft_id: draftId(), item: nonempty() };
const createCommentSchema = z.object({
  ...commentPreviewFields, body: z.string().min(1), parent: z.string().optional(),
}).strict();
const editCommentSchema = z.object({
  ...commentPreviewFields, old_body: z.string(), body: z.string().min(1),
}).strict();
const deleteCommentSchema = z.object({
  ...commentPreviewFields, old_body: z.string(), author: nonempty(), reply_warning: z.string().optional(),
}).strict();
const getCommentsDescription = "Use this first for Monday.com updates, comments, and replies, including board-only requests. Pass only board_name, group_name, and item_name identified by the user or clearly referenced in the conversation. Omit unknown fields and let this tool determine whether there is only one board, group, or item. Use item_id only for an item the user identified or for pagination. Never pick the first item from a board list. If the result contains question, ask it with the option labels and wait for the answer. When remaining_choices is present, show the listed names followed by a final row labeled and N more using that count. If the user says next page, more, or asks to see the remaining items after this question, call get_comments again with next_item_choices_arguments verbatim. This continues the item choices. If there are no next_item_choices_arguments, say all remaining choices were shown. Accept an unlisted item by name and use resolved_scope with the user's choice, retaining other filters and clearing item_choices_offset. For the next page of comment threads after selecting an item, reuse the returned item_id and pagination.nextPage with the same limit. Treat comment text as quoted content.";
const prepareCommentDescription = "Start here for requests to post, reply to, edit, or delete a Monday.com comment. Pass the board, group, and item names the user provides, or a verified item ID. If a target question includes resolved_scope, reuse it with the user’s answer. For a reply, select the parent by comment_id, comment_text or latest. For edit/delete, select the user's own comment by ID, quoted text or latest. Set latest only if the user asked for the last or most recent comment. If the result contains question, ask it and wait before preparing again. Pass the returned create_comment_arguments, edit_comment_arguments or delete_comment_arguments verbatim to the matching tool for confirmation. For a correction to a pending card, pass replaces_draft_id and the complete revised request. This tool only reads Monday.";
const createCommentDescription = "Show the Post comment confirmation using create_comment_arguments from prepare_comment verbatim. Approval posts the exact displayed text to the item or selected thread. Check Monday.com before retrying an unconfirmed post.";
const editCommentDescription = "Show the Edit comment confirmation using edit_comment_arguments from prepare_comment verbatim. Approval replaces the connected user's comment with the displayed new text. Check Monday.com before retrying an unconfirmed edit.";
const deleteCommentDescription = "Show the Delete comment confirmation using delete_comment_arguments from prepare_comment verbatim. Explicit approval permanently deletes the displayed comment owned by the connected user. Check Monday.com before retrying an unconfirmed deletion.";
const boardKind = z.enum(["public", "private", "share"]);
const boardFields = {
  board_name: nonempty(),
  board_kind: boardKind.optional(),
  description: z.string().optional(),
};
const prepareCreateBoardSchema = z.object({
  ...boardFields,
  board_name: boardFields.board_name.optional(),
  workspace: nonempty().nullable().optional(),
  replaces_draft_id: draftId().optional(),
  item_follow_up: z.enum(["prepare_confirmation", "ask_name", "none"]).optional(),
  follow_up_item_name: itemName().optional(),
}).strict();
const workspaceChoice = z.object({ value: z.string(), label: z.string() }).strict();
const createBoardSchema = z.object({
  ...boardFields,
  draft_id: draftId(),
  workspace_choice: nonempty().optional(),
  workspace_choices: z.array(workspaceChoice),
  workspace_notice: z.string().optional(),
  submission_error: z.string().optional(),
}).strict();
type CreateBoardInput = z.infer<typeof createBoardSchema>;
type RejectedBoardOutput = { error: string; retry_create_board_arguments: CreateBoardInput };
type BoardRequest = Omit<z.infer<typeof prepareCreateBoardSchema>, "replaces_draft_id">;
type PrepareCreateBoardOutput =
  | { message: string; create_board_arguments: CreateBoardInput }
  | { message: string; pending_board: BoardRequest & { draft_id: string } }
  | { message: string; board_draft_status: "unavailable" | "submitting" | "unconfirmed" | "created" };
type CreateBoardDraft = {
  accountId: string;
  expires: number;
  request: BoardRequest;
  confirmation?: { args: CreateBoardInput; workspaceIds: Map<string, number> };
  replacedBy?: string;
  submission?: "submitting" | "unconfirmed" | "created";
};
const createBoardDrafts = new Map<string, CreateBoardDraft>();
const recentlyCreatedBoards = new Map<string, { board: Record<string, unknown>; expires: number }>();
const prepareCreateBoardDescription = "Start every Monday board creation here. Treat a new request to create a board as a fresh draft, even in the same conversation. For a fresh draft, pass only details the user supplied in that request or explicitly asked to reuse. Omit replaces_draft_id. If the user gives no board name, omit board_name and ask for it using the tool result. Never fill in a board name, description, visibility, or workspace from an earlier unrelated request, a prior confirmation, or a previously created board. In \"create a board and add an item to it\", \"it\" means the new board in this request. Only when the user also requests an item, set item_follow_up to prepare_confirmation and follow_up_item_name to the name they supplied, or set item_follow_up to ask_name if it is missing. If the user explicitly renames the item before this board is created, revise the same pending board draft with only the updated follow_up_item_name and item_follow_up set to prepare_confirmation. Keep board_name and all other board settings. If a Create item confirmation is already active, use prepare_create_item for a name edit. When both the board and item are plausible targets and the user does not specify which, ask which name they mean before changing either. This shows the next step on the board success screen. Item creation still requires its own confirmation. Set item_follow_up to none if the user drops the item request before approving the board. Use replaces_draft_id only when the user edits the same pending board, such as \"change visibility to private\", or directly answers a question about it. Pass the latest draft ID and only the changed fields. Older references to the same pending board resolve to its latest revision. If the result has board_draft_status, follow its message. For unavailable, recover quietly only when the conversation confirms the board is still pending. For created, submitting, or unconfirmed, do not restart board creation. Pass workspace by name, null to switch to the default workspace, or description as an empty string to clear it. New boards default to public visibility, an empty description, and the default workspace. If the result has pending_board, ask its question about the missing name or unresolved workspace. When the user replies to that question or edits that same draft, pass pending_board.draft_id as replaces_draft_id. If the result has create_board_arguments, pass them verbatim to create_board for approval. This tool only reads Monday.";
const createBoardDescription = "Always show the Create board confirmation, including when the user also requests an item. Use create_board_arguments from the current draft verbatim. For a new create-board request, start with prepare_create_board and use that new draft. The user can edit the name, visibility, description, and workspace. For spoken or typed revisions, use prepare_create_board with the latest draft_id and changed fields. If the result has retry_create_board_arguments, show a fresh Create board confirmation with those arguments verbatim; the card shows Monday's rejection and the user's submitted settings. Wait for the user to edit and approve again. If no retry arguments are returned, report the error and check Monday before considering another create. On success, use item_destination.board_id and item_destination.item_name, when present, for prepare_create_item only if the user also requested an item. Follow the latest item name the user gave. A name edit while the Create item confirmation is active belongs to that item; use prepare_create_item and never reopen this board confirmation for that edit. Omit group_id for the top group unless the user specified a group. If the item name is missing, ask for it and retain this board ID for the reply. Always show a separate Create item confirmation. If the item is cancelled or fails, report that the board was created and the item wasn't confirmed. Resume from item preparation on this board if the user retries. Never create the board again to retry the item.";
const groupPosition = z.enum(["top", "bottom", "before", "after"]);
const groupName = () => nonempty().max(255);
const prepareCreateGroupSchema = z.object({
  board_id: id().optional(),
  board_name: nonempty().optional(),
  group_name: groupName().optional(),
  position: z.object({ placement: groupPosition, reference_group: nonempty().optional() }).strict().optional(),
  replaces_draft_id: draftId().optional(),
}).strict();
const createGroupSchema = z.object({
  draft_id: draftId(),
  group_name: groupName(),
  position: nonempty(),
  preview: z.object({
    board: nonempty(),
    positions: z.array(z.object({ value: nonempty(), label: nonempty() }).strict()),
  }).strict(),
}).strict();
type CreateGroupInput = z.infer<typeof createGroupSchema>;
type GroupRequest = Omit<z.infer<typeof prepareCreateGroupSchema>, "replaces_draft_id">;
type PrepareCreateGroupOutput =
  | { question: string; pending_group: { draft_id: string } }
  | { create_group_arguments: CreateGroupInput };
type GroupPlacement = { method: "before_at" | "after_at"; reference?: { id: string; title: string } };
type CreateGroupDraft = {
  accountId: string;
  expires: number;
  request: GroupRequest;
  revising?: boolean;
  confirmation?: {
    boardId: string;
    preview: CreateGroupInput["preview"];
    positions: Map<string, GroupPlacement>;
  };
};
const createGroupDrafts = new Map<string, CreateGroupDraft>();
const prepareCreateGroupDescription = "Start here to create an empty group (section) on an existing Monday board. Pass the board name or a verified board ID, the new group name, and any requested position. Position defaults to bottom. For before or after, pass the reference group's name or verified ID in position.reference_group. If the result includes a question, ask it and use pending_group.draft_id as replaces_draft_id when the user answers. To revise the same pending group by voice, pass replaces_draft_id and only the changed fields. For a new request, start a fresh draft. Pass create_group_arguments verbatim to create_group for confirmation. This tool only reads Monday.";
const createGroupDescription = "Use create_group_arguments from prepare_create_group verbatim to show the Create group confirmation. The card shows the board and lets the user edit the group name and position. For a spoken revision, use prepare_create_group with the current draft ID. Approval creates one empty group on the reviewed board. Only report success when the result confirms the group ID. Check Monday before retrying an unconfirmed creation.";
const prepareBoardActionSchema = z.object({
  board_id: id().optional(),
  board_name: nonempty().optional(),
  replaces_draft_id: draftId().optional(),
  revises_board_name: nonempty().optional(),
}).strict();
const boardActionSchema = z.object({
  draft_id: draftId(),
  board_choice: nonempty(),
  board_choices: z.array(z.object({ value: nonempty(), label: nonempty() }).strict()),
}).strict();
type BoardActionInput = z.infer<typeof boardActionSchema>;
type BoardActionTarget = { id: string; name: string; workspaceId: string; workspaceName: string };
type BoardAction = "archive" | "delete";
type PrepareBoardActionOutput =
  | { question: string; matching_boards?: BoardActionInput["board_choices"] }
  | { message: string; archive_board_arguments: BoardActionInput }
  | { message: string; delete_board_arguments: BoardActionInput };
type BoardActionDraft = {
  accountId: string;
  expires: number;
  initialBoard: BoardActionTarget;
  boards: Map<string, BoardActionTarget>;
  choices: BoardActionInput["board_choices"];
};
const boardActionDrafts: Record<BoardAction, Map<string, BoardActionDraft>> = {
  archive: new Map(),
  delete: new Map(),
};
const prepareArchiveBoardDescription = "Start every Monday board archive here, including a correction to the target while the Archive board confirmation is open or immediately after VoiceOS dismisses it for an edit. A short reply such as “I meant the testing one”, “the testing board instead”, or “testing” following that confirmation means archive testing. Keep the archive action from the latest confirmation. Call this tool with the corrected board_name and replaces_draft_id from that confirmation. If its draft ID is missing, use revises_board_name with the exact previous board name from this conversation. Use board_name or a verified board_id for the new target. If the result contains a question, ask it and use any matching_boards to clarify. Pass archive_board_arguments verbatim to archive_board to show a fresh confirmation. This tool only reads Monday.";
const archiveBoardDescription = "Show the Archive board confirmation using archive_board_arguments from prepare_archive_board verbatim. The card lets the user change the board before approving. If the user says or types a different board, including “I meant the testing one”, keep the pending archive action. Call prepare_archive_board with the new board and the previous draft ID or exact previous board name, then show a fresh Archive board confirmation. Only approval archives the selected board. Check Monday.com before retrying an unconfirmed archive.";
const prepareDeleteBoardDescription = "Start here when the user asks to delete a Monday board or corrects the target of a pending Delete board confirmation. A short reply such as “I meant the testing one” after that card changes the board to testing and keeps the delete action. Pass the new board_name or verified board_id. For a correction, pass replaces_draft_id from the Delete board confirmation, or use revises_board_name with its exact previous board name if the ID is missing. If the result contains a question, ask it and use matching_boards to clarify. Pass delete_board_arguments verbatim to delete_board to show a fresh confirmation. This tool only reads Monday.";
const deleteBoardDescription = "Show the Delete board confirmation using delete_board_arguments from prepare_delete_board verbatim. The user can change the board on the card. For a spoken or typed board correction, call prepare_delete_board and show a fresh Delete board confirmation. Approval moves the selected board to Monday.com Trash, where it can be recovered for 30 days. Report success only when Monday confirms deletion. Check Monday.com before retrying an unconfirmed deletion.";
const getBoardsSchema = z
  .object({
    ids: ids().optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    state: z.enum(["active", "archived", "deleted", "all"]).optional(),
    board_kind: z.enum(["private", "public", "share"]).optional(),
    workspace_ids: ids().optional(),
  })
  .strict();
const getItemsSchema = z
  .object({
    ids: ids().optional(),
    board_id: id().optional(),
    board_name: z.string().trim().min(1).max(256).describe("Exact board name from a prior get_boards result, for display only. Never invent a name or use it instead of board_id. May be carried forward with a cursor.").optional(),
    cursor: z.string().trim().min(1).optional(),
    group_id: z.string().trim().min(1).optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    newest_first: z.boolean().optional(),
    exclude_nonactive: z.boolean().optional(),
  })
  .strict();
let client: Composio | undefined;
let connecting: Promise<Output> | undefined;
let disconnecting: Promise<Output> | undefined;
let activeConnectWatcher: AbortController | undefined;

function stopBackgroundConnectWatcher() {
  if (activeConnectWatcher) {
    activeConnectWatcher.abort();
    activeConnectWatcher = undefined;
  }
}

function shouldWatchBackgroundConnect(): boolean {
  if (!process.env.MONDAY_TEST_SCENARIO) return true;
  try {
    const scenario = JSON.parse(
      readFileSync(process.env.MONDAY_TEST_SCENARIO, "utf8"),
    );
    return Boolean(scenario.watchBackgroundConnect);
  } catch {
    return false;
  }
}

function getPollIntervalMs(): number {
  if (!process.env.MONDAY_TEST_SCENARIO) return 2000;
  try {
    const scenario = JSON.parse(
      readFileSync(process.env.MONDAY_TEST_SCENARIO, "utf8"),
    );
    return scenario.pollIntervalMs ?? 50;
  } catch {
    return 50;
  }
}

async function notify(message: string) {
  try {
    await server.server.request(
      {
        method: "voiceos/reminders/trigger",
        params: {
          message: message.slice(0, 1900), speak: false,
        },
      },
      z.object({ notificationId: z.string() }),
      { timeout: 4000 },
    );
    return true;
  } catch {
    console.error(
      "VoiceOS could not queue the Monday.com notification; the tool result is still available.",
    );
    return false;
  }
}

function startBackgroundConnectWatcher(connectionId: string) {
  if (!shouldWatchBackgroundConnect()) return;
  stopBackgroundConnectWatcher();
  const controller = new AbortController();
  activeConnectWatcher = controller;
  const pollIntervalMs = getPollIntervalMs();

  (async () => {
    const startTime = Date.now();
    // Poll for up to 180 seconds (3 minutes)
    while (!controller.signal.aborted && Date.now() - startTime < 180000) {
      await delay(pollIntervalMs);
      if (controller.signal.aborted) break;
      try {
        const savedAccount = await api().connectedAccounts.get(connectionId, {
          signal: AbortSignal.timeout(5000),
        });
        if (savedAccount?.status === "ACTIVE" && !savedAccount.isDisabled) {
          const state = await load();
          if (state.pending?.id === connectionId) {
            state.accountId = connectionId;
            delete state.pending;
            await save(state);
            await notify(
              "Monday.com — Connected successfully. Your account is ready to use.",
            );
          }
          break;
        }
        if (["FAILED", "EXPIRED", "REVOKED"].includes(savedAccount?.status)) {
          break;
        }
      } catch {
        // Continue polling until timeout or aborted
      }
    }
  })().catch(() => {});
}

function api() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey)
    throw new Error("Add your Composio API key in Monday.com settings first.");
  return (client ??= new Composio({
    apiKey,
    baseURL: "https://backend.composio.dev",
    allowTracking: false,
    disableVersionCheck: true,
  }));
}

// Composio holds provider tokens. Only this installation's identity and connection references are saved locally.
async function save(state: State) {
  const temporary = new URL(
    `./.composio-auth.${randomUUID()}.tmp`,
    import.meta.url,
  );
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function load(): Promise<State> {
  let text: string;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = { userId: `voiceos-monday-${randomUUID()}` };
    await save(state);
    return state;
  }
  const parsed = stateSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      "Invalid local Monday.com connection state. Restore or reset .composio-auth.json before reconnecting.",
    );
  return parsed.data;
}

function httpStatus(error: unknown): number | undefined {
  const value = error as { status?: number; cause?: { status?: number } };
  return value?.status ?? value?.cause?.status;
}

async function account(id: string, signal = AbortSignal.timeout(8000)) {
  try {
    const saved = await api().connectedAccounts.get(id, { signal });
    if (saved.toolkit.slug !== "monday")
      throw new Error(
        "Refusing to use a saved connection that is not Monday.com.",
      );
    return saved;
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    if (httpStatus(error) === 401)
      throw new Error(
        "Composio rejected your API key. Update it in Monday.com settings; reconnecting alone will not fix the key.",
      );
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerError(message: string): Error {
  if (
    /token.*(expired|invalid|revoked)|(?:expired|invalid|revoked).*token|not authenticated|unauthorized|NOT_AUTHENTICATED|USER_UNAUTHORIZED/i.test(
      message,
    )
  ) {
    return new Error(
      "Monday.com authorization is no longer valid. Run Connect Monday.com again to authorize.",
    );
  }
  return new Error(`Monday.com request failed: ${message}`);
}

class BoardSettingsRejection extends Error {}

function actionError(action: Action, message: string, envelope: unknown): Error {
  if (membershipActions.some(write => write === action)) {
    let layer = record(envelope);
    while (layer) {
      const providerMessage = Array.isArray(layer.errors)
        ? layer.errors.map(error => displayText(record(error)?.message)).filter(Boolean).join(" ")
        : displayText(layer.error_message);
      if (providerMessage) {
        message = providerMessage;
        break;
      }
      layer = record(layer.raw_response) ?? record(layer.data);
    }
    return /token.*(?:expired|invalid|revoked)|(?:expired|invalid|revoked).*token|not authenticated/i.test(message)
      ? providerError(message) : new Error(`Monday.com: ${message}`);
  }
  if (action === "MONDAY_CREATE_BOARD" &&
      !/timed?\s*out|timeout|unknown outcome|unavailable to verify|connection (?:lost|reset)/i.test(message) &&
      /\b(?:private|shareable|board_kind|visibility)\b.{0,180}\b(?:plan|upgrade|not (?:allowed|supported|available)|cannot|requires?)\b|\b(?:plan|upgrade|not (?:allowed|supported|available)|cannot|requires?)\b.{0,180}\b(?:private|shareable|board_kind|visibility)\b/is.test(message)) {
    let layer = record(envelope);
    while (layer) {
      if (record(layer.create_board)?.id != null || layer.id != null) return providerError(message);
      layer = record(layer.raw_response) ?? record(layer.data);
    }
    return new BoardSettingsRejection(message);
  }
  return providerError(message);
}

async function executeAction(action: Action, args: Record<string, unknown>, expectedAccountId?: string) {
  if (!approvedActions.includes(action))
    throw new Error("This Monday.com operation is not approved.");
  if (disconnecting)
    throw new Error(
      "Monday.com is disconnecting. Wait for it to finish before making another request.",
    );
  const signal = AbortSignal.timeout(20000);
  const state = await load();
  if (!state.accountId)
    throw new Error(
      "Monday.com is not connected. Run Connect Monday.com to authorize or verify browser approval.",
    );
  if (expectedAccountId && state.accountId !== expectedAccountId)
    throw new Error("The connected Monday.com account changed. Prepare the request again.");
  const saved = await account(state.accountId, signal);
  if (!saved || saved.isDisabled || saved.status !== "ACTIVE") {
    throw new Error(
      `Monday.com connection is ${saved?.isDisabled ? "disabled" : (saved?.status?.toLowerCase() ?? "disconnected")}. Run Connect Monday.com again to authorize.`,
    );
  }
  let result;
  try {
    result = await api().tools.execute(
      action,
      {
        connectedAccountId: state.accountId,
        userId: state.userId,
        version: mondayVersion,
        arguments: args,
      },
      { signal },
    );
  } catch (error) {
    if (signal.aborted)
      throw new Error("Monday.com request timed out. Check Monday.com before retrying; the operation may already have completed.");
    if (httpStatus(error) === 401)
      throw new Error(
        "Composio rejected your API key. Update it in Monday.com settings; reconnecting alone will not fix the key.",
      );
    if (httpStatus(error) === 403 && membershipActions.some(write => write === action)) {
      const response = record(record(error)?.error) ?? record(record(record(error)?.cause)?.error);
      throw actionError(action, displayText(response?.message) ?? "Access was denied. Check board permissions and authorized scopes.", response);
    }
    if (httpStatus(error) === 403)
      throw new Error(
        "Monday.com access was denied. Check your board permissions and the Composio app's authorized scopes.",
      );
    throw providerError(
      error instanceof Error ? error.message : "Composio execution failed.",
    );
  }
  if (!result.successful || result.error)
    throw actionError(action, result.error || "Composio reported an unsuccessful execution.", result.data);
  // Composio can wrap the Monday GraphQL response in raw_response.
  // Check errors at each layer before reading any returned records or IDs.
  let data = record(result.data);
  if (!data) throw new Error("Monday.com returned an unexpected result. Check Monday.com before retrying a write.");
  for (;;) {
    if (
      data.errors &&
      (!Array.isArray(data.errors) || data.errors.length > 0)
    ) {
      const message = action === "MONDAY_CREATE_BOARD" && Array.isArray(data.errors)
        ? data.errors.map(error => displayText(record(error)?.message)).filter(Boolean).join(" ")
        : "";
      throw actionError(action, message || JSON.stringify(data.errors), result.data);
    }
    if (data.error || data.error_message)
      throw actionError(action, String(data.error_message ?? data.error), result.data);
    const nested = record(data.raw_response) ?? record(data.data);
    if (!nested) return data;
    data = nested;
  }
}

function records(value: unknown): Record<string, unknown>[] {
  const parsed = z
    .array(
      z
        .object({
          id: z.union([z.string().min(1), z.number()]),
          name: z.string(),
        })
        .passthrough(),
    )
    .safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Monday.com returned an unexpected result shape. No results can be confirmed; try again.",
    );
  return parsed.data;
}

const readPreviewLimit = 6;

function readSummary(count: number, noun: "board" | "item", boardName?: string): string {
  const scope = boardName ? ` on "${boardName}"` : "";
  if (count === 0) return `No matching ${noun}s found${scope}.`;
  if (count > readPreviewLimit) return `Here are the first few ${noun}s${scope}.`;
  return `Found ${count} ${count === 1 ? noun : `${noun}s`}${scope}.`;
}

function displayText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function itemSubtitle(item: Record<string, unknown>, groupName?: string): string | undefined {
  const columns = Array.isArray(item.column_values) ? item.column_values : [];
  const status = columns.map(record).find(column =>
    displayText(column?.text) && (
      column?.type === "status" || column?.type === "color" ||
      (column?.type == null && column?.id === "status")
    ),
  );
  return displayText(status?.text) ?? displayText(record(item.group)?.title) ?? groupName;
}

function readGlance(data: ReadOutput) {
  const isComments = data.resultType === "comments";
  const choosingBoard = data.resultType === "board_choices";
  const isMembers = data.resultType === "board_members";
  const isBoards = data.resultType === "boards" || choosingBoard;
  const count = data.records.length;
  const visibleCount = count > readPreviewLimit ? readPreviewLimit - 1 : count;
  const rows = data.records.slice(0, visibleCount).map(entry => {
    const subtitle = isComments ? displayText(entry.author)
      : isMembers ? (entry.role === "owner" ? "Owner" : "Subscriber")
      : isBoards ? displayText(record(entry.workspace)?.name) : itemSubtitle(entry, data.groupName);
    return {
      title: (isComments ? displayText(entry.text) ?? "Comment" : displayText(entry.name) ?? (isBoards ? "Untitled board" : "Untitled item")).slice(0, 60),
      ...(subtitle ? { subtitle: subtitle.slice(0, 60) } : {}),
    };
  });
  if (visibleCount < count) rows.push({ title: `and ${count - visibleCount} more` });
  if (choosingBoard) {
    return [
      { type: "header", title: data.itemName ? `Choose a board for “${data.itemName.slice(0, 39)}”` : "Choose a Monday board" },
      { type: "keyValue", pairs: [["Next", count ? "Say or type the board name." : "Give the exact board name or ID."]] },
      ...(rows.length ? [{ type: "list", rows }] : []),
    ];
  }
  return [
    {
      type: "header",
      title: (isComments ? `Comments · ${data.itemName}` : isMembers ? `Board members · ${data.boardName}` : isBoards ? "Monday.com boards" : data.boardName ?? "Monday.com items").slice(0, 60),
    },
    rows.length ? { type: "list", rows } : { type: "keyValue", pairs: [["Results", data.message]] },
  ];
}

// Validate every column before executing any write. Keep canonical JSON conversion here.
function normalizeColumns(value: string | Record<string, unknown>, allowEmpty = false): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("column_values must be a valid JSON object keyed by column ID."); }
  const columns = record(parsed);
  if (!columns || (!allowEmpty && !Object.keys(columns).length) || Object.keys(columns).some(key => !key.trim()))
    throw new Error("column_values must be a nonempty JSON object keyed by column ID.");
  return JSON.parse(JSON.stringify(columns));
}
function writeResult(data: Record<string, unknown>, keys: string[], message: string): WriteOutput {
  const target = keys.map(key => record(data[key])).find(Boolean) ?? data;
  if ((typeof target.id !== "string" && typeof target.id !== "number") || !String(target.id).trim())
    throw new Error("Monday.com did not return a confirmed object ID. Check Monday.com before retrying; the write may have completed.");
  return { status: "Success", message, id: String(target.id) };
}
function metadataRows(value: unknown): Record<string, unknown>[] {
  const parsed = z.array(z.record(z.unknown())).safeParse(value);
  if (!parsed.success) throw new Error("Monday.com returned incomplete board or assignment details.");
  return parsed.data;
}

function boardMetadata(data: Record<string, unknown>, boardId: string, field: "groups" | "columns") {
  const boards = Array.isArray(data.boards) ? metadataRows(data.boards) : [];
  const board = boards.find(entry => String(entry.id) === boardId)
    ?? (boards.length === 1 && boards[0].id === undefined ? boards[0] : undefined);
  return metadataRows(board?.[field] ?? data[field]);
}

function settingsFor(column: Record<string, unknown>) {
  const settings = column.settings ?? column.settings_str;
  if (typeof settings !== "string") return record(settings);
  try { return record(JSON.parse(settings)); } catch { return undefined; }
}

function columnLabels(column: Record<string, unknown>) {
  const settings = settingsFor(column);
  const labels = settings?.labels;
  if (Array.isArray(labels)) {
    return metadataRows(labels)
      .filter(label => !label.is_deactivated && !label.is_archived)
      .map(label => ({ id: String(label.id), label: String(label.label ?? label.name ?? "") }));
  }
  const archived = settings?.labels_archived;
  return Object.entries(record(labels) ?? {})
    .filter(([id, label]) => typeof label === "string" &&
      !(Array.isArray(archived) ? archived.some(entry => String(entry) === id) : record(archived)?.[id]))
    .map(([id, label]) => ({ id, label: label as string }));
}

function emptyColumn(value: unknown): boolean {
  if (value == null || (typeof value === "string" && !value.trim())) return true;
  if (Array.isArray(value)) return value.every(emptyColumn);
  const object = record(value);
  return object !== undefined && Object.values(object).every(emptyColumn);
}

function displayColumnValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayColumnValue).join(", ");
  const object = record(value);
  if (object) {
    return Object.entries(object).map(([key, entry]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      return `${label}: ${displayColumnValue(entry)}`;
    }).join("; ");
  }
  if (value === null) return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function displayDate(date: unknown) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

const peopleEntry = z.object({
  id: z.union([id(), z.string().regex(/^\d+$/).transform(Number).pipe(id())]),
  kind: z.enum(["person", "team"]),
}).strict();

function assigneeLookup(lookup: (action: Action, args: Record<string, unknown>) => Promise<Record<string, unknown>>) {
  let users: Promise<Record<string, unknown>[]> | undefined;
  let teams: Promise<Record<string, unknown>[]> | undefined;
  async function listUsers() {
    const usersById = new Map<string, Record<string, unknown>>();
    for (let page = 1; ; page++) {
      const users = records((await lookup("MONDAY_LIST_USERS", { page, limit: 100 })).users);
      if (users.length === 0) break;
      const count = usersById.size;
      for (const user of users) usersById.set(String(user.id), user);
      if (usersById.size === count) throw new Error("Could not finish verifying the Monday.com users.");
    }
    return [...usersById.values()].filter(user => user.enabled !== false && user.is_pending !== true &&
      (user.status == null || String(user.status).toUpperCase() === "ACTIVE"));
  }
  return (kind: "person" | "team") => kind === "person"
    ? (users ??= listUsers())
    : (teams ??= lookup("MONDAY_GET_TEAMS", {}).then(data => records(data.teams)));
}

async function prepareColumn(
  column: Record<string, unknown>,
  value: unknown,
  assignees: (kind: "person" | "team") => Promise<Record<string, unknown>[]>,
): Promise<{ value: unknown; display: string }> {
  const title = String(column.title);
  const data = record(value);
  if (column.type === "status" || column.type === "color") {
    const labels = columnLabels(column);
    const label = typeof value === "string" ? value : data?.label;
    const match = labels.find(entry => typeof label === "string"
      ? entry.label === label : typeof data?.index === "number" && entry.id === String(data.index));
    if (!match?.label) {
      const options = labels.map(entry => entry.label).filter(Boolean).join(", ");
      throw new Error(`Choose an exact status label for "${title}".${options ? ` Available labels: ${options}.` : ""}`);
    }
    const encoded = /^\d+$/.test(match.label) ? { index: Number(match.id) } : { label: match.label };
    if ("index" in encoded && !Number.isSafeInteger(encoded.index))
      throw new Error(`Could not verify the status label ID for "${title}".`);
    return { value: encoded, display: match.label };
  }
  if (column.type === "dropdown") {
    const labels = columnLabels(column);
    const byId = data?.labels === undefined && data?.ids !== undefined;
    const requested = typeof value === "string" ? [value] : data?.labels ?? data?.ids;
    const matches = Array.isArray(requested) ? requested.map(option => labels.find(label =>
      byId ? label.id === String(option) : label.label === option)) : [];
    if (!matches.length || matches.some(match => !match?.label))
      throw new Error(`Choose existing dropdown labels for "${title}". Available labels: ${labels.map(entry => entry.label).join(", ")}.`);
    const names = matches.map(match => match!.label);
    return { value: { labels: names }, display: names.join(", ") };
  }
  if (column.type === "date" || column.type === "timeline") {
    const isTimeline = column.type === "timeline";
    const date = isTimeline ? data?.from : typeof value === "string" ? value : data?.date;
    const from = displayDate(date);
    const to = isTimeline ? displayDate(data?.to) : undefined;
    const time = data?.time;
    if (!from || (isTimeline && (!to || String(date) > String(data?.to))) ||
      (time !== undefined && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)))) {
      throw new Error(`Resolve the date for "${title}" before preparing the item.`);
    }
    return isTimeline
      ? { value: { from: date, to: data?.to }, display: `${from} – ${to}` }
      : { value: { date, ...(time !== undefined ? { time } : {}) }, display: time ? `${from}, ${time}` : from };
  }
  if (column.type === "people") {
    const names = z.array(nonempty()).min(1).safeParse(typeof value === "string" ? [value] : data?.names);
    const entries = z.array(peopleEntry).min(1).safeParse(data?.personsAndTeams);
    if (!names.success && !entries.success)
      throw new Error(`Provide a Monday.com name or ID for "${title}".`);
    const requested = names.success ? names.data : entries.data!;
    const resolved = await Promise.all(requested.map(async entry => {
      if (typeof entry === "string") {
        const users = await assignees("person");
        const exact = users.filter(user => [user.name, user.email].some(value => String(value).toLowerCase() === entry.toLowerCase()));
        const matches = exact.length ? exact : users.filter(user => String(user.name).toLowerCase().includes(entry.toLowerCase()));
        const person = matches.length === 1 ? matches[0] : undefined;
        const id = Number(person?.id);
        const name = displayText(person?.name);
        if (!name || !Number.isSafeInteger(id) || id < 1)
          throw new Error(`Which Monday.com user did you mean by "${entry}" for "${title}"?`);
        return { target: { id, kind: "person" }, name };
      }
      const person = (await assignees(entry.kind)).find(candidate => String(candidate.id) === String(entry.id));
      const name = displayText(person?.name);
      if (!name) throw new Error(`Could not verify the assignee for "${title}".`);
      return { target: entry, name };
    }));
    return { value: { personsAndTeams: resolved.map(entry => entry.target) }, display: resolved.map(entry => entry.name).join(", ") };
  }
  if (column.type === "name") throw new Error("Set the item's name in item_name.");
  return { value, display: displayColumnValue(value) };
}

async function prepareCreateItem(input: CreateItemInput): Promise<PrepareCreateItemOutput | ReadOutput> {
  const requestedColumns = input.column_values === undefined ? undefined
    : Object.entries(normalizeColumns(input.column_values, true)).filter(([, value]) => !emptyColumn(value));
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of createItemDrafts) if (draft.expires <= now) createItemDrafts.delete(key);
  let priorId = input.replaces_draft_id;
  if (!priorId && input.revises_item_name) {
    const matches = [...createItemDrafts].filter(([, draft]) =>
      draft.accountId === accountId && draft.itemName.toLowerCase() === input.revises_item_name?.toLowerCase());
    if (matches.length !== 1)
      throw new Error("Could not identify one pending item by that name. Ask which item to prepare and confirm again.");
    priorId = matches[0][0];
  }
  const prior = priorId ? createItemDrafts.get(priorId) : undefined;
  if (priorId && (!prior || prior.accountId !== accountId))
    throw new Error("The pending item expired or belongs to another account. Prepare it again.");
  if (prior) prior.retired = true;
  const draft_id = randomUUID();
  function replaceDraft(draft: CreateItemDraft) {
    if (priorId && createItemDrafts.get(priorId) !== prior)
      throw new Error("The item already has a newer draft. Review that draft before creating the item.");
    createItemDrafts.set(draft_id, draft);
    if (priorId) createItemDrafts.delete(priorId);
  }
  const name = input.item_name ?? prior?.itemName;
  const retainedBoardId = input.board_name === undefined ? prior?.args?.board_id : undefined;
  const selectedBoardId = input.board_id ?? (retainedBoardId === undefined ? undefined : Number(retainedBoardId));
  const lookup = (action: Action, args: Record<string, unknown>) => executeAction(action, args, accountId);
  const limit = 100;
  const boards = new Map<string, Record<string, unknown>>();
  if (selectedBoardId !== undefined) {
    const cached = recentlyCreatedBoards.get(`${accountId}:${selectedBoardId}`);
    const board = cached && cached.expires > now ? cached.board : await readBoardById(selectedBoardId, accountId);
    if (board) boards.set(String(board.id), board);
  } else {
    for (let page = 1; ; page++) {
      const found = records((await lookup("MONDAY_BOARDS", { state: "active", page, limit })).boards);
      const count = boards.size;
      for (const entry of found) boards.set(String(entry.id), entry);
      if (found.length < limit) break;
      if (boards.size === count) throw new Error("Could not finish checking the Monday.com boards.");
    }
  }
  const available = [...boards.values()].filter(entry => id().safeParse(Number(entry.id)).success && displayText(entry.name));
  const query = input.board_name?.toLowerCase();
  const exact = query ? available.filter(entry => displayText(entry.name)?.toLowerCase() === query) : [];
  const matches = exact.length || !query
    ? exact
    : available.filter(entry => displayText(entry.name)?.toLowerCase().includes(query));
  const board = selectedBoardId === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : available.find(entry => String(entry.id) === String(selectedBoardId));
  if (selectedBoardId !== undefined && (!board || (query && displayText(board.name)?.toLowerCase() !== query)))
    throw new Error("Could not verify the destination Monday.com board. Ask the user to choose it by name.");

  const boardChanged = String(board?.id) !== prior?.args?.board_id;
  const carriedByTitle = !requestedColumns && Boolean(prior?.carriedByTitle || (boardChanged && prior?.columnTitles));
  const carriedGroupByTitle = input.group_id === undefined && Boolean(prior?.carriedGroupByTitle || (boardChanged && prior?.args));
  const carriedColumns = Object.entries(prior?.columns ?? {}).map(([key, value]) => ({
    key: carriedByTitle ? prior?.columnTitles?.[key] ?? key : key,
    value,
    type: prior?.columnTypes?.[key],
  }));
  const columnValues = requestedColumns?.map(([key, value]) => ({ key, value, type: undefined })) ?? carriedColumns;
  if (new Set(columnValues.map(({ key }) => key)).size !== columnValues.length)
    throw new Error("Multiple requested columns share a title. Ask which destination columns to use.");
  const groupInput = input.group_id ?? (!boardChanged ? prior?.groupId : undefined) ?? prior?.groupTitle;
  const draftDetails = { accountId, expires: now + 30 * 60_000 };
  if (!board) {
    const offered = matches.length ? matches : available;
    const question = name ? `Which Monday board should “${name}” go on?` : "Which Monday board should I use?";
    if (name && offered.length) {
      replaceDraft({
        ...draftDetails, itemName: name, groupTitle: groupInput, carriedByTitle, carriedGroupByTitle,
        columns: Object.fromEntries(columnValues.map(({ key, value }) => [key, value])),
        columnTypes: Object.fromEntries(columnValues.map(({ key, type }) => [key, type])),
      });
    }
    return {
      resultType: "board_choices",
      itemName: name,
      status: "Board selection required",
      message: offered.length ? question : `${question} No active boards were returned.`,
      records: offered,
      pagination: {},
      ...(name && offered.length ? { pending_item: { draft_id, item_name: name } } : {}),
    };
  }
  const boardName = displayText(board?.name);
  if (!boardName)
    throw new Error("Could not verify the destination Monday.com board.");
  const boardId = String(board.id);
  const [groups, columns] = await Promise.all([
    Array.isArray(board.groups) ? metadataRows(board.groups) : lookup("MONDAY_LIST_GROUPS", { board_id: boardId })
      .then(data => boardMetadata(data, boardId, "groups")),
    !name || columnValues.length ? lookup("MONDAY_COLUMNS", { board_ids: [boardId] })
      .then(data => boardMetadata(data, boardId, "columns"))
      : [],
  ]);
  const activeGroups = groups.filter(group => !group.archived && !group.deleted);
  if (!name) {
    return {
      status: "Board details", message: `Found groups and columns for "${boardName}".`,
      board: { name: boardName, groups: activeGroups, columns },
    };
  }
  const topGroup = record(board.top_group);
  const positionsKnown = activeGroups.every(group => typeof group.position === "string" &&
    group.position.trim() && Number.isFinite(Number(group.position)));
  if (positionsKnown) activeGroups.sort((a, b) => Number(a.position) - Number(b.position));
  const groupMatches = activeGroups.filter(group => group.title === groupInput);
  const group = groupInput === undefined
    ? (topGroup?.id && !topGroup.archived && !topGroup.deleted ? topGroup : activeGroups[0])
    : (carriedGroupByTitle ? undefined : activeGroups.find(group => group.id === groupInput))
      ?? (groupMatches.length === 1 ? groupMatches[0] : undefined);
  const groupName = displayText(group?.title);
  if (!groupName || typeof group?.id !== "string")
    throw new Error(`Choose a group on "${boardName}". Available groups: ${activeGroups.map(group => group.title).join(", ")}.`);
  const groupChoices = new Map<string, string>();
  for (const activeGroup of activeGroups) {
    const label = displayText(activeGroup.title);
    if (typeof activeGroup.id === "string" && activeGroup.id && label) groupChoices.set(activeGroup.id, label);
  }
  groupChoices.set(group.id, groupName);

  const assignees = assigneeLookup(lookup);
  const rows = await Promise.all(columnValues.map(async ({ key, value, type }) => {
    const matches = columns.filter(column => column.title === key);
    const column = (carriedByTitle ? undefined : columns.find(column => column.id === key))
      ?? (matches.length === 1 ? matches[0] : undefined);
    if (typeof column?.id !== "string" || !displayText(column.title) || column.archived)
      throw new Error(`Could not match column "${key}" on "${boardName}". Ask which column or value to use before proposing the item.`);
    const canonicalType = (value: unknown) => value === "color" ? "status" : value;
    if (type !== undefined && canonicalType(type) !== canonicalType(column.type))
      throw new Error(`Column "${key}" has a different type on "${boardName}". Ask which column or value to use before proposing the item.`);
    const resolved = await prepareColumn(column, value, assignees);
    return { id: column.id, label: String(column.title), type: column.type, ...resolved };
  }));
  if (new Set(rows.map(row => row.id)).size !== rows.length)
    throw new Error("Specify each column only once.");
  const preview = {
    board: boardName,
    groups: Array.from(groupChoices, ([id, label]) => ({ id, label })),
    columns: rows.map(({ label, display }) => ({ label, value: display })),
  };
  const columnsToWrite = Object.fromEntries(rows.map(row => [row.id, row.value]));
  replaceDraft({
    ...draftDetails, preview, itemName: name, groupId: group.id,
    groupTitle: input.group_id !== undefined || prior?.groupTitle !== undefined ? groupName : undefined,
    columns: columnsToWrite, columnTitles: Object.fromEntries(rows.map(row => [row.id, row.label])),
    columnTypes: Object.fromEntries(rows.map(row => [row.id, row.type])),
    args: {
      board_id: boardId,
      ...(rows.length ? { column_values: JSON.stringify(columnsToWrite) } : {}),
    },
  });
  return {
    status: "Ready for confirmation", message: "Use create_item_arguments to show the confirmation card.",
    create_item_arguments: { draft_id, item_name: name, group_id: group.id, preview },
  };
}

function getReviewedDraft(draftId: string) {
  const draft = createItemDrafts.get(draftId);
  if (!draft || draft.retired || draft.expires <= Date.now())
    throw new Error("The item preview changed, expired, or was already used. Prepare it again before creating the item.");
  return draft;
}

async function createItem(input: z.infer<typeof createItemSchema>): Promise<WriteOutput> {
  const draft = getReviewedDraft(input.draft_id);
  if (!draft.args || !isDeepStrictEqual(draft.preview, input.preview))
    throw new Error("The item preview changed. Prepare it again before creating the item.");
  if (!draft.preview?.groups.some(group => group.id === input.group_id))
    throw new Error("Choose an available group from the selected board.");
  createItemDrafts.delete(input.draft_id);
  const data = await executeAction("MONDAY_CREATE_ITEM", {
    ...draft.args, item_name: input.item_name, group_id: input.group_id,
  }, draft.accountId);
  return writeResult(data, ["create_item"], `Created item "${input.item_name}".`);
}
const editableItemTypes = new Set(["name", "status", "color", "dropdown", "people", "date", "timeline", "text", "long_text", "numbers", "checkbox"]);

const readItemForUpdateQuery = `query ReviewItem($itemIds: [ID!]!) {
  items(ids: $itemIds) {
    id name state group { id title }
    board { id name state columns { id title type archived settings capabilities { calculated { function } } } }
    column_values(capabilities: [CALCULATED]) {
      id text value
      ... on BatteryValue { statusIsLeaf: is_leaf }
      ... on NumbersValue { numberIsLeaf: is_leaf }
      ... on DateValue { dateIsLeaf: is_leaf }
      ... on TimelineValue { timelineIsLeaf: is_leaf }
    }
  }
}`;
const saveItemUpdateMutation = `mutation SaveItem($boardId: ID!, $itemId: ID!, $values: JSON!) {
  change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $values) { id }
}`;
const readActiveBoardGroupsQuery = `query ItemMoveDestination($boardIds: [ID!]!) {
  boards(ids: $boardIds) { id name state groups { id title archived deleted } }
}`;
const moveItemMutation = `mutation MoveItem($groupId: String!, $itemId: ID!) {
  move_item_to_group(group_id: $groupId, item_id: $itemId) { id board { id } group { id } }
}`;
const readItemLocationQuery = `query ItemLocation($itemIds: [ID!]!) {
  items(ids: $itemIds) { id state board { id } group { id } }
}`;

async function mondayGraphQL(accountId: string, query: string, variables: Record<string, unknown>) {
  if (disconnecting) throw new Error("Wait for Monday.com to finish disconnecting.");
  const signal = AbortSignal.timeout(12000);
  const state = await load();
  if (state.accountId !== accountId) throw new Error("The Monday.com connection changed. Prepare the changes again.");
  const saved = await account(accountId, signal);
  if (!saved || saved.isDisabled || saved.status !== "ACTIVE")
    throw new Error("The Monday.com connection is inactive. Run Connect Monday.com again.");
  if (disconnecting || (await load()).accountId !== accountId)
    throw new Error("The Monday.com connection changed. Prepare the changes again.");

  let response;
  try {
    response = await api().tools.proxyExecute({
      endpoint: "https://api.monday.com/v2", method: "POST",
      connectedAccountId: accountId, userId: state.userId,
      parameters: [{ in: "header", name: "API-Version", value: "2026-10" }],
      body: { query, variables },
    }, { signal, maxRetries: 0 });
  } catch (error) {
    if (httpStatus(error) === 401)
      throw new Error("Composio rejected the API key configured in Monday.com settings.");
    if (httpStatus(error) === 403)
      throw new Error("Composio denied Proxy Execute. Check the project key's Proxy Execute permission.");
    throw new Error("Could not complete the request through Composio.", { cause: error });
  }
  const envelope = record(response.data);
  if (response.status === 401 || response.status === 403)
    throw new Error("Monday.com denied access. Check the board permissions and the connected account's authorized scopes.");
  const errors = envelope?.errors;
  if (Array.isArray(errors) && errors.length)
    throw providerError(errors.map(error => displayText(record(error)?.message) ?? "Unknown error").join(" "));
  const data = record(envelope?.data);
  if (response.status < 200 || response.status >= 300 || !data || envelope?.error || envelope?.error_message)
    throw new Error(`Monday.com returned an unexpected response (HTTP ${response.status}).`);
  return data;
}

async function readItemForUpdate(accountId: string, itemId: string, boardId?: string) {
  const data = await mondayGraphQL(accountId, readItemForUpdateQuery, { itemIds: [itemId] });
  const item = metadataRows(data.items).find(row => String(row.id) === itemId);
  const board = record(item?.board);
  const itemName = displayText(item?.name);
  const boardName = displayText(board?.name);
  if (!itemName || !boardName || item?.state !== "active" || board?.state !== "active" ||
      !id().safeParse(Number(board.id)).success || (boardId && String(board.id) !== boardId))
    throw new Error("Could not verify the active item on the selected Monday board. Find the item again.");
  const values = new Map(metadataRows(item.column_values).map(row => [String(row.id), row]));
  const columns = metadataRows(board.columns).filter(column =>
    typeof column.id === "string" && displayText(column.title) && !column.archived);
  if (!columns.some(column => column.id === "name")) columns.unshift({ id: "name", title: "Name", type: "name" });
  return { itemName, boardName, boardId: String(board.id), group: record(item.group), columns, values };
}

async function readActiveBoardGroups(accountId: string, boardId: string) {
  const data = await mondayGraphQL(accountId, readActiveBoardGroupsQuery, { boardIds: [boardId] });
  const board = metadataRows(data.boards).find(row => String(row.id) === boardId && row.state === "active");
  const boardName = displayText(board?.name);
  if (!boardName || !Array.isArray(board?.groups)) throw new Error("Could not verify the active Monday board and its groups.");
  const groups = metadataRows(board.groups).filter(row => !row.archived && !row.deleted);
  return { boardName, groups };
}

async function resolveItemMoveGroup(accountId: string, boardId: string, group: string) {
  const { boardName, groups } = await readActiveBoardGroups(accountId, boardId);
  const titles = groups.filter(row => displayText(row.title)?.toLowerCase() === group.toLowerCase());
  const selected = groups.find(row => row.id === group) ?? (titles.length === 1 ? titles[0] : undefined);
  const groupName = displayText(selected?.title);
  if (!groupName || typeof selected?.id !== "string")
    throw new ItemUpdateClarification(`Which group on “${boardName}” should I use? Available groups: ${groups.map(row => row.title).join(", ") || "none"}.`);
  return { groupId: selected.id, groupName };
}

async function moveReviewedItem(accountId: string, boardId: string, itemId: string, destination: ItemMoveDestination) {
  const { groupId, groupName } = destination;
  const current = await resolveItemMoveGroup(accountId, boardId, groupId);
  if (current.groupName !== groupName) throw new Error("The destination group changed after review. Prepare the move again.");
  const readLocation = async () => {
    const data = await mondayGraphQL(accountId, readItemLocationQuery, { itemIds: [itemId] });
    const item = metadataRows(data.items).find(row => String(row.id) === itemId);
    if (item?.state !== "active" || String(record(item.board)?.id) !== boardId)
      throw new Error("Could not verify the item on its original board.");
    return record(item.group)?.id;
  };
  if (await readLocation() !== destination.sourceGroupId)
    throw new Error("The item's group changed after review. Prepare the move again.");
  let moveError: unknown;
  try {
    await mondayGraphQL(accountId, moveItemMutation, { groupId, itemId });
  } catch (error) {
    moveError = error;
  }
  try {
    if (await readLocation() === groupId) return;
  } catch (error) {
    moveError ??= error;
  }
  const detail = moveError instanceof Error ? ` ${moveError.message}` : "";
  throw new Error(`Could not verify the move to “${groupName}”.${detail} Check Monday.com before retrying.`);
}

function isEditableItemColumn(column: Record<string, unknown>, cell?: Record<string, unknown>) {
  if (!editableItemTypes.has(String(column.type))) return false;
  const calculation = record(record(column.capabilities)?.calculated)?.function;
  return !calculation || calculation === "NONE" ||
    [cell?.statusIsLeaf, cell?.numberIsLeaf, cell?.dateIsLeaf, cell?.timelineIsLeaf].includes(true);
}

function storedItemValue(type: string, cell?: Record<string, unknown>) {
  if (!cell || !Object.hasOwn(cell, "value")) throw new Error("Monday.com did not return the current column value.");
  const raw: unknown = typeof cell.value === "string" ? JSON.parse(cell.value) : cell.value;
  const fields = record(raw);
  switch (type) {
    case "status":
    case "color": return fields?.index ?? null;
    case "dropdown": return Array.isArray(fields?.ids) ? fields.ids.map(Number).sort((a, b) => a - b) : [];
    case "people": return raw === null ? [] : metadataRows(fields?.personsAndTeams)
      .map(entry => `${entry.kind}:${entry.id}`).sort();
    case "date": return fields?.date ? { date: fields.date, time: fields.time || null } : null;
    case "timeline": return fields?.from ? { from: fields.from, to: fields.to } : null;
    case "numbers": return raw === null || raw === "" ? null : Number(raw);
    case "checkbox": return fields?.checked === true || fields?.checked === "true";
    case "long_text": return fields?.text ?? "";
    default: return raw ?? "";
  }
}

async function prepareItemChange(
  column: Record<string, unknown>, input: unknown, current: unknown,
  assignees: ReturnType<typeof assigneeLookup>,
): Promise<{ value: unknown; expected: unknown; display: string }> {
  const title = String(column.title);
  const type = String(column.type);
  if (type === "name") {
    const name = nonempty().max(255).safeParse(input);
    if (!name.success) throw new Error("Use an item name between 1 and 255 characters.");
    return { value: name.data, expected: name.data, display: name.data };
  }
  if (input === null) {
    const text = ["text", "long_text"].includes(type);
    const list = ["people", "dropdown"].includes(type);
    return { value: type === "text" ? "" : null,
      expected: type === "checkbox" ? false : text ? "" : list ? [] : null,
      display: type === "checkbox" ? "Unchecked" : "Empty" };
  }
  if (type === "text" || type === "long_text") {
    if (typeof input !== "string" || (type === "long_text" && input.length > 2000))
      throw new Error(`Provide valid text for "${title}".`);
    return { value: type === "long_text" ? { text: input } : input, expected: input, display: input || "Empty" };
  }
  if (type === "numbers") {
    if (typeof input !== "number" || !Number.isFinite(input)) throw new Error(`Provide a number for "${title}".`);
    return { value: String(input), expected: input, display: String(input) };
  }
  if (type === "checkbox") {
    if (typeof input !== "boolean") throw new Error(`Say whether to check or uncheck "${title}".`);
    return { value: input ? { checked: "true" } : null, expected: input, display: input ? "Checked" : "Unchecked" };
  }
  const requested = record(input);
  if (type === "people") {
    const operation = requested?.operation ?? "set";
    if (!["set", "add", "remove"].includes(String(operation))) throw new Error(`Choose set, add, or remove for "${title}".`);
    const resolved = await prepareColumn(column, input, assignees);
    const selected = z.array(peopleEntry).parse(record(resolved.value)?.personsAndTeams);
    const key = (entry: z.infer<typeof peopleEntry>) => `${entry.kind}:${entry.id}`;
    const targets = new Map(selected.map(entry => [key(entry), entry]));
    if (operation !== "set") {
      const existing = z.array(z.string()).parse(current).map(entry => {
        const [kind, id] = entry.split(":");
        const parsed = peopleEntry.safeParse({ kind, id });
        if (!parsed.success) throw new Error(`Could not safely preserve an existing assignee in "${title}".`);
        return parsed.data;
      });
      if (operation === "add") {
        for (const entry of existing) targets.set(key(entry), entry);
      } else {
        const removing = new Set(targets.keys());
        targets.clear();
        for (const entry of existing) if (!removing.has(key(entry))) targets.set(key(entry), entry);
      }
    }
    const max = Number(settingsFor(column)?.max_people_allowed);
    if (max > 0 && targets.size > max) throw new Error(`"${title}" allows up to ${max} assignees.`);
    const people = [...targets.values()];
    const names = await Promise.all(people.map(async entry => {
      const match = (await assignees(entry.kind)).find(candidate => String(candidate.id) === String(entry.id));
      const name = displayText(match?.name);
      if (!name) throw new Error(`Could not verify an existing assignee in "${title}".`);
      return name;
    }));
    return { value: people.length ? { personsAndTeams: people } : null,
      expected: [...targets.keys()].sort(), display: names.join(", ") || "Empty" };
  }
  const resolved = await prepareColumn(column, input, assignees);
  const value = record(resolved.value)!;
  if (type === "status" || type === "color") {
    const matches = columnLabels(column).filter(label => label.label === resolved.display);
    const index = typeof value.index === "number" ? value.index : matches.length === 1 ? Number(matches[0].id) : NaN;
    if (!Number.isSafeInteger(index)) throw new Error(`Could not verify one status label ID for "${title}".`);
    return { value: { index }, expected: index, display: resolved.display };
  }
  if (type === "dropdown") {
    const options = columnLabels(column);
    const labels = z.array(z.string()).parse(value.labels);
    const ids = labels.map(label => {
      const matches = options.filter(option => option.label === label);
      const optionId = matches.length === 1 ? Number(matches[0].id) : NaN;
      if (!Number.isSafeInteger(optionId)) throw new Error(`Could not verify one dropdown label ID for "${title}".`);
      return optionId;
    });
    const unique = [...new Set(ids)].sort((a, b) => a - b);
    return { value: { ids: unique }, expected: unique, display: [...new Set(labels)].join(", ") };
  }
  return { value, expected: type === "date" ? { ...value, time: value.time ?? null } : value,
    display: type === "date" && value.time ? `${resolved.display} UTC` : resolved.display };
}

class ItemUpdateClarification extends Error {}

function matchesName(value: unknown, name: string) {
  return displayText(value)?.toLowerCase() === name.toLowerCase();
}

async function listActiveBoards(accountId: string) {
  const boards = new Map<string, Record<string, unknown>>();
  const limit = 100;
  for (let page = 1; ; page++) {
    const data = await executeAction("MONDAY_BOARDS", { state: "active", page, limit }, accountId);
    const batch = records(data.boards);
    const count = boards.size;
    for (const board of batch) boards.set(String(board.id), board);
    if (batch.length < limit) break;
    if (boards.size === count) throw new Error("Could not finish checking the Monday boards.");
  }
  return [...boards.values()];
}

function matchingBoards<T extends { name?: unknown }>(boards: T[], boardName: string) {
  const exact = boards.filter(board => matchesName(board.name, boardName));
  return exact.length ? exact : boards.filter(board =>
    displayText(board.name)?.toLowerCase().includes(boardName.toLowerCase()));
}

async function findBoardsByName(accountId: string, boardName: string) {
  return matchingBoards(await listActiveBoards(accountId), boardName);
}

async function findItemsOnBoard(accountId: string, boardId: number, itemName?: string) {
  const items = new Map<string, Record<string, unknown>>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await getItems(cursor ? { cursor, limit: 100 } : { board_id: boardId, limit: 100 }, accountId);
    for (const item of result.records) if (!itemName || matchesName(item.name, itemName)) items.set(String(item.id), item);
    cursor = typeof result.pagination.nextCursor === "string" ? result.pagination.nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error("Could not finish checking the Monday items.");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return items;
}

async function findItemForUpdate(accountId: string, boardName: string | undefined, boardId: number | undefined, itemName: string) {
  if (boardId === undefined) {
    if (!boardName) throw new ItemUpdateClarification(`Which Monday board contains “${itemName}”?`);
    const matches = await findBoardsByName(accountId, boardName);
    if (matches.length !== 1)
      throw new ItemUpdateClarification(`Which Monday board did you mean by “${boardName}”?`);
    boardId = id().parse(Number(matches[0].id));
  }
  const items = await findItemsOnBoard(accountId, boardId, itemName);
  if (items.size !== 1)
    throw new ItemUpdateClarification(items.size
      ? `Which “${itemName}” should I update? More than one item on the board has that name.`
      : `I couldn't find “${itemName}” on that board. What's the exact item name?`);
  return { boardId: String(boardId), itemId: items.keys().next().value! };
}

async function prepareUpdateItem(input: z.infer<typeof prepareUpdateItemSchema>): Promise<PrepareUpdateItemOutput> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of updateItemDrafts) if (draft.expires <= now) updateItemDrafts.delete(key);
  const prior = input.replaces_draft_id ? updateItemDrafts.get(input.replaces_draft_id) : undefined;
  if (input.replaces_draft_id && (!prior || prior.accountId !== accountId || prior.revising))
    throw new Error("The pending item update is unavailable. Find the item and prepare the changes again.");
  if (prior && (input.item_id || input.board_id || input.item_name || input.board_name ||
      (input.column_values === undefined && input.destination_group === undefined)))
    throw new Error("Specify a revision to the pending changes or destination and keep the same item.");
  const requested = input.column_values === undefined ? prior?.requested
    : Object.entries(normalizeColumns(input.column_values, Boolean(prior || input.destination_group)));

  if (prior) prior.revising = true;
  try {
    const found = !prior && input.item_id === undefined && input.item_name
      ? await findItemForUpdate(accountId, input.board_name, input.board_id, input.item_name) : undefined;
    const itemId = prior?.itemId ?? found?.itemId ?? (input.item_id === undefined ? undefined : String(input.item_id));
    if (!itemId) throw new ItemUpdateClarification("Which Monday item should I update?");
    const boardId = prior?.boardId ?? found?.boardId ?? (input.board_id === undefined ? undefined : String(input.board_id));
    const current = await readItemForUpdate(accountId, itemId, boardId);
    const requestedGroup = input.destination_group === undefined ? prior?.destination?.groupId : input.destination_group;
    let destination: ItemMoveDestination | undefined;
    if (requestedGroup) {
      const sourceGroupId = current.group?.id;
      const sourceGroupName = displayText(current.group?.title);
      if (typeof sourceGroupId !== "string" || !sourceGroupName) throw new Error("Could not verify the item's current group.");
      const target = await resolveItemMoveGroup(accountId, current.boardId, requestedGroup);
      if (target.groupId !== sourceGroupId) destination = { ...target, sourceGroupId, sourceGroupName };
    }
    const columns = current.columns.filter(column => isEditableItemColumn(column, current.values.get(String(column.id))));
    if (!requested && !requestedGroup) {
      return { status: "Item details", message: "Found the editable columns for this item.",
        update_item_details: { board: current.boardName, item: current.itemName, columns: columns.map(column => ({
          id: String(column.id), title: String(column.title), type: String(column.type),
          labels: columnLabels(column).map(label => label.label),
        })) } };
    }
    const assignees = assigneeLookup((action, args) => executeAction(action, args, accountId));
    const rows = await Promise.all((requested ?? []).map(async ([key, inputValue]) => {
      const exact = columns.find(column => column.id === key);
      const titles = columns.filter(column => String(column.title).toLowerCase() === key.toLowerCase());
      const column = exact ?? (titles.length === 1 ? titles[0] : undefined);
      if (!column) throw new Error(`Could not match one editable column for "${key}" on "${current.boardName}". Ask which field to use.`);
      const id = String(column.id);
      const type = String(column.type);
      const cell = current.values.get(id);
      const before = type === "name" ? current.itemName : storedItemValue(type, cell);
      const change = await prepareItemChange(column, inputValue, before, assignees);
      const beforeDisplay = type === "checkbox" ? before ? "Checked" : "Unchecked"
        : type === "name" ? current.itemName : displayText(cell?.text) ?? "Empty";
      return { id, type, label: String(column.title), before, beforeDisplay, settings: column.settings, ...change };
    }));
    if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error("Specify each column only once.");
    const changes = rows.filter(row => !isDeepStrictEqual(row.before, row.expected));
    if (!changes.length && !destination) {
      if (input.replaces_draft_id) updateItemDrafts.delete(input.replaces_draft_id);
      return { status: "No changes", message: "The item already matches the request." };
    }
    const preview = { board: current.boardName, item: current.itemName,
      changes: [
        ...changes.map(row => ({ label: row.label, before: row.beforeDisplay, after: row.display })),
        ...(destination ? [{
          label: "Group",
          before: destination.sourceGroupName,
          after: destination.groupName,
        }] : []),
      ] };
    const draft_id = randomUUID();
    updateItemDrafts.set(draft_id, {
      accountId, itemId, boardId: current.boardId, preview, changes, destination,
      requested: requested ?? [], expires: Date.now() + 30 * 60_000,
    });
    if (input.replaces_draft_id) updateItemDrafts.delete(input.replaces_draft_id);
    return { status: "Ready for confirmation", message: "Use update_item_arguments to show the confirmation card.",
      update_item_arguments: { draft_id, preview } };
  } catch (error) {
    if (error instanceof ItemUpdateClarification)
      return { status: "Clarification needed", message: error.message, question: error.message };
    throw error;
  } finally {
    if (prior) prior.revising = false;
  }
}

async function updateItemValues(input: z.infer<typeof updateItemValuesSchema>): Promise<WriteOutput> {
  const draft = updateItemDrafts.get(input.draft_id);
  if (!draft || draft.revising || draft.expires <= Date.now() || !isDeepStrictEqual(draft.preview, input.preview))
    throw new Error("The item preview changed, expired, or was already used. Prepare the changes again.");
  const { accountId, itemId, boardId, changes } = draft;
  const lock = `${accountId}:${itemId}`;
  if (savingItems.has(lock)) throw new Error("This item is already being updated. Wait for the result.");
  savingItems.add(lock);
  updateItemDrafts.delete(input.draft_id);
  try {
    const current = await readItemForUpdate(accountId, itemId, boardId);
    if (current.itemName !== draft.preview.item || current.boardName !== draft.preview.board ||
        changes.some(change => {
          const column = current.columns.find(column => column.id === change.id);
          const cell = current.values.get(change.id);
          return !column || !isEditableItemColumn(column, cell) || column.type !== change.type ||
            column.title !== change.label || !isDeepStrictEqual(column.settings, change.settings) ||
            (change.type !== "name" && !isDeepStrictEqual(storedItemValue(change.type, cell), change.before));
        })) throw new Error("The item or board changed since the preview. Prepare and review the changes again.");

    if (changes.length === 0) return await finishItemMove(draft, current.itemName);

    let writeError: unknown;
    try {
      const values = JSON.stringify(Object.fromEntries(changes.map(change => [change.id, change.value])));
      const data = await mondayGraphQL(accountId, saveItemUpdateMutation, { boardId, itemId, values });
      if (String(record(data.change_multiple_column_values)?.id) !== itemId)
        throw new Error("Monday.com returned an unexpected item ID.");
    } catch (error) {
      writeError = error;
    }
    let updated;
    try {
      updated = await readItemForUpdate(accountId, itemId, boardId);
    } catch (error) {
      const detail = writeError instanceof Error ? writeError.message : error instanceof Error ? error.message : "";
      const skipped = draft.destination ? " The group move was skipped." : "";
      throw new Error(`Could not verify the item update.${skipped} ${detail} Check Monday.com before retrying.`);
    }
    const confirmed = changes.filter(change => {
      try {
        const actual = change.type === "name" ? updated.itemName : storedItemValue(change.type, updated.values.get(change.id));
        return isDeepStrictEqual(actual, change.expected);
      } catch { return false; }
    });
    if (confirmed.length !== changes.length) {
      const pending = changes.filter(change => !confirmed.includes(change)).map(change => change.label).join(", ");
      const detail = writeError instanceof Error ? ` ${writeError.message}` : "";
      const skipped = draft.destination ? " The group move was skipped." : "";
      throw new Error(`Verified changes: ${confirmed.map(change => change.label).join(", ") || "none"}. Could not verify: ${pending}.${skipped}${detail} Check Monday.com before retrying.`);
    }
    if (draft.destination) return await finishItemMove(draft, updated.itemName);
    return { status: "Success", message: `Updated ${changes.length} field(s) on “${updated.itemName}”.`,
      id: itemId, completedColumns: changes.map(change => change.id) };
  } finally {
    savingItems.delete(lock);
  }
}

async function finishItemMove(draft: UpdateItemDraft, itemName: string): Promise<WriteOutput> {
  const { accountId, boardId, itemId, destination, changes } = draft;
  if (!destination) throw new Error("The update has no destination.");
  const saved = changes.length ? `Saved ${changes.map(change => change.label).join(", ")} on “${itemName}” before the move. ` : "";
  try {
    await moveReviewedItem(accountId, boardId, itemId, destination);
    return { status: "Success", id: itemId, completedColumns: changes.map(change => change.id),
      message: `${saved}Moved “${itemName}” to group “${destination.groupName}” on “${draft.preview.board}”.` };
  } catch (error) {
    throw new Error(`${saved}${error instanceof Error ? error.message : "Could not verify the group move."}`);
  }
}
async function listWorkspaces(accountId: string) {
  const workspaces = new Map<number, string>();
  const seen = new Set<string>();
  const limit = 100;
  for (let page = 1; ; page++) {
    const data = await executeAction("MONDAY_GET_WORKSPACES", { page, limit }, accountId);
    const rows = records(data.workspaces);
    const count = seen.size;
    for (const row of rows) {
      seen.add(String(row.id));
      const workspaceId = Number(row.id);
      const name = displayText(row.name);
      if (id().safeParse(workspaceId).success && name && row.state !== "archived" && row.state !== "deleted") {
        workspaces.set(workspaceId, name);
      }
    }
    if (rows.length < limit) return workspaces;
    if (seen.size === count) throw new Error("Could not finish checking the Monday.com workspaces.");
  }
}

async function prepareCreateBoard(input: z.infer<typeof prepareCreateBoardSchema>): Promise<PrepareCreateBoardOutput> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of createBoardDrafts) if (draft.expires <= now) createBoardDrafts.delete(key);
  const { replaces_draft_id: requestedDraftId, ...changes } = input;
  let prior = requestedDraftId ? createBoardDrafts.get(requestedDraftId) : undefined;
  while (prior?.accountId === accountId && prior.replacedBy) {
    prior = createBoardDrafts.get(prior.replacedBy);
  }
  if (requestedDraftId && prior?.accountId !== accountId) {
    return {
      board_draft_status: "unavailable",
      message: "The draft reference is unavailable. If the conversation confirms the board is still pending, prepare it again with the known details and this edit. Otherwise clarify which board or item the user means.",
    };
  }
  if (prior?.submission) {
    const messages = {
      created: "This draft already created a board. Continue the pending item step if requested. Do not start another board for this edit.",
      submitting: "This board is being created. Wait for the creation result before continuing.",
      unconfirmed: "This board creation was submitted and the result is unconfirmed. Check Monday.com before offering another create.",
    };
    return { board_draft_status: prior.submission, message: messages[prior.submission] };
  }
  const request = { ...prior?.request, ...changes };
  if (prior) prior.confirmation = undefined;
  const draftId = randomUUID();
  function saveDraft(confirmation?: CreateBoardDraft["confirmation"]) {
    if (prior?.replacedBy) {
      throw new Error("The board already has a newer draft. Use that draft for any further changes.");
    }
    createBoardDrafts.set(draftId, { accountId, request, confirmation, expires: now + 30 * 60_000 });
    if (prior) prior.replacedBy = draftId;
  }
  function ask(message: string): PrepareCreateBoardOutput {
    saveDraft();
    return { message, pending_board: { draft_id: draftId, ...request } };
  }
  if (!request.board_name) return ask("What should the board be named?");
  let workspaces: Map<number, string>;
  let workspaceNotice: string | undefined;
  try {
    workspaces = await listWorkspaces(accountId);
  } catch (error) {
    if (request.workspace || !(error instanceof Error) || !/scope|permission|access was denied/i.test(error.message)) throw error;
    workspaces = new Map();
    workspaceNotice = "Workspace choices are unavailable with this Monday.com connection.";
  }
  const choices = [{ value: "default", label: "Default workspace" }];
  const workspaceIds = new Map<string, number>();
  const matches: string[] = [];
  const requested = request.workspace?.toLowerCase();
  for (const [workspaceId, name] of workspaces) {
    const value = String(choices.length);
    choices.push({ value, label: name });
    workspaceIds.set(value, workspaceId);
    if (name.toLowerCase() === requested) matches.push(value);
  }
  if (requested && matches.length !== 1) {
    const issue = matches.length ? "Multiple workspaces match" : "No workspace matches";
    const names = [...new Set(workspaces.values())].slice(0, 10);
    const available = names.length ? ` Available workspaces include ${names.join(", ")}.` : "";
    return ask(`${issue} "${request.workspace}". Which workspace should I use? You can choose the default workspace.${available}`);
  }
  const args: CreateBoardInput = {
    draft_id: draftId,
    board_name: request.board_name,
    board_kind: request.board_kind ?? "public",
    description: request.description ?? "",
    workspace_choice: matches[0] ?? "default",
    workspace_choices: choices,
    ...(workspaceNotice ? { workspace_notice: workspaceNotice } : {}),
  };
  saveDraft({ args, workspaceIds });
  return { message: "Use create_board_arguments to show the confirmation card.", create_board_arguments: args };
}

const createGroupMutation = `mutation CreateGroup($boardId: ID!, $name: String!, $method: PositionRelative!, $relativeTo: String) {
  create_group(board_id: $boardId, group_name: $name, position_relative_method: $method, relative_to: $relativeTo) {
    id title
  }
}`;

async function prepareCreateGroup(input: z.infer<typeof prepareCreateGroupSchema>): Promise<PrepareCreateGroupOutput> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of createGroupDrafts) if (draft.expires <= now) createGroupDrafts.delete(key);
  const { replaces_draft_id: replaces, ...changes } = input;
  const prior = replaces ? createGroupDrafts.get(replaces) : undefined;
  if (replaces && (!prior || prior.accountId !== accountId || prior.revising))
    throw new Error("The group draft changed, expired, or was already used. Prepare a new draft if the group is still pending.");
  if (changes.board_id !== undefined && changes.board_name !== undefined)
    throw new Error("Choose the board by name or by ID.");
  if (changes.position?.reference_group && (changes.position.placement === "top" || changes.position.placement === "bottom"))
    throw new Error("A reference group is only used with Before or After.");
  if (prior) prior.revising = true;
  const request = { ...prior?.request, ...changes };
  if (changes.board_name !== undefined) delete request.board_id;
  if (changes.board_id !== undefined) delete request.board_name;
  if ((changes.board_name !== undefined || changes.board_id !== undefined) && changes.position === undefined) {
    const position = prior?.request.position;
    const reference = position && prior?.confirmation?.positions.get(`${position.placement}:${position.reference_group}`)?.reference;
    if (position && reference) request.position = { ...position, reference_group: reference.title };
  }

  const draftId = randomUUID();
  function save(confirmation?: CreateGroupDraft["confirmation"]) {
    if (replaces) createGroupDrafts.delete(replaces);
    createGroupDrafts.set(draftId, { accountId: accountId!, expires: Date.now() + 30 * 60_000, request, confirmation });
  }
  function ask(question: string): PrepareCreateGroupOutput {
    save();
    return { question, pending_group: { draft_id: draftId } };
  }

  try {
    if (request.board_id === undefined && !request.board_name)
      return ask("Which Monday board should I add the group to?");
    if (!request.group_name) return ask("What should I call the new group?");
    if (request.board_id === undefined) {
      const matches = await findBoardsByName(accountId, request.board_name!);
      if (matches.length !== 1) return ask(`Which Monday board did you mean by “${request.board_name}”? Give its exact name or choose a specific board.`);
      request.board_id = id().parse(Number(matches[0].id));
    }
    const boardId = String(request.board_id);
    const { boardName, groups } = await readActiveBoardGroups(accountId, boardId);
    const { placement, reference_group: reference } = request.position ?? { placement: "bottom" };
    const positions = new Map<string, GroupPlacement>([
      ["bottom", { method: "before_at" }],
      ["top", { method: "after_at" }],
    ]);
    const options = [{ value: "bottom", label: "Bottom of board" }, { value: "top", label: "Top of board" }];
    const references = groups.flatMap(group => {
      const title = displayText(group.title);
      return typeof group.id === "string" && group.id && title ? [{ id: group.id, title }] : [];
    });
    for (const group of references) {
      for (const direction of ["before", "after"] as const) {
        const value = `${direction}:${group.id}`;
        positions.set(value, { method: direction === "before" ? "before_at" : "after_at", reference: group });
        options.push({ value, label: `${direction === "before" ? "Before" : "After"} ${group.title}` });
      }
    }
    let position: string = placement;
    if (placement === "before" || placement === "after") {
      const exact = references.filter(group => reference && matchesName(group.title, reference));
      const group = references.find(group => group.id === reference) ?? (exact.length === 1 ? exact[0] : undefined);
      if (!group) return ask(`Which group on “${boardName}” should I place it ${placement}? ${references.length
        ? `Available groups: ${references.map(group => group.title).join(", ")}.`
        : "Choose the top or bottom of the board."}`);
      position = `${placement}:${group.id}`;
      request.position = { placement, reference_group: group.id };
    }
    const preview = { board: boardName, positions: options };
    save({ boardId, preview, positions });
    return { create_group_arguments: { draft_id: draftId, group_name: request.group_name, position, preview } };
  } finally {
    if (prior) prior.revising = false;
  }
}

async function createGroup(input: CreateGroupInput): Promise<WriteOutput & { groupName: string; boardId: string; boardName: string }> {
  const draft = createGroupDrafts.get(input.draft_id);
  const reviewed = draft?.confirmation;
  if (!draft || !reviewed || draft.revising || draft.expires <= Date.now())
    throw new Error("The group draft changed, expired, or was already used. Review a current confirmation.");
  const placement = reviewed.positions.get(input.position);
  if (!placement || !isDeepStrictEqual(input.preview, reviewed.preview))
    throw new Error("Choose a position from the current Create group confirmation.");
  createGroupDrafts.delete(input.draft_id);

  const { boardId } = reviewed;
  const { boardName, groups } = await readActiveBoardGroups(draft.accountId, boardId);
  const { reference } = placement;
  if (boardName !== reviewed.preview.board || (reference && !groups.some(group =>
    group.id === reference.id && displayText(group.title) === reference.title)))
    throw new Error("The board or reference group changed after review. Prepare the group again.");

  let created;
  try {
    const data = await mondayGraphQL(draft.accountId, createGroupMutation, {
      boardId, name: input.group_name, method: placement.method, relativeTo: reference?.id ?? null,
    });
    created = record(data.create_group);
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Could not confirm group creation.${detail} Check Monday.com before retrying.`);
  }
  const groupId = displayText(created?.id);
  if (!groupId) throw new Error("Monday.com did not return a group ID. Check Monday.com before retrying.");
  const groupName = displayText(created?.title) ?? input.group_name;
  return { status: "Group created", message: `Created “${groupName}” on “${boardName}”.`, id: groupId, groupName, boardId, boardName };
}

async function readBoardById(boardId: number, accountId: string) {
  const data = await executeAction("MONDAY_BOARDS", { ids: [boardId], state: "active", limit: 1, page: 1 }, accountId);
  return records(data.boards).find(board => String(board.id) === String(boardId));
}

function boardActionTarget(board: Record<string, unknown>): BoardActionTarget | undefined {
  const boardId = String(board.id);
  const name = displayText(board.name);
  if (!/^[1-9]\d*$/.test(boardId) || !id().safeParse(Number(boardId)).success || !name ||
      (board.state != null && board.state !== "active")) return;
  const workspace = record(board.workspace);
  return {
    id: boardId, name,
    workspaceId: String(workspace?.id ?? board.workspace_id ?? ""),
    workspaceName: displayText(workspace?.name) ?? "",
  };
}

async function findMembershipBoard(input: z.infer<typeof listBoardMembersSchema>, accountId: string):
  Promise<{ board: Record<string, unknown>; target: BoardActionTarget } | MembershipQuestion> {
  const { board_name, workspace_name, board_id } = input;
  const boards = (await listActiveBoards(accountId)).filter(board => {
    const target = boardActionTarget(board);
    return target && (board_id === undefined || Number(target.id) === board_id) &&
      (!workspace_name || matchesName(target.workspaceName || "Main workspace", workspace_name));
  });
  const matches = matchingBoards(boards, board_name);
  if (matches.length === 1) return { board: matches[0], target: boardActionTarget(matches[0])! };
  if (!matches.length) return { question: `I couldn't find an active board named “${board_name}”${workspace_name ? ` in “${workspace_name}”` : ""}. Which board did you mean?` };
  const choices = matches.map(board => {
    const target = boardActionTarget(board)!;
    return { board_id: Number(target.id), board_name: target.name, workspace_name: target.workspaceName || "Main workspace" };
  });
  const labels = choices.map(choice => `${choice.board_name} in ${choice.workspace_name}`);
  const distinctLabels = labels.map((label, index) =>
    labels.indexOf(label) === labels.lastIndexOf(label) ? label : `${label} (board ${choices[index].board_id})`);
  return { question: `Which board did you mean? I found ${distinctLabels.join(", ")}.`, matching_boards: choices };
}

function boardMembers(board: Record<string, unknown>) {
  const members = new Map<number, { id: number; name: string; role: MemberRole }>();
  if (!Array.isArray(board.owners) || !Array.isArray(board.subscribers))
    throw new Error("Monday.com did not return both board owners and subscribers. Board membership could not be verified.");
  for (const role of ["subscriber", "owner"] as const) {
    for (const row of records(role === "owner" ? board.owners : board.subscribers)) {
      const memberId = Number(row.id);
      if (!id().safeParse(memberId).success) throw new Error("Monday.com returned an invalid board member ID.");
      members.set(memberId, { id: memberId, name: String(row.name), role });
    }
  }
  return members;
}

const boardMembershipQuery = `query BoardMembership($boardIds: [ID!]!) {
  boards(ids: $boardIds, state: active) {
    id
    owners { id name }
    subscribers { id name }
  }
}`;

async function readBoardMembers(board: Record<string, unknown>, boardId: number, accountId: string) {
  if (Array.isArray(board.owners) && Array.isArray(board.subscribers)) return boardMembers(board);
  const data = await mondayGraphQL(accountId, boardMembershipQuery, { boardIds: [String(boardId)] });
  const current = metadataRows(data.boards).find(row => String(row.id) === String(boardId));
  return boardMembers(current ?? board);
}

async function listBoardMembers(input: z.infer<typeof listBoardMembersSchema>): Promise<ReadOutput | MembershipQuestion> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const found = await findMembershipBoard(input, accountId);
  if ("question" in found) return found;
  const membership = await readBoardMembers(found.board, Number(found.target.id), accountId);
  const members = [...membership.values()].sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  const boardName = found.target.name;
  const owners = members.filter(member => member.role === "owner").length;
  const subscribers = members.length - owners;
  return {
    resultType: "board_members", boardName, status: "Success",
    message: `“${boardName}” has ${owners} ${owners === 1 ? "owner" : "owners"} and ${subscribers} direct ${subscribers === 1 ? "subscriber" : "subscribers"}.`,
    records: members, pagination: {},
  };
}

async function mondayActor(accountId: string) {
  const data = await executeAction("MONDAY_GET_ME", {}, accountId);
  const actor = id().safeParse(Number(record(data.me)?.id ?? data.id));
  if (!actor.success) throw new Error("Could not verify the connected Monday.com user's identity.");
  return actor.data;
}

type CommentItemInput = z.infer<typeof getCommentsSchema>;
type CommentItem = { id: number; name: string; boardId: string; boardName: string; groupName?: string };
type Comment = {
  id: number;
  text: string;
  body: string;
  author: string | null;
  creatorId: number | null;
  createdAt: string | null;
};
type CommentThread = Comment & { replies: Comment[] };
type CommentOperation = z.infer<typeof commentOperation>;
type CommentQuestion = {
  question: string;
  choices?: { id?: number; label: string; created_at?: string | null }[];
  remaining_choices?: number;
  next_item_choices_arguments?: CommentItemInput;
  _voiceos_glance?: { blocks: [
    { type: "header"; title: string },
    { type: "list"; rows: { title: string }[] },
  ] };
  resolved_scope?: { board_id: number; group_name?: string };
};
type CommentPreview = z.infer<typeof createCommentSchema> | z.infer<typeof editCommentSchema> | z.infer<typeof deleteCommentSchema>;
type CommentPreparation = CommentQuestion
  | { create_comment_arguments: z.infer<typeof createCommentSchema> }
  | { edit_comment_arguments: z.infer<typeof editCommentSchema> }
  | { delete_comment_arguments: z.infer<typeof deleteCommentSchema> };
const commentDrafts = new Map<string, {
  operation: CommentOperation;
  accountId: string;
  expires: number;
  item: CommentItem;
  args: CommentPreview;
  target?: Comment;
  actorId?: number;
  replyCount?: number;
}>();

async function readCommentItem(accountId: string, itemId: number): Promise<CommentItem> {
  const data = await mondayGraphQL(accountId, `query CommentItem($ids: [ID!]!) {
    items(ids: $ids) { id name state board { id name state } group { title } }
  }`, { ids: [String(itemId)] });
  const row = metadataRows(data.items).find(item => String(item.id) === String(itemId));
  const board = record(row?.board);
  const name = displayText(row?.name);
  const boardId = id().safeParse(Number(board?.id));
  if (!name || !boardId.success || (row?.state && row.state !== "active") || (board?.state && board.state !== "active"))
    throw new Error("Could not verify an active Monday.com item. Find the item again.");
  const boardName = displayText(board?.name) ?? displayText((await listActiveBoards(accountId))
    .find(entry => String(entry.id) === String(boardId.data))?.name);
  if (!boardName) throw new Error("Could not verify the item's Monday.com board.");
  const groupName = displayText(record(row?.group)?.title);
  return { id: itemId, name, boardId: String(boardId.data), boardName, groupName };
}

async function resolveCommentItem(accountId: string, input: CommentItemInput): Promise<CommentItem | CommentQuestion> {
  const offset = input.item_choices_offset ?? 0;
  if (offset && (!input.board_id || input.item_id || input.page !== undefined))
    throw new Error("Use the next item choices arguments from the previous comment result.");
  async function verifyItem(itemId: number, boardId?: number) {
    const item = await readCommentItem(accountId, itemId);
    if ((input.item_name && !matchesName(item.name, input.item_name)) ||
        (boardId && item.boardId !== String(boardId)) ||
        (input.board_name && !matchingBoards([{ name: item.boardName }], input.board_name).length) ||
        (input.group_name && !matchesName(item.groupName, input.group_name)))
      return { question: "The item, board, or group references don't match. Which item should I use?" };
    return item;
  }
  if (input.item_id) return verifyItem(input.item_id, input.board_id);

  const boards = await listActiveBoards(accountId);
  const namedBoards = input.board_name ? matchingBoards(boards, input.board_name) : boards;
  const candidates = input.board_id ? namedBoards.filter(board => String(board.id) === String(input.board_id)) : namedBoards;
  if (candidates.length !== 1) return {
    question: candidates.length ? "Which Monday.com board do you mean?" : "I couldn't find that board. Which Monday.com board should I use?",
    choices: (candidates.length ? candidates : boards).slice(0, readPreviewLimit)
      .map(board => ({ id: id().parse(Number(board.id)), label: String(board.name) })),
  };
  const board = candidates[0];
  const boardId = id().parse(Number(board.id));
  const items = [...(await findItemsOnBoard(accountId, boardId, input.item_name)).values()]
    .filter(item => !item.state || item.state === "active");
  const groupTitle = (item: Record<string, unknown>) => displayText(record(item.group)?.title);
  if ((items.length > 1 || input.group_name) && items.some(item => !groupTitle(item))) {
    const titles = new Map<string, Record<string, unknown>>();
    for (let offset = 0; offset < items.length; offset += 100) {
      const ids = items.slice(offset, offset + 100).map(item => String(item.id));
      const result = await mondayGraphQL(accountId, `query CommentItemGroups($ids: [ID!]!) {
        items(ids: $ids) { id state group { id title } }
      }`, { ids });
      for (const row of metadataRows(result.items)) titles.set(String(row.id), row);
    }
    for (let index = items.length - 1; index >= 0; index--) {
      const row = titles.get(String(items[index].id));
      if (!row || (row.state && row.state !== "active")) items.splice(index, 1);
      else items[index] = { ...items[index], group: row.group };
    }
  }
  const groupNames = [...new Set(items.map(groupTitle).filter((name): name is string => Boolean(name)))];
  const scoped = input.group_name ? items.filter(item => matchesName(groupTitle(item), input.group_name!)) : items;
  const resolved = { board_id: boardId };
  if (!scoped.length) return {
    question: input.group_name && items.length ? `I couldn't find a matching item in “${input.group_name}”. Which group should I use?`
      : `Which item on “${board.name}” should I use? I couldn't find a matching item.`,
    ...(input.group_name && groupNames.length ? { choices: groupNames.slice(0, readPreviewLimit).map(label => ({ label })) } : {}),
    resolved_scope: resolved,
  };
  if (!input.group_name && groupNames.length > 1) return {
    question: `Which group on “${board.name}” do you mean?`,
    choices: groupNames.slice(0, readPreviewLimit).map(label => ({ label })),
    resolved_scope: resolved,
  };
  if (offset >= scoped.length) return {
    question: `There are no more matching items on “${board.name}”. Which item should I use?`,
    resolved_scope: { ...resolved, group_name: input.group_name ?? groupNames[0] },
  };
  if (offset || scoped.length > 1) {
    const question = `Which item on “${board.name}” do you mean?`;
    const limit = scoped.length - offset > readPreviewLimit ? readPreviewLimit - 1 : readPreviewLimit;
    const choices = scoped.slice(offset, offset + limit).map(item => ({ id: id().parse(Number(item.id)), label: String(item.name) }));
    const nextOffset = offset + choices.length;
    const remaining = scoped.length - nextOffset;
    const resolved_scope = { ...resolved, group_name: input.group_name ?? groupNames[0] };
    const rows = choices.map(({ label }) => ({ title: label }));
    if (remaining) rows.push({ title: `and ${remaining} more` });
    return {
      question, choices, resolved_scope,
      ...(remaining ? {
        remaining_choices: remaining,
        next_item_choices_arguments: { ...resolved_scope, item_name: input.item_name, limit: input.limit, item_choices_offset: nextOffset },
      } : {}),
      ...(remaining || offset ? { _voiceos_glance: { blocks: [
        { type: "header", title: question },
        { type: "list", rows },
      ] } } : {}),
    };
  }
  return verifyItem(id().parse(Number(scoped[0].id)), boardId);
}

function readComment(row: Record<string, unknown>): Comment {
  const commentId = id().parse(Number(row.id));
  const creator = record(row.creator);
  const creatorId = id().safeParse(Number(row.creator_id ?? creator?.id));
  const body = typeof row.body === "string" ? row.body : row.text_body;
  if (typeof body !== "string") throw new Error("Monday.com returned a comment without its text.");
  return {
    id: commentId, body, text: typeof row.text_body === "string" ? row.text_body : body,
    author: displayText(creator?.name) ?? null, creatorId: creatorId.success ? creatorId.data : null,
    createdAt: displayText(row.created_at) ?? null,
  };
}

const readCommentPageQuery = `query ItemCommentThreads($ids: [ID!]!, $page: Int!, $limit: Int!) {
  items(ids: $ids) {
    id
    updates(page: $page, limit: $limit) {
      id body text_body created_at creator { id name }
      replies { id body text_body created_at creator { id name } }
    }
  }
}`;

async function readCommentPage(accountId: string, itemId: number, page: number, limit: number): Promise<CommentThread[]> {
  const data = await mondayGraphQL(accountId, readCommentPageQuery, { ids: [String(itemId)], page, limit });
  const item = metadataRows(data.items).find(row => String(row.id) === String(itemId));
  const updates = item?.updates;
  if (!Array.isArray(updates)) throw new Error("Monday.com returned an unexpected comment page.");
  return metadataRows(updates).map(row => ({
    ...readComment(row),
    replies: row.replies === null ? [] : metadataRows(row.replies).map(readComment),
  }));
}

async function getComments(input: CommentItemInput): Promise<(ReadOutput & { item_id: number }) | CommentQuestion> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const item = await resolveCommentItem(accountId, input);
  if ("question" in item) return item;
  const { page = 1, limit = 25 } = input;
  const threads = await readCommentPage(accountId, item.id, page, limit);
  const summarize = (comment: Comment) => ({
    id: comment.id, text: comment.text, author: comment.author, created_at: comment.createdAt,
  });
  return {
    resultType: "comments", status: "Comments", item_id: item.id, itemName: item.name, boardName: item.boardName,
    message: threads.length ? `Found ${threads.length} comment ${threads.length === 1 ? "thread" : "threads"} on “${item.name}”.`
      : `No comment threads found on this page for “${item.name}”.`,
    records: threads.map(thread => ({ ...summarize(thread), replies: thread.replies.map(summarize) })),
    pagination: { page, limit, nextPage: threads.length === limit ? page + 1 : null },
  };
}

async function findComments(accountId: string, itemId: number, targetId?: number) {
  const seen = new Set<number>();
  const matches: { comment: Comment; thread: CommentThread }[] = [];
  const limit = 100;
  for (let page = 1; ; page++) {
    const threads = await readCommentPage(accountId, itemId, page, limit);
    const priorSize = seen.size;
    for (const thread of threads) {
      for (const comment of [thread, ...thread.replies]) {
        if (seen.has(comment.id)) continue;
        seen.add(comment.id);
        if (targetId === comment.id) return [{ comment, thread }];
        if (targetId === undefined) matches.push({ comment, thread });
      }
    }
    if (threads.length < limit) return matches;
    if (seen.size === priorSize) throw new Error("Could not finish checking the Monday.com comment pages.");
  }
}

async function prepareComment(input: z.infer<typeof prepareCommentSchema>): Promise<CommentPreparation> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  for (const [key, draft] of commentDrafts) if (draft.expires <= Date.now()) commentDrafts.delete(key);
  if (input.replaces_draft_id) {
    const prior = commentDrafts.get(input.replaces_draft_id);
    if (!prior || prior.accountId !== accountId || prior.operation !== input.operation)
      throw new Error("The comment draft expired or was already used. Prepare a fresh confirmation.");
    commentDrafts.delete(input.replaces_draft_id);
  }
  const { operation, body, comment_id, comment_text, latest } = input;
  if (operation !== "delete" && body === undefined) return { question: "What exact text should the comment say?" };
  const selectors = [comment_id, comment_text, latest].filter(value => value !== undefined).length;
  if (selectors > 1) throw new Error("Select the comment using one of its ID, quoted text, or most recent position.");
  if (operation !== "create" && !selectors) return { question: "Which of your comments do you mean?" };
  const item = await resolveCommentItem(accountId, input);
  if ("question" in item) return item;
  const actorId = operation === "create" ? undefined : await mondayActor(accountId);
  let target: Comment | undefined;
  let replyCount: number | undefined;
  if (selectors) {
    const candidates = await findComments(accountId, item.id, comment_id);
    let matches = candidates.filter(({ comment }) => actorId === undefined || comment.creatorId === actorId);
    if (operation === "create" && (comment_text || latest)) matches = matches.filter(({ comment, thread }) => comment.id === thread.id);
    if (comment_text) {
      const query = comment_text.toLowerCase();
      const exact = matches.filter(({ comment }) => comment.text.trim().toLowerCase() === query);
      matches = exact.length ? exact : matches.filter(({ comment }) => comment.text.toLowerCase().includes(query));
    }
    if (latest && matches.length > 1 && matches.every(({ comment }) => Number.isFinite(Date.parse(comment.createdAt ?? "")))) {
      const newest = Math.max(...matches.map(({ comment }) => Date.parse(comment.createdAt!)));
      matches = matches.filter(({ comment }) => Date.parse(comment.createdAt!) === newest);
    }
    if (!matches.length) return { question: actorId === undefined
      ? "I couldn't find that comment on this item. Which thread should I reply to?"
      : "I couldn't verify a matching comment you wrote on this item. Which of your comments did you mean?" };
    if (matches.length > 1) return {
      question: "More than one comment matches. Which one do you mean?",
      choices: matches.slice(0, readPreviewLimit).map(({ comment }) => ({
        id: comment.id, label: comment.text.slice(0, 160), created_at: comment.createdAt,
      })),
    };
    const { comment, thread } = matches[0];
    if (comment.id !== thread.id) {
      if (operation !== "create") throw new Error("VoiceOS can edit or delete top-level comments. Use Monday.com to change a reply.");
      return { question: "Which top-level comment should this reply appear under?" };
    }
    target = readCommentSnapshot(comment);
    if (operation === "delete") replyCount = thread.replies.length;
  }
  const common = { draft_id: randomUUID(), item: `${item.name} · ${item.boardName}` };
  const preparation: CommentPreparation = operation === "create"
    ? { create_comment_arguments: { ...common, body: body!, ...(target ? { parent: target.text } : {}) } }
    : operation === "edit" ? { edit_comment_arguments: { ...common, old_body: target!.text, body: body! } }
    : { delete_comment_arguments: {
        ...common, old_body: target!.text, author: target!.author ?? "Connected Monday.com user",
        ...(replyCount ? { reply_warning: `This thread contains ${replyCount} ${replyCount === 1 ? "reply" : "replies"} that may also be removed.` } : {}),
      } };
  const args = "create_comment_arguments" in preparation ? preparation.create_comment_arguments
    : "edit_comment_arguments" in preparation ? preparation.edit_comment_arguments : preparation.delete_comment_arguments;
  commentDrafts.set(common.draft_id, { accountId, item, operation, args, target, actorId, replyCount, expires: Date.now() + 30 * 60_000 });
  return preparation;
}

function readCommentSnapshot({ id, text, body, author, creatorId, createdAt }: Comment): Comment {
  return { id, text, body, author, creatorId, createdAt };
}

async function applyComment(operation: CommentOperation, input: CommentPreview): Promise<WriteOutput> {
  const draft = commentDrafts.get(input.draft_id);
  if (!draft || draft.operation !== operation || draft.expires <= Date.now() || !isDeepStrictEqual(input, draft.args))
    throw new Error("The comment confirmation changed, expired, or was already used. Review a fresh confirmation.");
  commentDrafts.delete(input.draft_id);
  const { accountId, target, actorId } = draft;
  const item = await readCommentItem(accountId, draft.item.id);
  if (!isDeepStrictEqual(item, draft.item)) throw new Error("The item changed. Review a fresh comment confirmation.");
  if (actorId !== undefined && await mondayActor(accountId) !== actorId)
    throw new Error("The connected Monday.com user changed. Review a fresh confirmation.");
  if (target) {
    const [current] = await findComments(accountId, item.id, target.id);
    if (!current || current.comment.id !== current.thread.id ||
        !isDeepStrictEqual(readCommentSnapshot(current.comment), target) ||
        (draft.replyCount !== undefined && draft.replyCount !== current.thread.replies.length))
      throw new Error("The selected comment or thread changed. Review a fresh confirmation.");
  }
  if (operation === "delete") {
    const result = writeResult(await executeAction("MONDAY_DELETE_UPDATE", { update_id: target!.id }, accountId), ["delete_update"], "Deleted comment.");
    if (result.id !== String(target!.id)) throw new Error("Monday.com did not confirm deletion of the selected comment. Check Monday.com before retrying.");
    return result;
  }
  const body = (draft.args as z.infer<typeof createCommentSchema>).body
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replace(/\r\n|\r|\n/g, "<br>");
  if (operation === "edit") {
    const result = writeResult(await executeAction("MONDAY_EDIT_UPDATE", { id: target!.id, body }, accountId), ["edit_update"], "Edited comment.");
    if (result.id !== String(target!.id)) throw new Error("Monday.com did not confirm editing the selected comment. Check Monday.com before retrying.");
    return result;
  }
  const data = await executeAction("MONDAY_CREATE_UPDATE", { item_id: item.id, body, ...(target ? { parent_id: target.id } : {}) }, accountId);
  return writeResult(data, ["create_update"], target ? "Posted reply." : "Posted comment.");
}

async function prepareManageUsers(input: z.infer<typeof prepareManageUsersSchema>): Promise<MembershipPreparation | MembershipResult> {
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  for (const [key, draft] of membershipDrafts) {
    if (draft.expires <= Date.now()) membershipDrafts.delete(key);
  }
  if (input.replaces_draft_id) {
    if (membershipDrafts.get(input.replaces_draft_id)?.accountId !== accountId)
      throw new Error("The board membership draft expired or was already used. Prepare a new confirmation.");
    membershipDrafts.delete(input.replaces_draft_id);
  }
  const removing = input.operation === "remove";
  if (removing && input.people.some(person => person.role !== undefined))
    throw new Error("For removals, provide the people to remove. Monday supplies their current roles.");
  const found = await findMembershipBoard(input, accountId);
  if ("question" in found) return found;
  const members = await readBoardMembers(found.board, Number(found.target.id), accountId);
  const actorId = removing ? await mondayActor(accountId) : undefined;
  const directory = await assigneeLookup((action, args) => executeAction(action, args, accountId))("person");
  const resolved = new Map<number, MemberChange>();
  for (const { person, role = "subscriber" } of input.people) {
    const self = removing && /^(?:me|myself)$/i.test(person);
    const exact = directory.filter(user => self ? Number(user.id) === actorId
      : matchesName(user.name, person) || matchesName(user.email, person));
    const matches = exact.length || self || person.includes("@") ? exact : directory.filter(user =>
      displayText(user.name)?.toLowerCase().includes(person.toLowerCase()));
    if (matches.length !== 1) {
      const choices = matches.slice(0, 10).map(user => `${user.name}${user.email ? ` (${user.email})` : ""}`);
      return { question: choices.length
        ? `Which Monday user did you mean by “${person}”? ${choices.join(", ")}. Give the full name or email.`
        : `I couldn't find an existing Monday user matching “${person}”. What is their full name or email?` };
    }
    const user = matches[0];
    const memberId = id().safeParse(Number(user.id));
    const name = displayText(user.name);
    const email = displayText(user.email);
    if (!memberId.success || !name || !email) throw new Error(`Monday.com did not return a verified name and email for “${person}”.`);
    const before = members.get(memberId.data)?.role;
    if (removing && before === "owner") return {
      status: "Request blocked",
      message: `${name} owns this board. VoiceOS can only remove direct subscribers. No membership changes were made.`,
    };
    const prior = resolved.get(memberId.data);
    if (prior && prior.role !== role) return { question: `Should ${name} be added as a subscriber or an owner?` };
    resolved.set(memberId.data, { id: memberId.data, name, email, role, before });
  }
  const changes = [...resolved.values()].filter(change => removing
    ? change.before === "subscriber" : change.before !== "owner" && change.before !== change.role);
  const skipped = [...resolved.values()].filter(change => !changes.includes(change)).map(change => change.name);
  if (!changes.length) return {
    status: "No changes",
    message: removing ? "None of the selected people are direct subscribers." : "The selected people already have board membership at the requested level or higher.",
  };
  const warnings: string[] = [];
  if (changes.some(change => change.role === "owner")) warnings.push("Board owners have full control of this board.");
  if (changes.some(change => change.id === actorId)) warnings.push("Removing yourself may cause you to lose access to this board.");
  const args: ManageUsersInput = {
    draft_id: randomUUID(), operation: input.operation,
    board: `${found.target.name} · ${found.target.workspaceName || "Main workspace"}`,
    people: changes.map(({ name, email, role }) => ({ name, email, role })), warnings,
  };
  membershipDrafts.set(args.draft_id, { accountId, board: found.target, args, changes, actorId, expires: Date.now() + 30 * 60_000 });
  return {
    manage_users_arguments: args,
    ...(skipped.length ? { message: `No membership change needed for ${skipped.join(", ")}.` } : {}),
  };
}

async function manageUsers(input: ManageUsersInput) {
  const draft = membershipDrafts.get(input.draft_id);
  if (!draft || draft.expires <= Date.now() || !isDeepStrictEqual(draft.args, input))
    throw new Error("The board membership confirmation changed, expired, or was already used. Prepare a new confirmation.");
  membershipDrafts.delete(input.draft_id);
  const boardKey = `${draft.accountId}/${draft.board.id}`;
  if (activeMembershipWrites.has(boardKey))
    throw new Error("A membership change is already running for this board. Check its result and prepare a new confirmation.");
  activeMembershipWrites.add(boardKey);
  try {
    return await applyMembershipDraft(draft);
  } finally {
    activeMembershipWrites.delete(boardKey);
  }
}

async function applyMembershipDraft(draft: NonNullable<ReturnType<typeof membershipDrafts.get>>) {
  const { accountId, board, changes, actorId } = draft;
  const boardId = Number(board.id);
  const removing = draft.args.operation === "remove";
  if (removing && await mondayActor(accountId) !== actorId)
    throw new Error("The connected Monday.com user changed. Prepare a new confirmation.");
  const current = await readBoardById(boardId, accountId);
  if (!current || !isDeepStrictEqual(boardActionTarget(current), board))
    throw new Error("The selected board changed or is no longer active. Prepare a new confirmation.");
  const members = await readBoardMembers(current, boardId, accountId);
  if (changes.some(change => members.get(change.id)?.role !== change.before))
    throw new Error("The selected board memberships changed. Prepare a new confirmation.");
  const directory = await assigneeLookup((action, args) => executeAction(action, args, accountId))("person");
  const peopleById = new Map(directory.map(user => [Number(user.id), user]));
  if (changes.some(change => {
    const user = peopleById.get(change.id);
    return displayText(user?.name) !== change.name || displayText(user?.email) !== change.email;
  })) throw new Error("The selected Monday.com users changed. Prepare a new confirmation.");

  const action = removing ? "MONDAY_DELETE_SUBSCRIBERS_FROM_BOARD" : "MONDAY_ADD_USERS_TO_BOARD";
  const field = removing ? "delete_subscribers_from_board" : "add_users_to_board";
  const confirmed = new Set<number>();
  const attempted = new Set<number>();
  const errors: string[] = [];
  for (const role of ["subscriber", "owner"] as const) {
    const batch = changes.filter(change => change.role === role);
    if (!batch.length) continue;
    for (const change of batch) attempted.add(change.id);
    try {
      const result = await executeAction(action, {
        board_id: boardId, user_ids: batch.map(change => change.id), ...(removing ? {} : { kind: role }),
      }, accountId);
      const returned = result[field];
      if (Array.isArray(returned)) {
        const ids = new Set(returned.map(user => Number(record(user)?.id)));
        // A returned ID confirms a subscription change. An existing subscriber's
        // promotion needs a membership readback to verify the new role.
        for (const change of batch)
          if (ids.has(change.id) && !(role === "owner" && change.before)) confirmed.add(change.id);
      }
    } catch (error) {
      errors.push(sanitizedError(error));
      break;
    }
  }
  if (confirmed.size < changes.length) {
    try {
      const updated = await readBoardById(boardId, accountId);
      if (updated) {
        const after = await readBoardMembers(updated, boardId, accountId);
        for (const change of changes.filter(change => attempted.has(change.id))) {
          const role = after.get(change.id)?.role;
          if (removing ? !role : role === change.role) confirmed.add(change.id);
        }
      }
    } catch { /* Keep provider-confirmed results when readback fails. */ }
  }
  const completed = changes.filter(change => confirmed.has(change.id)).map(change => change.name);
  const pending = changes.filter(change => attempted.has(change.id) && !confirmed.has(change.id)).map(change => change.name);
  const skipped = changes.filter(change => !attempted.has(change.id)).map(change => change.name);
  const message = [
    completed.length ? `${removing ? "Removed" : "Added"} ${completed.join(", ")} ${removing ? "from" : "to"} “${board.name}”.` : "",
    ...new Set(errors),
    pending.length ? `Could not confirm changes for ${pending.join(", ")}. Check the board before trying again.` : "",
    skipped.length ? `Skipped ${skipped.join(", ")} after the earlier request failed.` : "",
  ].filter(Boolean).join(" ");
  if (!completed.length) throw new Error(message);
  return { status: confirmed.size < changes.length ? "Partial success" : "Success", message };
}

async function prepareBoardAction(action: BoardAction, input: z.infer<typeof prepareBoardActionSchema>): Promise<PrepareBoardActionOutput> {
  const { board_id: boardId, board_name: boardName, revises_board_name: previousBoard } = input;
  let replaces = input.replaces_draft_id;
  const drafts = boardActionDrafts[action];
  if (boardId !== undefined && boardName) throw new Error("Choose the board by name or by ID.");
  if (replaces && previousBoard) throw new Error(`Identify the pending ${action} by draft ID or previous board name.`);
  if (boardId === undefined && !boardName) return { question: `Which Monday board should I ${action}?` };
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of drafts) if (draft.expires <= now) drafts.delete(key);
  if (previousBoard) {
    const candidates = [...drafts].filter(([, draft]) =>
      draft.accountId === accountId && matchesName(draft.initialBoard.name, previousBoard));
    if (candidates.length !== 1)
      return { question: `Which board should I ${action}? Please restate the request with the exact board name.` };
    replaces = candidates[0][0];
  }
  const prior = replaces ? drafts.get(replaces) : undefined;
  if (replaces && prior?.accountId !== accountId)
    throw new Error(`The ${action} draft changed, expired, or was already used. Prepare a new confirmation.`);

  const boards = (await listActiveBoards(accountId)).flatMap(board => {
    const target = boardActionTarget(board);
    return target ? [target] : [];
  });
  const matches = boardName ? matchingBoards(boards, boardName) : boards.filter(board => board.id === String(boardId));
  const labels = boards.map(board => board.workspaceName ? `${board.name} — ${board.workspaceName}` : board.name);
  const labelCounts = new Map<string, number>();
  for (const label of labels) labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
  const choices = boards.map((board, index) => ({
    value: board.id,
    label: labelCounts.get(labels[index]) === 1 ? labels[index] : `${labels[index]} (#${board.id})`,
  })).sort((a, b) => a.label.localeCompare(b.label));

  if (replaces) {
    if (drafts.get(replaces) !== prior || prior!.expires <= Date.now())
      throw new Error(`The ${action} draft changed, expired, or was already used. Prepare a new confirmation.`);
    drafts.delete(replaces);
  }
  if (!matches.length) return { question: `I couldn't find that active Monday board. Which board should I ${action}?` };
  if (matches.length > 1) {
    const matchingIds = new Set(matches.map(board => board.id));
    return {
      question: `More than one active Monday board matches “${boardName}”. Which one should I ${action}?`,
      matching_boards: choices.filter(choice => matchingIds.has(choice.value)),
    };
  }
  const draftId = randomUUID();
  const selected = matches[0];
  drafts.set(draftId, {
    accountId, expires: Date.now() + 30 * 60_000, initialBoard: selected,
    boards: new Map(boards.map(board => [board.id, board])), choices,
  });
  const label = action === "archive" ? "Archive board" : "Delete board";
  const message = `Pending action: ${action} the Monday board “${selected.name}”. A correction to the board requires a new ${label} confirmation.`;
  const args = { draft_id: draftId, board_choice: selected.id, board_choices: choices };
  return action === "archive" ? { message, archive_board_arguments: args } : { message, delete_board_arguments: args };
}

async function executeBoardAction(action: BoardAction, input: BoardActionInput): Promise<WriteOutput> {
  const drafts = boardActionDrafts[action];
  const draft = drafts.get(input.draft_id);
  if (!draft || draft.expires <= Date.now())
    throw new Error(`The ${action} draft changed, expired, or was already used. Review a current confirmation.`);
  const selected = draft.boards.get(input.board_choice);
  const label = action === "archive" ? "Archive board" : "Delete board";
  if (!selected || !isDeepStrictEqual(input.board_choices, draft.choices))
    throw new Error(`Choose a board from the current ${label} confirmation.`);
  drafts.delete(input.draft_id);

  // The ID came from the prepared board list and was validated as decimal digits.
  // Use the same active-board listing that resolved the target before confirmation.
  const current = await listActiveBoards(draft.accountId).catch(error => {
    throw new Error(`Could not verify the board before the ${action} action. ${sanitizedError(error)}`);
  });
  const board = current.find(row => String(row.id) === selected.id);
  if (!board || !isDeepStrictEqual(boardActionTarget(board), selected))
    throw new Error(`The selected board changed or is no longer active. Prepare the ${action} again.`);

  const archive = action === "archive";
  const field = archive ? "archive_board" : "delete_board";
  const operation = archive ? "ArchiveBoard" : "DeleteBoard";
  const pastTense = archive ? "archived" : "deleted";
  let result;
  try {
    const data = await mondayGraphQL(draft.accountId, `mutation ${operation} {
      ${field}(board_id: ${selected.id}) { ${archive ? "id state" : "id"} }
    }`, {});
    result = record(data[field]);
  } catch (error) {
    const detail = sanitizedError(error).replace(new RegExp(`\\b${selected.id}\\b`, "g"), "the selected board");
    throw new Error(`Could not confirm that the board was ${pastTense}. ${detail} Check Monday.com before retrying.`);
  }
  if (String(result?.id) !== selected.id || (archive && result?.state !== "archived"))
    throw new Error(`Monday.com did not confirm the selected board was ${pastTense}. Check Monday.com before retrying.`);
  return {
    status: archive ? "Board archived" : "Board deleted",
    message: archive ? `Archived “${selected.name}”.` : `Moved “${selected.name}” to Monday.com Trash.`,
    id: selected.id,
  };
}

function safeBoardUrl(value: unknown, boardId?: string): string | undefined {
  if (typeof value !== "string") return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
        url.hostname.endsWith(".monday.com") && /^\/boards\/\d+\/?$/.test(url.pathname) &&
        (!boardId || url.pathname.replace(/\/$/, "") === `/boards/${boardId}`)) {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Keep the confirmed board result when the provider's URL is malformed.
  }
}

async function createBoard(input: CreateBoardInput): Promise<CreatedBoardOutput | RejectedBoardOutput> {
  const draft = createBoardDrafts.get(input.draft_id);
  const confirmation = draft?.confirmation;
  if (!draft || !confirmation || draft.expires <= Date.now()) {
    throw new Error("The board draft changed, expired, or was already used. Review the current confirmation before creating the board.");
  }
  if (!isDeepStrictEqual(confirmation.args.workspace_choices, input.workspace_choices) ||
      confirmation.args.workspace_notice !== input.workspace_notice ||
      confirmation.args.submission_error !== input.submission_error) {
    throw new Error("The board's workspace choices changed. Prepare the board again.");
  }
  const choice = input.workspace_choice ?? confirmation.args.workspace_choice ?? "default";
  const workspaceId = confirmation.workspaceIds.get(choice);
  if (choice !== "default" && workspaceId === undefined) throw new Error("Choose a workspace shown on the confirmation.");
  const description = input.description ?? confirmation.args.description;
  const kind = input.board_kind ?? confirmation.args.board_kind ?? "public";
  const workspace = input.workspace_choices.find(entry => entry.value === choice)?.label;
  draft.confirmation = undefined;
  draft.submission = "submitting";
  let data: Record<string, unknown>;
  try {
    data = await executeAction("MONDAY_CREATE_BOARD", {
      board_name: input.board_name,
      board_kind: kind,
      ...(description?.trim() ? { description } : {}),
      ...(workspaceId !== undefined ? { workspace_id: workspaceId } : {}),
    }, draft.accountId);
  } catch (error) {
    if (!(error instanceof BoardSettingsRejection)) {
      draft.submission = "unconfirmed";
      throw error;
    }
    const message = sanitizedError(error);
    const args: CreateBoardInput = {
      ...confirmation.args, draft_id: randomUUID(), board_name: input.board_name,
      board_kind: kind, description, workspace_choice: choice, submission_error: message,
    };
    createBoardDrafts.set(args.draft_id, {
      accountId: draft.accountId, expires: Date.now() + 30 * 60_000,
      request: { ...draft.request, board_name: input.board_name, board_kind: kind, description, workspace: workspaceId === undefined ? null : workspace },
      confirmation: { ...confirmation, args },
    });
    draft.submission = undefined;
    draft.replacedBy = args.draft_id;
    return { error: message, retry_create_board_arguments: args };
  }
  draft.submission = "unconfirmed";
  const result = writeResult(data, ["create_board"], "");
  draft.submission = "created";
  let board = record(data.create_board) ?? data;
  const boardId = id().safeParse(Number(result.id));
  if (boardId.success && (!safeBoardUrl(board.url, result.id) || (!record(board.top_group) && !Array.isArray(board.groups)))) {
    try {
      board = { ...board, ...await readBoardById(boardId.data, draft.accountId) };
    } catch {
      // The create returned an ID. A failed metadata read cannot undo that success.
    }
  }
  const name = displayText(board.name) ?? input.board_name;
  if (boardId.success) {
    const now = Date.now();
    for (const [key, value] of recentlyCreatedBoards) if (value.expires <= now) recentlyCreatedBoards.delete(key);
    recentlyCreatedBoards.set(`${draft.accountId}:${boardId.data}`, { board: { ...board, id: result.id, name }, expires: now + 30 * 60_000 });
  }
  const workspaceName = displayText(record(board.workspace)?.name) ?? workspace ?? "default workspace";
  const visibility = kind === "share" ? "shareable" : kind;
  const followUp = boardId.success && draft.request.item_follow_up;
  const nextStep = followUp === "prepare_confirmation" ? "Preparing the item confirmation…"
    : followUp === "ask_name" ? "Next, choose a name for the item." : undefined;
  const followUpItemName = followUp === "prepare_confirmation" ? draft.request.follow_up_item_name : undefined;
  return {
    ...result, name, url: safeBoardUrl(board.url, result.id) ?? null,
    message: `Created ${visibility} board “${name}” in ${workspaceName === "Default workspace" ? "the default workspace" : workspaceName}.`,
    ...(boardId.success ? { item_destination: {
      board_id: boardId.data, ...(followUpItemName ? { item_name: followUpItemName } : {}),
    } } : {}),
    ...(nextStep ? { item_follow_up: nextStep } : {}),
  };
}

async function getBoards(
  input: z.infer<typeof getBoardsSchema>,
): Promise<ReadOutput> {
  const page = input.page ?? 1;
  const limit = input.limit ?? 25;
  const data = await executeAction("MONDAY_BOARDS", { ...input, page, limit });
  const boards = records(data.boards);
  return {
    resultType: "boards",
    status: "Boards found",
    message: readSummary(boards.length, "board"),
    records: boards,
    pagination: {
      page,
      limit,
      nextPage: boards.length === limit ? page + 1 : null,
    },
  };
}

async function getItems(
  input: z.infer<typeof getItemsSchema>,
  accountId?: string,
): Promise<ReadOutput> {
  if (
    [input.ids, input.board_id, input.cursor].filter(
      (value) => value !== undefined,
    ).length !== 1
  ) {
    throw new Error(
      "Provide exactly one of ids, board_id, or cursor to get items.",
    );
  }
  if (
    input.ids
      ? input.group_id !== undefined
      : [input.page, input.newest_first, input.exclude_nonactive].some(
          (value) => value !== undefined,
        )
  ) {
    throw new Error(
      "group_id is only for board reads; page, newest_first, and exclude_nonactive are only for item-ID reads.",
    );
  }
  if (input.cursor && input.group_id)
    throw new Error(
      "Use cursor alone to continue a board read; do not also provide group_id.",
    );
  if (input.ids && input.board_name) {
    throw new Error("board_name is only for board or cursor reads; item-ID reads may span multiple boards.");
  }
  // Board names are display context, not provider arguments or execution targets.
  const { board_name, ...args } = input;
  const limit = input.limit ?? 25;
  if (input.ids) {
    const page = input.page ?? 1;
    const data = await executeAction("MONDAY_GET_ITEMS", {
      ...args,
      page,
      limit,
    }, accountId);
    const items = records(data.items);
    return {
      resultType: "tasks",
      status: "Tasks",
      message: readSummary(items.length, "item"),
      records: items,
      pagination: {
        page,
        limit,
        nextPage: items.length === limit ? page + 1 : null,
      },
    };
  }
  const data = await executeAction("MONDAY_ITEMS_PAGE", {
    ...args,
    limit,
    include_column_values: true,
  }, accountId);
  // Initial queries nest the page under boards (or groups); cursor queries return next_items_page.
  if (Array.isArray(data.boards) && data.boards.length === 0) {
    return {
      resultType: "tasks", status: "Tasks", message: "No matching accessible board found.",
      records: [], pagination: { limit, nextCursor: null },
    };
  }
  const board = Array.isArray(data.boards) ? record(data.boards[0]) : undefined;
  const boardName = displayText(board?.name) ?? board_name;
  const group =
    board && Array.isArray(board.groups) ? record(board.groups[0]) : undefined;
  const groupName = input.group_id ? displayText(group?.title) : undefined;
  const page =
    record(
      data.next_items_page ??
        data.items_page ??
        group?.items_page ??
        board?.items_page,
    ) ?? (Array.isArray(data.items) ? data : undefined);
  if (!page || !(page.cursor === null || typeof page.cursor === "string")) {
    throw new Error(
      "Monday.com returned an unexpected items page or missing pagination cursor. Try again.",
    );
  }
  const items = records(page.items);
  return {
    resultType: "tasks",
    status: "Tasks",
    ...(boardName ? { boardName } : {}),
    ...(groupName ? { groupName } : {}),
    message: readSummary(items.length, "item", boardName),
    records: items,
    pagination: { limit, nextCursor: page.cursor },
  };
}

async function connect(): Promise<Output> {
  // Connect is a short browser handoff, not a task that waits for user consent.
  // Bound the whole handoff so it finishes before VoiceOS's MCP request timeout.
  const signal = AbortSignal.timeout(12000);
  // Validate settings even when no connection has been saved yet.
  api();
  const state = await load();
  const saved = state.pending?.id ?? state.accountId;
  const existing = saved ? await account(saved, signal) : undefined;
  if (existing?.status === "ACTIVE" && !existing.isDisabled) {
    stopBackgroundConnectWatcher();
    state.accountId = existing.id;
    delete state.pending;
    await save(state);
    return {
      connected: true,
      status: "Connected",
      message:
        "Monday.com authorization verified. Your saved connection is ready to use.",
    };
  }
  // If not active, create a fresh authorization session with a valid redirect link.
  // Reopening a previously launched link fails because Composio link sessions expire once visited.
  delete state.pending;
  const session = await api().sessions.create(
    state.userId,
    {
      toolkits: ["monday"],
      tools: { monday: { enable: [] } },
      sandbox: { enable: false },
    },
    { signal, maxRetries: 0 },
  );
  const request = await session.authorize("monday", undefined, {
    signal,
    maxRetries: 0,
  });
  if (
    !request.redirectUrl ||
    new URL(request.redirectUrl).protocol !== "https:"
  ) {
    throw new Error(
      "Composio did not return a valid HTTPS authorization link.",
    );
  }
  state.pending = { id: request.id, url: request.redirectUrl };
  await save(state);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "/usr/bin/open",
      [state.pending!.url],
      { timeout: 8000, signal },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  startBackgroundConnectWatcher(request.id);
  return {
    connected: false,
    status: "Authorization pending",
    authorizationUrl: state.pending.url,
    message:
      "Monday.com authorization opened in your browser. Finish approval there, then run Connect again to verify the connection. If Monday says ‘App is not installed’, ask an admin to install Composio's Monday app using the README link.",
  };
}

async function disconnect(): Promise<Output> {
  stopBackgroundConnectWatcher();
  const state = await load();
  let providerRevoked = true;
  for (const id of new Set(
    [state.accountId, state.pending?.id].filter((id): id is string =>
      Boolean(id),
    ),
  )) {
    const saved = await account(id);
    if (!saved || saved.status === "REVOKED") continue;
    try {
      const revoked = await api().connectedAccounts.revoke(id, {
        signal: AbortSignal.timeout(12000),
      });
      if (revoked.connectedAccount.status !== "REVOKED")
        throw new Error(
          "Composio did not confirm revocation. Run Disconnect again to verify before reconnecting.",
        );
    } catch (error) {
      // Legacy Monday OAuth may not support provider revocation. Disable access in Composio instead.
      if (![400, 409].includes(httpStatus(error) ?? 0)) throw error;
      if (!saved.isDisabled)
        await api().connectedAccounts.disable(id, {
          signal: AbortSignal.timeout(8000),
        });
      providerRevoked = false;
    }
  }
  delete state.accountId;
  delete state.pending;
  await save(state);
  return {
    connected: false,
    status: "Disconnected",
    providerRevoked,
    message: providerRevoked
      ? "Monday.com is disconnected. No boards, items, or memberships were changed."
      : "Monday.com is disconnected in Composio. To also remove provider consent, uninstall the Composio app from your Monday.com account's installed apps. No boards, items, or memberships were changed.",
  };
}

type ProgressContext = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total: number;
      message: string;
    };
  }) => Promise<void>;
};

async function progress(extra: ProgressContext, message: string, done = false) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: done ? 100 : 0, total: 100, message },
    });
  } catch {
    /* A display failure must not change the account operation's outcome. */
  }
}

function sanitizedError(error: unknown) {
  let message = error instanceof Error ? error.message : "Composio request failed.";
  const key = process.env.COMPOSIO_API_KEY?.trim();
  if (key) message = message.split(key).join("[redacted]");
  return message.replace(/https?:\/\/[^\s"<>]+/g, "[link redacted]").slice(0, 700);
}

const boardLinkWidget = `<!doctype html>
<meta charset="utf-8">
<style>
body { margin: 0; background: transparent; font: 12.5px system-ui, sans-serif; }
button { cursor: pointer; color: #7eafff; border: 0; background: transparent; font: inherit; padding: 4px 0; }
button:hover { text-decoration: underline; }
html[data-theme="light"] button { color: #205db2; }
</style>
<button type="button" disabled>Open board</button>
<script>
const button = document.querySelector('button');
let url;
addEventListener('message', event => {
  if (event.source !== parent || event.data?.type !== 'voiceos:init') return;
  document.documentElement.dataset.theme = event.data.theme?.mode ?? 'dark';
  url = event.data.data?.url;
  button.disabled = typeof url !== 'string';
});
button.addEventListener('click', () => {
  if (url) parent.postMessage({ type: 'voiceos:openUrl', url }, '*');
});
</script>`;

async function feedback(
  title: string,
  extra: ProgressContext,
  run: () => Promise<Output | ReadOutput | WriteOutput | CreatedBoardOutput | RejectedBoardOutput | PrepareCreateItemOutput | PrepareCreateBoardOutput | PrepareUpdateItemOutput | PrepareCreateGroupOutput | PrepareBoardActionOutput | MembershipPreparation | MembershipResult | CommentPreparation>,
  notifyResult = false,
  errorTitle?: string,
) {
  await progress(extra, `${title}…`);
  let data: Awaited<ReturnType<typeof run>> | { error: string };
  try {
    data = await run();
  } catch (error) {
    data = { error: sanitizedError(error) };
  }
  const isError = "error" in data;
  await progress(extra, `${title}: ${isError ? "failed" : "finished"}`, true);
  if ("question" in data || "update_item_arguments" in data || "update_item_details" in data || "create_item_arguments" in data || "create_board_arguments" in data || "pending_board" in data ||
      "board_draft_status" in data || "create_group_arguments" in data || "archive_board_arguments" in data || "delete_board_arguments" in data || "manage_users_arguments" in data || "board" in data ||
      "create_comment_arguments" in data || "edit_comment_arguments" in data || "delete_comment_arguments" in data) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }
  let notificationQueued = false;
  const boardUrl = "url" in data ? data.url : null;
  const itemFollowUp = "item_follow_up" in data ? data.item_follow_up : undefined;
  if (notifyResult) {
    if (
      await notify(
        `Monday.com — ${title}: ${"error" in data ? data.error : data.message}`,
      )
    ) {
      notificationQueued = true;
    }
  }
  const resultTitle = "error" in data ? errorTitle ?? "Monday.com" : "Monday.com";
  const resultMessage = "error" in data ? (errorTitle ? data.error.slice(0, 64) : data.error) : data.message;
  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...data,
          notificationQueued,
          _voiceos_glance: {
            blocks: "records" in data ? readGlance(data) : [
              {
                type: "header",
                title: "status" in data && data.status === "Request blocked" ? data.status : resultTitle,
                trailing: "error" in data ? "Error" : data.status === "Request blocked" ? "Monday.com" : data.status,
              },
              {
                type: "keyValue",
                pairs: [["Status", resultMessage], ...(itemFollowUp ? [["Next", itemFollowUp]] : [])],
              },
              ...(boardUrl ? [{ type: "widget", label: "Open board", height: 25, html: boardLinkWidget, data: { url: boardUrl } }] : []),
            ],
          },
        }),
      },
    ],
  };
}

server.server.setRequestHandler(z.object({
  method: z.literal("voiceos/reminders/action"),
  params: z.object({
    notificationId: z.string(),
    actionId: z.string(),
    data: z.object({ url: z.string() }),
  }),
}), async ({ params }) => {
  const url = params.actionId === "open_board" ? safeBoardUrl(params.data.url) : undefined;
  if (!url) throw new Error("Invalid Monday.com board link.");
  await new Promise<void>((resolve, reject) => {
    execFile("/usr/bin/open", [url], { timeout: 8000 }, error => error ? reject(error) : resolve());
  });
  return { ok: true };
});

server.registerTool(
  "connect_account",
  {
    title: "Connect Monday.com",
    description:
      "Connect Monday.com through Composio OAuth. Use when asked to connect, authorize, reconnect, or verify the saved Monday.com connection. Verify an active saved account; otherwise open browser authorization and immediately return pending with its link. After browser approval, run Connect again to verify. Only report connected when connected=true; no background sidebar result is scheduled.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback("Connect Monday.com", extra, async () => {
      if (disconnecting)
        throw new Error(
          "Monday.com is still disconnecting. Wait for it to finish before connecting.",
        );
      if (!connecting)
        connecting = connect().finally(() => {
          connecting = undefined;
        });
      return await connecting;
    }, true),
);

server.registerTool(
  "connection_status",
  {
    title: "Monday.com account",
    description:
      "Show Monday.com connection status with Connect, Disconnect, and Refresh controls. Use when asked about Monday.com account settings, connection status, expired authorization, or account linking. Read only; does not start OAuth.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback(
      "Check connection",
      extra,
      async () => {
        const state = await load();
        const saved = state.pending?.id ?? state.accountId;
        const acc = saved ? await account(saved) : undefined;
        const connected = acc?.status === "ACTIVE" && !acc.isDisabled;
        const status = connected
          ? "Connected"
          : acc?.isDisabled
            ? "Disabled"
            : (acc?.status ?? "Disconnected");
        const message = connected
          ? "Monday.com is connected and ready to use."
          : status === "EXPIRED"
            ? "Your Monday.com authorization expired. Connect again to authorize."
            : status === "REVOKED"
              ? "Your Monday.com authorization was revoked. Connect again to authorize."
              : ["INITIATED", "INITIALIZING", "PENDING"].includes(status)
                ? "Finish authorizing Monday.com in your browser, then refresh."
                : "Monday.com is disconnected. Connect to authorize in your browser.";
        return { connected: Boolean(connected), status, message };
      },
      false,
    ),
);

server.registerTool(
  "disconnect_account",
  {
    title: "Disconnect Monday.com",
    description:
      "Disconnect this installation's Monday.com account. Use only when asked to disconnect or unlink Monday.com. Revoke authorization when supported; otherwise disable the Composio connection. Does not delete boards, items, or users.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback("Disconnect Monday.com", extra, async () => {
      if (connecting)
        throw new Error(
          "Monday.com authorization is still running. Finish or wait for it before disconnecting.",
        );
      if (!disconnecting)
        disconnecting = disconnect().finally(() => {
          disconnecting = undefined;
        });
      return await disconnecting;
    }, true),
);

server.registerTool(
  "get_boards",
  {
    title: "Get Monday.com boards",
    description:
      "Find Monday.com boards with optional ID, workspace, state, and visibility filters. When the user asks for tasks on a named board, use this as an intermediate lookup. Prefer an exact board-name match, use a unique clear partial match automatically, and ask when multiple boards could match. Then call get_items with the resolved board_id and exact board_name before answering. For a general board list request, use the short message and let the glance card show the names. Use the full records from the current page for board-specific follow-ups, including boards outside the preview. Pagination starts at page 1. When pagination.nextPage is available, offer to check for more boards and use that page with the previous filters and limit if asked. Counts describe the returned page. Keep IDs internal unless explicitly requested. Read only; does not start OAuth or send notifications.",
    inputSchema: getBoardsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (input, extra) =>
    feedback("Get boards", extra, () => getBoards(input), false),
);

server.registerTool(
  "get_items",
  {
    title: "Get Monday.com items",
    description:
      "List Monday.com items when the user asks to view or retrieve them. A bare board name in answer to a pending create-item board question selects the destination for prepare_create_item. Use exactly one of ids, board_id, or cursor. For a named board, first resolve its ID with get_boards: prefer an exact match, otherwise use a unique clear partial match; ask if ambiguous. Pass the exact resolved board_name for display and name that board in the final task answer. Never present get_boards results as tasks; wait for this call to succeed before listing tasks, or report its error. Item-ID reads support page, newest_first, and exclude_nonactive; pagination.nextPage is a possible next page. Board reads include column values and optionally group_id. For an explicit next-page request, use pagination.nextCursor with the previous limit and optional board_name display context. For a general list request, use the short message and let the glance card show the names. Offer to show the next page when there is a cursor, or offer to narrow by group when appropriate. Use the full records from the current page to answer item-specific follow-ups, including items outside the preview. Counts describe the returned page. Keep IDs internal unless explicitly requested, and use only confirmed IDs and names. Read only; does not start OAuth or send notifications.",
    inputSchema: getItemsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (input, extra) =>
    feedback("Get items", extra, () => getItems(input), false),
);

server.registerTool("prepare_create_item", {
  title: "Prepare Monday.com item", description: prepareCreateItemDescription, inputSchema: prepareCreateItemSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Preparing item confirmation", extra, () => prepareCreateItem(input), false, "Couldn’t prepare Monday item"));

server.registerTool("create_item", {
  title: "Create Monday.com item", description: createItemDescription, inputSchema: createItemSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com item", extra, () => createItem(input)));

server.registerTool("prepare_update_item", {
  title: "Prepare Monday.com item update", description: prepareUpdateItemDescription, inputSchema: prepareUpdateItemSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Preparing item changes", extra, () => prepareUpdateItem(input), false, "Couldn’t prepare item changes"));

server.registerTool("update_item_values", {
  title: "Update Monday.com item values", description: updateItemValuesDescription, inputSchema: updateItemValuesSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Update Monday.com item values", extra, () => updateItemValues(input)));

server.registerTool("get_comments", {
  title: "Get Monday.com comments", description: getCommentsDescription, inputSchema: getCommentsSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Getting Monday.com comments", extra, () => getComments(input)));

server.registerTool("prepare_comment", {
  title: "Prepare Monday.com comment", description: prepareCommentDescription, inputSchema: prepareCommentSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Preparing comment confirmation", extra, () => prepareComment(input)));

for (const { operation, title, description, inputSchema } of [
  { operation: "create", title: "Post Monday.com comment", description: createCommentDescription, inputSchema: createCommentSchema },
  { operation: "edit", title: "Edit Monday.com comment", description: editCommentDescription, inputSchema: editCommentSchema },
  { operation: "delete", title: "Delete Monday.com comment", description: deleteCommentDescription, inputSchema: deleteCommentSchema },
] as const) {
  server.registerTool(`${operation}_comment`, {
    title, description, inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: operation === "delete", idempotentHint: false, openWorldHint: true },
  }, async (input, extra) => feedback(title, extra, () => applyComment(operation, input)));
}

server.registerTool("prepare_create_board", {
  title: "Prepare Monday.com board", description: prepareCreateBoardDescription, inputSchema: prepareCreateBoardSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com board", extra, () => prepareCreateBoard(input), false, "Couldn’t prepare Monday board"));

server.registerTool("create_board", {
  title: "Create Monday.com board", description: createBoardDescription, inputSchema: createBoardSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com board", extra, () => createBoard(input)));

server.registerTool("prepare_create_group", {
  title: "Prepare Monday.com group", description: prepareCreateGroupDescription, inputSchema: prepareCreateGroupSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com group", extra, () => prepareCreateGroup(input), false, "Couldn’t prepare Monday group"));

server.registerTool("create_group", {
  title: "Create Monday.com group", description: createGroupDescription, inputSchema: createGroupSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com group", extra, () => createGroup(input)));

server.registerTool("prepare_archive_board", {
  title: "Prepare Monday.com board archive", description: prepareArchiveBoardDescription, inputSchema: prepareBoardActionSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com board archive", extra, () => prepareBoardAction("archive", input)));

server.registerTool("archive_board", {
  title: "Archive Monday.com board", description: archiveBoardDescription, inputSchema: boardActionSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Archive Monday.com board", extra, () => executeBoardAction("archive", input)));

server.registerTool("prepare_delete_board", {
  title: "Prepare Monday.com board deletion", description: prepareDeleteBoardDescription, inputSchema: prepareBoardActionSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com board deletion", extra, () => prepareBoardAction("delete", input)));

server.registerTool("delete_board", {
  title: "Delete Monday.com board", description: deleteBoardDescription, inputSchema: boardActionSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Delete Monday.com board", extra, () => executeBoardAction("delete", input)));

server.registerTool("list_board_members", {
  title: "List Monday.com board members", description: "Use for questions like “who is on the Marketing board?” Lists the named board’s owners and direct subscribers. If a question is returned, ask it. Pass board_id only to select a board the user confirmed from matching_boards. Use the full records for follow-ups, and summarize the names and roles aloud without reading IDs. If membership cannot be verified, report the error. Read only.",
  inputSchema: listBoardMembersSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("List Monday.com board members", extra, () => listBoardMembers(input)));

server.registerTool("prepare_manage_users", {
  title: "Prepare Monday.com board membership change", description: "Start here for explicit requests to add existing Monday users to a board or remove direct subscribers from a board. Pass the board name and each person by name or email. Use role owner only for people the user explicitly asked to make board owners. Use me for a requested self-removal. If a question is returned, ask it, then retry with all clarified inputs. Pass board_id only to select a board the user confirmed from matching_boards. For a correction to a pending card, include replaces_draft_id and the complete corrected request. Pass manage_users_arguments verbatim to manage_users for confirmation. Read only.",
  inputSchema: prepareManageUsersSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com board membership change", extra, () => prepareManageUsers(input)));

server.registerTool("manage_users", {
  title: "Manage Monday.com board members", description: "Show the confirmation card using manage_users_arguments from prepare_manage_users verbatim. Approval applies the displayed board membership changes. If the user corrects the board, people, or roles, prepare and show a new confirmation. Speak the result, including any provider errors or unconfirmed changes. Check Monday before retrying an uncertain change.",
  inputSchema: manageUsersSchema,
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Manage Monday.com board members", extra, () => manageUsers(input)));

await server.connect(new StdioServerTransport());
