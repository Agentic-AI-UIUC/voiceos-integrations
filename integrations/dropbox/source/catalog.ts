import { z } from 'zod';
export const VERSION = '20261101_00';
export const BUILD = 'dropbox-composio-v16-package-parity';
export const INTEGRATION_VERSION = '2.0.14';
const path = z.string().refine(p => p === '' || (p.startsWith('/') && !p.endsWith('/') && !p.includes('//') && !/[\u0000-\u001f]/.test(p) && !p.split('/').some(s=>s==='.'||s==='..')), 'Use an absolute Dropbox path without control characters, dot segments, or a trailing slash');
const item = path.refine(p => p.length > 1, 'A file or folder path is required; root is protected');
const text = z.string().min(1);
const limit = z.number().int().min(1).max(100).optional();
export const tools = [
  { name:'list_files', title:'List files in folder', slug:'DROPBOX_LIST_FILES_IN_FOLDER', schema:{path:path.default(''), limit}, collection:'entries', use:'browse a Dropbox folder', write:false },
  { name:'search_files', title:'Search files and folders', slug:'DROPBOX_FILES_SEARCH', schema:{query:text,path:path.optional(),max_results:limit}, collection:'matches', use:'find Dropbox files or folders by keyword', write:false },
  { name:'get_metadata', title:'Get file or folder metadata', slug:'DROPBOX_GET_METADATA', schema:{path:item}, use:'inspect Dropbox file or folder metadata', write:false },
  { name:'read_file', title:'Read a file', slug:'DROPBOX_READ_FILE', schema:{path:item}, use:'read a Dropbox file; Word .docx files up to 20 MiB return extracted readable text, while other binary formats return a file reference', write:false },
  { name:'upload_file', title:'Upload File', slug:'DROPBOX_UPLOAD_FILE', schema:{path:item,file:text.describe('Full existing local file path, without surrounding quotes or brackets. Supports binary Word/PDF/image files up to 50 MiB; never invent a file reference.'),mode:z.enum(['add','overwrite']).default('add')}, use:'upload an existing local file to Dropbox; overwrite requires explicit approval', write:true },
  { name:'create_folder', title:'Create folder', slug:'DROPBOX_CREATE_FOLDER', schema:{path:item}, use:'create a Dropbox folder', write:true },
  { name:'copy_item', title:'Copy file or folder', slug:'DROPBOX_COPY_FILE_OR_FOLDER', schema:{from_path:item,to_path:item}, use:'copy a Dropbox file or folder to an exact destination', write:true },
  { name:'move_item', title:'Move file or folder', slug:'DROPBOX_MOVE_FILE_OR_FOLDER', schema:{from_path:item,to_path:item}, use:'move or rename a Dropbox file or folder', write:true },
  { name:'delete_item', title:'Delete file or folder', slug:'DROPBOX_DELETE_FILE', schema:{path:item}, use:'delete a Dropbox file or folder; recovery depends on the account plan', write:true },
  { name:'list_revisions', title:'List file revisions', slug:'DROPBOX_LIST_FILE_REVISIONS', schema:{path:item,limit}, collection:'entries', use:'inspect previous versions before restoring a Dropbox file', write:false },
  { name:'restore_revision', title:'Restore file to specific revision', slug:'DROPBOX_RESTORE_FILE', schema:{path:item,rev:text}, use:'restore a Dropbox file to the exact revision the user selected', write:true },
  { name:'create_shared_link', title:'Create shared link', slug:'DROPBOX_CREATE_SHARED_LINK', schema:{path:item}, use:'create a shared link after approving the access change', write:true },
  { name:'list_shared_links', title:'List shared links', slug:'DROPBOX_LIST_SHARED_LINKS', schema:{path:item.optional(),cursor:text.optional()}, collection:'links', use:'inspect existing Dropbox shared links', write:false },
  { name:'revoke_shared_link', title:'Revoke shared link', slug:'DROPBOX_REVOKE_SHARED_LINK', schema:{url:z.string().url().refine(s => {const u=new URL(s);return u.protocol==='https:' && (u.hostname==='dropbox.com'||u.hostname==='www.dropbox.com');},'Use a Dropbox HTTPS shared link')}, use:'revoke the exact Dropbox shared link selected by the user', write:true },
] as const;
export const approved = new Set(tools.map(t => t.slug));
export type Tool = typeof tools[number];
export function parseArgs(tool:Tool,args:unknown) { return z.object(tool.schema).strict().parse(args); }
