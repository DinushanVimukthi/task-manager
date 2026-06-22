use chrono::Utc;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

// ─── Structs ──────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Folder {
    pub id: i64, pub project_id: i64, pub parent_id: Option<i64>,
    pub name: String, pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct BoardColumn {
    pub id: i64, pub board_id: i64, pub name: String, pub position: i64, pub color: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Board {
    pub id: i64, pub project_id: Option<i64>, pub name: String,
    pub columns: Vec<BoardColumn>, pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TaskHistoryEntry {
    pub id: i64, pub task_id: i64, pub action: String, pub detail: String, pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Project {
    pub id: i64, pub name: String, pub description: String, pub color: String, pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Task {
    pub id: i64, pub task_id: String, pub title: String, pub description: String,
    pub completed: bool, pub priority: String, pub due_date: Option<String>,
    pub notify_before_minutes: i64, pub notification_sent: bool,
    pub project_id: Option<i64>, pub folder_id: Option<i64>, pub board_column_id: Option<i64>,
    pub created_at: String,
}
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct UserInfo { pub id: i64, pub email: String }
#[derive(Debug, Serialize, Deserialize)]
pub struct LoginResult { pub token: String, pub user: UserInfo }
pub struct AppState { pub db: Arc<Mutex<Connection>> }

// ─── DB Init ──────────────────────────────────────────────────────────────────

fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")?;
    conn.execute_batch("
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            email TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            token TEXT NOT NULL UNIQUE,
            expires_at TEXT NOT NULL,
            FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS projects (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            color TEXT NOT NULL DEFAULT '#7c6af7',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS folders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER NOT NULL,
            parent_id INTEGER,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS boards (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            project_id INTEGER,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS board_columns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            board_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            position INTEGER NOT NULL DEFAULT 0,
            color TEXT NOT NULL DEFAULT '#888888'
        );
        CREATE TABLE IF NOT EXISTS task_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER NOT NULL,
            action TEXT NOT NULL,
            detail TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
        CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id TEXT NOT NULL UNIQUE,
            title TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            completed INTEGER NOT NULL DEFAULT 0,
            priority TEXT NOT NULL DEFAULT 'medium',
            due_date TEXT,
            notify_before_minutes INTEGER NOT NULL DEFAULT 60,
            notification_sent INTEGER NOT NULL DEFAULT 0,
            project_id INTEGER REFERENCES projects(id),
            folder_id INTEGER REFERENCES folders(id),
            board_column_id INTEGER REFERENCES board_columns(id),
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
        );
    ")?;
    // Migrations for existing installs
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN task_id TEXT NOT NULL DEFAULT '';");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN due_date TEXT;");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN notify_before_minutes INTEGER NOT NULL DEFAULT 60;");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN notification_sent INTEGER NOT NULL DEFAULT 0;");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN project_id INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN folder_id INTEGER;");
    let _ = conn.execute_batch("ALTER TABLE tasks ADD COLUMN board_column_id INTEGER;");
    conn.execute_batch("UPDATE tasks SET task_id='TM-'||printf('%04d',id) WHERE task_id='';")?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |r| r.get(0))?;
    if count == 0 {
        conn.execute("INSERT INTO users (email,password_hash) VALUES (?1,?2)",
            params!["stdinushan@gmail.com", hash_password("Password@123")])?;
    }
    Ok(())
}

fn hash_password(p: &str) -> String { hex::encode(Sha256::digest(p.as_bytes())) }

fn record_history(conn: &Connection, task_id: i64, action: &str, detail: &str) {
    let _ = conn.execute(
        "INSERT INTO task_history (task_id,action,detail) VALUES (?1,?2,?3)",
        params![task_id, action, detail],
    );
}

// ─── Task helpers ─────────────────────────────────────────────────────────────

const TASK_SEL: &str =
    "SELECT id,task_id,title,description,completed,priority,due_date,
            notify_before_minutes,notification_sent,project_id,folder_id,board_column_id,created_at
     FROM tasks";

fn row_to_task(r: &rusqlite::Row) -> rusqlite::Result<Task> {
    Ok(Task {
        id: r.get(0)?, task_id: r.get(1)?, title: r.get(2)?, description: r.get(3)?,
        completed: r.get::<_,i32>(4)? != 0, priority: r.get(5)?, due_date: r.get(6)?,
        notify_before_minutes: r.get(7)?, notification_sent: r.get::<_,i32>(8)? != 0,
        project_id: r.get(9)?, folder_id: r.get(10)?, board_column_id: r.get(11)?,
        created_at: r.get(12)?,
    })
}

// ─── Task commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn get_tasks(state: State<AppState>) -> Result<Vec<Task>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut s = db.prepare(&format!("{} ORDER BY created_at DESC", TASK_SEL)).map_err(|e| e.to_string())?;
    let t = s.query_map([], row_to_task).map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(t)
}

#[tauri::command]
fn create_task(
    title: String, description: String, priority: String,
    due_date: Option<String>, notify_before_minutes: i64,
    project_id: Option<i64>, folder_id: Option<i64>, board_column_id: Option<i64>,
    state: State<AppState>,
) -> Result<Task, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO tasks (task_id,title,description,priority,due_date,notify_before_minutes,project_id,folder_id,board_column_id)
         VALUES ('TMP',?1,?2,?3,?4,?5,?6,?7,?8)",
        params![title,description,priority,due_date,notify_before_minutes,project_id,folder_id,board_column_id],
    ).map_err(|e| e.to_string())?;
    let id = db.last_insert_rowid();
    db.execute("UPDATE tasks SET task_id=?1 WHERE id=?2", params![format!("TM-{:04}",id),id]).map_err(|e| e.to_string())?;
    record_history(&db, id, "created", "");
    db.query_row(&format!("{} WHERE id=?1", TASK_SEL), params![id], row_to_task).map_err(|e| e.to_string())
}

#[tauri::command]
fn toggle_task(id: i64, state: State<AppState>) -> Result<bool, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE tasks SET completed=CASE WHEN completed=0 THEN 1 ELSE 0 END WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    let done: i32 = db.query_row("SELECT completed FROM tasks WHERE id=?1", params![id], |r| r.get(0)).map_err(|e| e.to_string())?;
    record_history(&db, id, if done != 0 { "completed" } else { "reopened" }, "");
    Ok(done != 0)
}

#[tauri::command]
fn delete_task(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM task_history WHERE task_id=?1", params![id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM tasks WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn update_task(
    id: i64, title: String, description: String, priority: String,
    due_date: Option<String>, notify_before_minutes: i64,
    project_id: Option<i64>, folder_id: Option<i64>,
    state: State<AppState>,
) -> Result<Task, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute(
        "UPDATE tasks SET title=?1,description=?2,priority=?3,due_date=?4,
                          notify_before_minutes=?5,notification_sent=0,project_id=?6,folder_id=?7
         WHERE id=?8",
        params![title,description,priority,due_date,notify_before_minutes,project_id,folder_id,id],
    ).map_err(|e| e.to_string())?;
    record_history(&db, id, "edited", "");
    db.query_row(&format!("{} WHERE id=?1", TASK_SEL), params![id], row_to_task).map_err(|e| e.to_string())
}

#[tauri::command]
fn move_task_to_column(task_id: i64, column_id: i64, state: State<AppState>) -> Result<Task, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let from: Option<String> = db.query_row(
        "SELECT bc.name FROM board_columns bc JOIN tasks t ON t.board_column_id=bc.id WHERE t.id=?1",
        params![task_id], |r| r.get(0),
    ).ok();
    let to: String = db.query_row("SELECT name FROM board_columns WHERE id=?1", params![column_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    db.execute("UPDATE tasks SET board_column_id=?1 WHERE id=?2", params![column_id,task_id]).map_err(|e| e.to_string())?;
    let detail = from.map_or_else(|| format!("Added to \"{}\"", to), |f| format!("Moved from \"{}\" to \"{}\"", f, to));
    record_history(&db, task_id, "moved", &detail);
    db.query_row(&format!("{} WHERE id=?1", TASK_SEL), params![task_id], row_to_task).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_task_history(task_id: i64, state: State<AppState>) -> Result<Vec<TaskHistoryEntry>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut s = db.prepare("SELECT id,task_id,action,detail,created_at FROM task_history WHERE task_id=?1 ORDER BY created_at").map_err(|e| e.to_string())?;
    let h = s.query_map(params![task_id], |r| Ok(TaskHistoryEntry {
        id: r.get(0)?, task_id: r.get(1)?, action: r.get(2)?, detail: r.get(3)?, created_at: r.get(4)?,
    })).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(h)
}

// ─── Project commands ─────────────────────────────────────────────────────────

fn row_to_project(r: &rusqlite::Row) -> rusqlite::Result<Project> {
    Ok(Project { id: r.get(0)?, name: r.get(1)?, description: r.get(2)?, color: r.get(3)?, created_at: r.get(4)? })
}
#[tauri::command]
fn get_projects(state: State<AppState>) -> Result<Vec<Project>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut s = db.prepare("SELECT id,name,description,color,created_at FROM projects ORDER BY name").map_err(|e| e.to_string())?;
    let p = s.query_map([], row_to_project).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(p)
}
#[tauri::command]
fn create_project(name: String, description: String, color: String, state: State<AppState>) -> Result<Project, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("INSERT INTO projects (name,description,color) VALUES (?1,?2,?3)", params![name,description,color]).map_err(|e| e.to_string())?;
    let id = db.last_insert_rowid();
    db.query_row("SELECT id,name,description,color,created_at FROM projects WHERE id=?1", params![id], row_to_project).map_err(|e| e.to_string())
}
#[tauri::command]
fn update_project(id: i64, name: String, description: String, color: String, state: State<AppState>) -> Result<Project, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE projects SET name=?1,description=?2,color=?3 WHERE id=?4", params![name,description,color,id]).map_err(|e| e.to_string())?;
    db.query_row("SELECT id,name,description,color,created_at FROM projects WHERE id=?1", params![id], row_to_project).map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_project(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE tasks SET project_id=NULL,folder_id=NULL WHERE project_id=?1", params![id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM folders WHERE project_id=?1", params![id]).map_err(|e| e.to_string())?;
    let board_ids: Vec<i64> = {
        let mut s = db.prepare("SELECT id FROM boards WHERE project_id=?1").map_err(|e| e.to_string())?;
        let x = s.query_map(params![id], |r| r.get(0)).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?; x
    };
    for bid in board_ids {
        db.execute("UPDATE tasks SET board_column_id=NULL WHERE board_column_id IN (SELECT id FROM board_columns WHERE board_id=?1)", params![bid]).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM board_columns WHERE board_id=?1", params![bid]).map_err(|e| e.to_string())?;
        db.execute("DELETE FROM boards WHERE id=?1", params![bid]).map_err(|e| e.to_string())?;
    }
    db.execute("DELETE FROM projects WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Folder commands ──────────────────────────────────────────────────────────

fn row_to_folder(r: &rusqlite::Row) -> rusqlite::Result<Folder> {
    Ok(Folder { id: r.get(0)?, project_id: r.get(1)?, parent_id: r.get(2)?, name: r.get(3)?, created_at: r.get(4)? })
}
#[tauri::command]
fn get_folders(project_id: i64, state: State<AppState>) -> Result<Vec<Folder>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let mut s = db.prepare("SELECT id,project_id,parent_id,name,created_at FROM folders WHERE project_id=?1 ORDER BY name").map_err(|e| e.to_string())?;
    let f = s.query_map(params![project_id], row_to_folder).map_err(|e| e.to_string())?.collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?;
    Ok(f)
}
#[tauri::command]
fn create_folder(project_id: i64, parent_id: Option<i64>, name: String, state: State<AppState>) -> Result<Folder, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("INSERT INTO folders (project_id,parent_id,name) VALUES (?1,?2,?3)", params![project_id,parent_id,name]).map_err(|e| e.to_string())?;
    let id = db.last_insert_rowid();
    db.query_row("SELECT id,project_id,parent_id,name,created_at FROM folders WHERE id=?1", params![id], row_to_folder).map_err(|e| e.to_string())
}
#[tauri::command]
fn rename_folder(id: i64, name: String, state: State<AppState>) -> Result<Folder, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE folders SET name=?1 WHERE id=?2", params![name,id]).map_err(|e| e.to_string())?;
    db.query_row("SELECT id,project_id,parent_id,name,created_at FROM folders WHERE id=?1", params![id], row_to_folder).map_err(|e| e.to_string())
}
fn delete_folder_rec(db: &Connection, id: i64) -> rusqlite::Result<()> {
    let children: Vec<i64> = {
        let mut s = db.prepare("SELECT id FROM folders WHERE parent_id=?1")?;
        let x = s.query_map(params![id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?; x
    };
    for cid in children { delete_folder_rec(db, cid)?; }
    db.execute("UPDATE tasks SET folder_id=NULL WHERE folder_id=?1", params![id])?;
    db.execute("DELETE FROM folders WHERE id=?1", params![id])?;
    Ok(())
}
#[tauri::command]
fn delete_folder(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    delete_folder_rec(&db, id).map_err(|e| e.to_string())
}

// ─── Board commands ───────────────────────────────────────────────────────────

fn load_board(db: &Connection, id: i64) -> rusqlite::Result<Board> {
    let (bid, pid, name, cat) = db.query_row(
        "SELECT id,project_id,name,created_at FROM boards WHERE id=?1", params![id],
        |r| Ok((r.get::<_,i64>(0)?, r.get::<_,Option<i64>>(1)?, r.get::<_,String>(2)?, r.get::<_,String>(3)?)),
    )?;
    let cols: Vec<BoardColumn> = {
        let mut s = db.prepare("SELECT id,board_id,name,position,color FROM board_columns WHERE board_id=?1 ORDER BY position")?;
        let x = s.query_map(params![bid], |r| Ok(BoardColumn { id: r.get(0)?, board_id: r.get(1)?, name: r.get(2)?, position: r.get(3)?, color: r.get(4)? }))?
            .collect::<rusqlite::Result<Vec<_>>>()?; x
    };
    Ok(Board { id: bid, project_id: pid, name, columns: cols, created_at: cat })
}
#[tauri::command]
fn get_boards(project_id: Option<i64>, state: State<AppState>) -> Result<Vec<Board>, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let ids: Vec<i64> = {
        let sql = if project_id.is_some() {
            "SELECT id FROM boards WHERE project_id=?1 ORDER BY created_at"
        } else {
            "SELECT id FROM boards WHERE project_id IS NULL ORDER BY created_at"
        };
        let mut s = db.prepare(sql).map_err(|e| e.to_string())?;
        let x = s.query_map(params![project_id], |r| r.get(0)).map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>().map_err(|e| e.to_string())?; x
    };
    ids.iter().map(|&id| load_board(&db, id).map_err(|e| e.to_string())).collect()
}
#[tauri::command]
fn create_board(project_id: Option<i64>, name: String, state: State<AppState>) -> Result<Board, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("INSERT INTO boards (project_id,name) VALUES (?1,?2)", params![project_id,name]).map_err(|e| e.to_string())?;
    let bid = db.last_insert_rowid();
    for (i,(n,c)) in [("Created","#6b7280"),("In Progress","#fbbf24"),("Completed","#4ade80")].iter().enumerate() {
        db.execute("INSERT INTO board_columns (board_id,name,position,color) VALUES (?1,?2,?3,?4)", params![bid,n,i as i64,c]).map_err(|e| e.to_string())?;
    }
    load_board(&db, bid).map_err(|e| e.to_string())
}
#[tauri::command]
fn rename_board(id: i64, name: String, state: State<AppState>) -> Result<Board, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE boards SET name=?1 WHERE id=?2", params![name,id]).map_err(|e| e.to_string())?;
    load_board(&db, id).map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_board(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE tasks SET board_column_id=NULL WHERE board_column_id IN (SELECT id FROM board_columns WHERE board_id=?1)", params![id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM board_columns WHERE board_id=?1", params![id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM boards WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn create_board_column(board_id: i64, name: String, color: String, state: State<AppState>) -> Result<Board, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let pos: i64 = db.query_row("SELECT COALESCE(MAX(position)+1,0) FROM board_columns WHERE board_id=?1", params![board_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    db.execute("INSERT INTO board_columns (board_id,name,position,color) VALUES (?1,?2,?3,?4)", params![board_id,name,pos,color]).map_err(|e| e.to_string())?;
    load_board(&db, board_id).map_err(|e| e.to_string())
}
#[tauri::command]
fn update_board_column(id: i64, name: String, color: String, state: State<AppState>) -> Result<BoardColumn, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE board_columns SET name=?1,color=?2 WHERE id=?3", params![name,color,id]).map_err(|e| e.to_string())?;
    db.query_row("SELECT id,board_id,name,position,color FROM board_columns WHERE id=?1", params![id],
        |r| Ok(BoardColumn { id: r.get(0)?, board_id: r.get(1)?, name: r.get(2)?, position: r.get(3)?, color: r.get(4)? }),
    ).map_err(|e| e.to_string())
}
#[tauri::command]
fn delete_board_column(id: i64, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("UPDATE tasks SET board_column_id=NULL WHERE board_column_id=?1", params![id]).map_err(|e| e.to_string())?;
    db.execute("DELETE FROM board_columns WHERE id=?1", params![id]).map_err(|e| e.to_string())?;
    Ok(())
}

// ─── Auth commands ────────────────────────────────────────────────────────────

#[tauri::command]
fn login(email: String, password: String, state: State<AppState>) -> Result<LoginResult, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    let hash = hash_password(&password);
    let (uid, uemail) = db.query_row(
        "SELECT id,email FROM users WHERE email=?1 AND password_hash=?2",
        params![email,hash], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?)),
    ).map_err(|_| "Invalid email or password.".to_string())?;
    let _ = db.execute("DELETE FROM sessions WHERE user_id=?1 AND expires_at < datetime('now')", params![uid]);
    let token = Uuid::new_v4().to_string();
    let exp = (Utc::now() + chrono::Duration::days(30)).to_rfc3339();
    db.execute("INSERT INTO sessions (user_id,token,expires_at) VALUES (?1,?2,?3)", params![uid,token,exp]).map_err(|e| e.to_string())?;
    Ok(LoginResult { token, user: UserInfo { id: uid, email: uemail } })
}
#[tauri::command]
fn logout(token: String, state: State<AppState>) -> Result<(), String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.execute("DELETE FROM sessions WHERE token=?1", params![token]).map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
fn check_session(token: String, state: State<AppState>) -> Result<UserInfo, String> {
    let db = state.db.lock().map_err(|e| e.to_string())?;
    db.query_row(
        "SELECT u.id,u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?1 AND s.expires_at>datetime('now')",
        params![token], |r| Ok(UserInfo { id: r.get(0)?, email: r.get(1)? }),
    ).map_err(|_| "Session expired or invalid.".to_string())
}

// ─── Notification thread ──────────────────────────────────────────────────────

fn start_notification_thread(db: Arc<Mutex<Connection>>, app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(60));
        let due: Vec<(i64,String,String,i64)> = {
            let Ok(c) = db.lock() else { continue };
            let Ok(mut s) = c.prepare(
                "SELECT id,task_id,title,notify_before_minutes FROM tasks
                 WHERE completed=0 AND notification_sent=0 AND due_date IS NOT NULL
                   AND datetime(due_date,'-'||CAST(notify_before_minutes AS TEXT)||' minutes')<=datetime('now')"
            ) else { continue };
            s.query_map([],|r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))
                .and_then(|rows| rows.collect()).unwrap_or_default()
        };
        for (id,tid,title,mins) in due {
            let body = if mins>=1440 { format!("\"{}\" due in {} day(s)",title,mins/1440) }
                       else if mins>=60 { format!("\"{}\" due in {} hr(s)",title,mins/60) }
                       else { format!("\"{}\" due in {} min",title,mins) };
            let _ = app.notification().builder().title(format!("⏰ {}",tid)).body(body).show();
            let Ok(c) = db.lock() else { continue };
            let _ = c.execute("UPDATE tasks SET notification_sent=1 WHERE id=?1", params![id]);
        }
    });
}

// ─── Run ─────────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let dir = app.path().app_data_dir().expect("app data dir");
            std::fs::create_dir_all(&dir).expect("create data dir");
            let conn = Connection::open(dir.join("tasks.db")).expect("open db");
            init_db(&conn).expect("init db");
            let db = Arc::new(Mutex::new(conn));
            start_notification_thread(db.clone(), app.handle().clone());
            app.manage(AppState { db });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_tasks, create_task, toggle_task, delete_task, update_task,
            move_task_to_column, get_task_history,
            get_projects, create_project, update_project, delete_project,
            get_folders, create_folder, rename_folder, delete_folder,
            get_boards, create_board, rename_board, delete_board,
            create_board_column, update_board_column, delete_board_column,
            login, logout, check_session,
        ])
        .run(tauri::generate_context!())
        .expect("error running app")
}
