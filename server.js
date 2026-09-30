const express = require("express");
const cors = require("cors");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const app = express();
app.use(cors());
// The frontend resizes images before sending them.
app.use(express.json({ limit: "5mb" }));

const DATA_DIR = path.join(__dirname, "data");
const LEGACY_FILE = path.join(DATA_DIR, "grievances.json");
const DB_FILE = path.join(DATA_DIR, "smart-grievance.sqlite");
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
const sessions = new Map();

db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        identity TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('user', 'department')),
        department TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS grievances (
        id TEXT PRIMARY KEY,
        user_id INTEGER,
        name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        pincode TEXT NOT NULL,
        area TEXT NOT NULL,
        district TEXT NOT NULL,
        category TEXT NOT NULL,
        priority TEXT NOT NULL,
        description TEXT NOT NULL,
        ward TEXT,
        location TEXT,
        department TEXT,
        photo TEXT,
        photo_name TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        history TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    );
`);

// Add feedback fields to existing SQLite databases without deleting any data.
const grievanceColumns = db.prepare("PRAGMA table_info(grievances)").all().map(column => column.name);
if(!grievanceColumns.includes("feedback_rating")) db.exec("ALTER TABLE grievances ADD COLUMN feedback_rating INTEGER");
if(!grievanceColumns.includes("feedback_comment")) db.exec("ALTER TABLE grievances ADD COLUMN feedback_comment TEXT");
if(!grievanceColumns.includes("feedback_at")) db.exec("ALTER TABLE grievances ADD COLUMN feedback_at TEXT");

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
    const hash = crypto.scryptSync(password, salt, 64).toString("hex");
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, expected] = String(stored).split(":");
    if (!salt || !expected) return false;
    const actual = crypto.scryptSync(password, salt, 64).toString("hex");
    return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

function createUser(name, identity, password, role, department = null) {
    const now = new Date().toISOString();
    const normalizedIdentity = identity.toLowerCase();
    db.prepare(`INSERT INTO users (name, identity, password_hash, role, department, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(identity) DO UPDATE SET
            name = excluded.name,
            password_hash = excluded.password_hash,
            role = excluded.role,
            department = excluded.department`)
        .run(name, normalizedIdentity, hashPassword(password), role, department, now);
}

// Local demo accounts keep the prototype immediately usable.
createUser("Demo User", "demo.user@example.com", "user1234", "user");
createUser("Water Works Officer", "water.department@example.com", "dept1234", "department", "Water Works Department");
createUser("Electrical Officer", "electrical.department@example.com", "dept1234", "department", "Electrical Department");
createUser("Sanitation Officer", "sanitation.department@example.com", "dept1234", "department", "Sanitation Department");
createUser("Public Works Officer", "publicworks.department@example.com", "dept1234", "department", "Public Works Department");
createUser("Health Officer", "health.department@example.com", "dept1234", "department", "Health Department");
createUser("Education Officer", "education.department@example.com", "dept1234", "department", "Education Department");
createUser("Public Safety Officer", "safety.department@example.com", "dept1234", "department", "Public Safety Department");
createUser("Grievance Cell Officer", "grievance.department@example.com", "dept1234", "department", "Public Grievance Cell");

function readLegacyGrievances() {
    try { return JSON.parse(fs.readFileSync(LEGACY_FILE, "utf8")); }
    catch (error) { return error.code === "ENOENT" ? [] : []; }
}

function mapGrievance(row) {
    return {
        id: row.id, name: row.name, mobile: row.mobile, pincode: row.pincode,
        area: row.area, district: row.district, category: row.category,
        priority: row.priority, description: row.description, ward: row.ward || "",
        location: row.location || "", department: row.department || "Public Grievance Cell",
        photo: row.photo || "", photoName: row.photo_name || "", status: row.status,
        createdAt: row.created_at, updatedAt: row.updated_at,
        history: JSON.parse(row.history || "[]"),
        feedback: row.feedback_rating == null ? null : { rating: Number(row.feedback_rating), comment: row.feedback_comment || "", submittedAt: row.feedback_at || "" }
    };
}

function grievanceRow(item) {
    const now = item.createdAt || new Date().toISOString();
    return [
        item.id, item.userId || null, String(item.name || ""), String(item.mobile || ""),
        String(item.pincode || ""), String(item.area || ""), String(item.district || ""),
        String(item.category || ""), String(item.priority || "Normal"), String(item.description || ""),
        String(item.ward || ""), String(item.location || ""), String(item.department || "Public Grievance Cell"),
        String(item.photo || ""), String(item.photoName || ""), String(item.status || "Pending"),
        now, item.updatedAt || now, JSON.stringify(item.history || [{ status: "Pending", at: now, note: "Grievance registered" }])
    ];
}

function migrateLegacyData() {
    const count = db.prepare("SELECT COUNT(*) AS count FROM grievances").get().count;
    if (Number(count) > 0) return;
    const insert = db.prepare(`INSERT OR IGNORE INTO grievances
        (id, user_id, name, mobile, pincode, area, district, category, priority, description, ward, location, department, photo, photo_name, status, created_at, updated_at, history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const item of readLegacyGrievances()) insert.run(...grievanceRow(item));
}
migrateLegacyData();

function nextId() {
    const year = new Date().getFullYear();
    const prefix = `GRV-${year}-`;
    const row = db.prepare("SELECT id FROM grievances WHERE id LIKE ? ORDER BY id DESC LIMIT 1").get(`${prefix}%`);
    const sequence = row ? Number(String(row.id).slice(prefix.length)) || 0 : 0;
    return `${prefix}${String(sequence + 1).padStart(3, "0")}`;
}

function publicUser(row) {
    return { id: row.id, name: row.name, identity: row.identity, role: row.role, department: row.department || "" };
}

function authUser(req) {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const userId = sessions.get(token);
    return userId ? db.prepare("SELECT * FROM users WHERE id = ?").get(userId) : null;
}

const AI_RULES = [
    { category: "Water Supply", department: "Water Works Department", keywords: ["water", "pipe", "leak", "drain", "sewage", "supply", "पानी", "नल", "लीकेज"], action: "Inspect the water line and route the case to the local water works team." },
    { category: "Street Light", department: "Electrical Department", keywords: ["street light", "streetlight", "lamp", "electric", "power", "wire", "बिजली", "लाइट", "स्ट्रीट लाइट"], action: "Schedule an electrical inspection and replace or repair the light point." },
    { category: "Sanitation", department: "Sanitation Department", keywords: ["garbage", "waste", "rubbish", "sanitation", "dump", "clean", "कचरा", "सफाई"], action: "Create a sanitation pickup request and inspect the affected area." },
    { category: "Road & Transport", department: "Public Works Department", keywords: ["road", "pothole", "traffic", "footpath", " सड़क", "गड्ढा", "सड़क"], action: "Verify the location and assign a public works inspection." },
    { category: "Healthcare", department: "Health Department", keywords: ["hospital", "health", "medicine", "doctor", "clinic", "अस्पताल", "स्वास्थ्य"], action: "Forward the case to the nearest health service authority." },
    { category: "Education", department: "Education Department", keywords: ["school", "teacher", "education", "classroom", "स्कूल", "शिक्षा"], action: "Route the complaint to the concerned education office." },
    { category: "Public Safety", department: "Public Safety Department", keywords: ["crime", "theft", "violence", "unsafe", "safety", "police", "चोरी", "सुरक्षा"], action: "Mark the case for priority safety review by the responsible authority." }
];

function analyzeComplaintText(text, hasPhoto) {
    const lower = text.toLowerCase();
    const ranked = AI_RULES.map(rule => ({ rule, matches: rule.keywords.filter(keyword => lower.includes(keyword.toLowerCase())) }))
        .filter(item => item.matches.length)
        .sort((a, b) => b.matches.length - a.matches.length);
    const best = ranked[0] || { rule: { category: "Other", department: "Public Grievance Cell", action: "Review the complaint manually and route it to the appropriate civic team." }, matches: [] };
    const urgentWords = ["urgent", "emergency", "danger", "burst", "flood", "fire", "injury", "injured", "accident", "exposed wire", "आपात", "खतरा", "बाढ़"];
    const urgent = urgentWords.some(word => lower.includes(word));
    const priority = urgent ? "Urgent" : (text.length > 180 ? "Important" : "Normal");
    const confidence = Math.min(97, Math.max(64, 64 + (best.matches.length * 9) + (hasPhoto ? 5 : 0) + (urgent ? 3 : 0)));
    const summary = text.length > 150 ? `${text.slice(0, 147).trim()}…` : text;
    return { category: best.rule.category, department: best.rule.department, priority, confidence, summary, explanation: best.matches.length ? `Matched signals: ${best.matches.join(", ")}.` : "No strong category signal found; human review is recommended.", recommendedAction: best.rule.action, photoInsight: hasPhoto ? "Photo evidence attached for officer review." : "No photo attached; adding one can improve verification.", urgent };
}

function similarityScore(first, second) {
    const words = value => new Set(String(value).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(word => word.length > 3));
    const a = words(first), b = words(second);
    if (!a.size || !b.size) return 0;
    let shared = 0; a.forEach(word => { if (b.has(word)) shared += 1; });
    return shared / Math.max(a.size, b.size);
}

app.get("/", (req, res) => res.send("Smart Grievance Backend is Running!"));

app.post("/api/ai/analyze", (req, res) => {
    const text = String(req.body?.text || "").trim();
    const hasPhoto = Boolean(req.body?.hasPhoto);
    if (!text) return res.status(400).json({ error: "Complaint text is required for AI analysis." });
    const analysis = analyzeComplaintText(text, hasPhoto);
    const recent = db.prepare("SELECT id, description, category, department FROM grievances ORDER BY created_at DESC LIMIT 50").all();
    const duplicate = recent.map(item => ({ ...item, score: similarityScore(text, item.description) })).sort((a, b) => b.score - a.score)[0];
    const duplicateWarning = duplicate && duplicate.score >= 0.55 ? { id: duplicate.id, score: Math.round(duplicate.score * 100), category: duplicate.category, department: duplicate.department } : null;
    return res.json({ analysis, duplicateWarning, model: "Smart Triage Rules v2 (Hindi-English)" });
});

app.post("/api/auth/register", (req, res) => {
    const name = String(req.body?.name || "").trim();
    const identity = String(req.body?.identity || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!name || !identity || password.length < 6) return res.status(400).json({ error: "Name, email/mobile and a password of at least 6 characters are required." });
    try {
        if (db.prepare("SELECT id FROM users WHERE identity = ?").get(identity)) return res.status(409).json({ error: "An account with this email/mobile already exists." });
        createUser(name, identity, password, "user");
        const user = db.prepare("SELECT * FROM users WHERE identity = ?").get(identity);
        return res.status(201).json({ message: "Account created.", user: publicUser(user) });
    } catch (error) {
        if (String(error.message).includes("UNIQUE")) return res.status(409).json({ error: "An account with this email/mobile already exists." });
        throw error;
    }
});

app.post("/api/auth/login", (req, res) => {
    const identity = String(req.body?.identity || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const requestedRole = String(req.body?.role || "user");
    const department = String(req.body?.department || "").trim();
    const user = db.prepare("SELECT * FROM users WHERE identity = ?").get(identity);
    if (!user || user.role !== requestedRole || !verifyPassword(password, user.password_hash) || (requestedRole === "department" && user.department !== department)) {
        return res.status(401).json({ error: "Invalid login details." });
    }
    const token = crypto.randomBytes(24).toString("hex");
    sessions.set(token, user.id);
    return res.json({ message: "Login successful.", token, user: publicUser(user) });
});

app.post("/api/grievances/check-duplicates", (req, res) => {
    const user = authUser(req);
    if (!user || user.role !== "user") return res.status(401).json({ error: "User login required." });
    const category = String(req.body?.category ?? "").trim();
    const area = String(req.body?.area ?? "").trim();
    const district = String(req.body?.district ?? "").trim();
    const pincode = String(req.body?.pincode ?? "").trim();
    const department = String(req.body?.department ?? "").trim();
    if (!category || !area || !district || !pincode || !department) return res.json({ matches: [] });
    const rows = db.prepare(
        "SELECT id, category, department, area, district, pincode, status, created_at, description FROM grievances WHERE lower(category) = lower(?) AND lower(area) = lower(?) AND lower(district) = lower(?) AND pincode = ? AND lower(department) = lower(?) AND status <> 'Resolved' ORDER BY created_at DESC LIMIT 8"
    ).all(category, area, district, pincode, department);
    return res.json({ matches: rows.map(row => ({ id: row.id, category: row.category, department: row.department, area: row.area, status: row.status, createdAt: row.created_at, summary: String(row.description || "").slice(0, 140) })) });
});

app.post("/api/grievances", (req, res) => {
    const fields = ["name", "mobile", "pincode", "area", "district", "category", "priority", "description"];
    const grievance = {};
    for (const field of fields) grievance[field] = String(req.body?.[field] ?? "").trim();
    grievance.ward = String(req.body?.ward ?? "").trim();
    grievance.location = String(req.body?.location ?? "").trim();
    grievance.department = String(req.body?.department ?? "Public Grievance Cell").trim();
    grievance.photo = String(req.body?.photo ?? "");
    grievance.photoName = String(req.body?.photoName ?? "").trim();
    const user = authUser(req);
    if (!user || user.role !== "user") return res.status(401).json({ error: "User login is required before submitting a grievance." });
    grievance.userId = user.id;
    const missing = ["name", "mobile", "pincode", "area", "district", "category", "description"].filter(field => !grievance[field]);
    if (missing.length) return res.status(400).json({ error: "Required fields are missing.", fields: missing });
    if (!/^\d{10}$/.test(grievance.mobile)) return res.status(400).json({ error: "Mobile number must contain 10 digits." });
    if (!/^\d{6}$/.test(grievance.pincode)) return res.status(400).json({ error: "Pincode must contain 6 digits." });
    if (grievance.description.length > 5000) return res.status(400).json({ error: "Description is too long." });
    if (grievance.photo && !grievance.photo.startsWith("data:image/")) return res.status(400).json({ error: "Photo must be a valid image." });
    const existing = db.prepare(
        "SELECT * FROM grievances WHERE lower(category) = lower(?) AND lower(area) = lower(?) AND lower(district) = lower(?) AND pincode = ? AND lower(department) = lower(?) AND status <> 'Resolved' ORDER BY created_at ASC LIMIT 1"
    ).get(grievance.category, grievance.area, grievance.district, grievance.pincode, grievance.department);
    if (existing) {
        return res.json({ message: "This problem is already registered at the same place.", duplicate: true, grievance: mapGrievance(existing) });
    }
    const now = new Date().toISOString();
    const saved = { id: nextId(), ...grievance, status: "Pending", createdAt: now, updatedAt: now, history: [{ status: "Pending", at: now, note: "Grievance registered" }] };
    db.prepare(`INSERT INTO grievances
        (id, user_id, name, mobile, pincode, area, district, category, priority, description, ward, location, department, photo, photo_name, status, created_at, updated_at, history)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...grievanceRow(saved));
    return res.status(201).json({ message: "Grievance submitted successfully.", grievance: saved });
});

app.get("/api/grievances/:id", (req, res) => {
    const row = db.prepare("SELECT * FROM grievances WHERE lower(id) = lower(?)").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Grievance not found." });
    return res.json(mapGrievance(row));
});

app.get("/api/grievances", (req, res) => {
    const rows = db.prepare("SELECT * FROM grievances ORDER BY created_at DESC").all();
    const grievances = rows.map(mapGrievance);
    return res.json({ total: grievances.length, counts: { pending: grievances.filter(item => item.status === "Pending").length, inProgress: grievances.filter(item => item.status === "In Progress").length, resolved: grievances.filter(item => item.status === "Resolved").length }, grievances });
});

// Citizens see only their own complaints after login. Public tracking by grievance ID remains available.
app.get("/api/me/grievances", (req, res) => {
    const user = authUser(req);
    if (!user || user.role !== "user") return res.status(401).json({ error: "User login required." });
    const grievances = db.prepare("SELECT * FROM grievances WHERE user_id = ? ORDER BY created_at DESC").all(user.id).map(mapGrievance);
    return res.json({ total: grievances.length, grievances });
});

// Department officers see only cases routed to their own department.
app.get("/api/department/grievances", (req, res) => {
    const user = authUser(req);
    if (!user || user.role !== "department") return res.status(401).json({ error: "Department login required." });
    const grievances = db.prepare("SELECT * FROM grievances WHERE department = ? ORDER BY created_at DESC").all(user.department).map(mapGrievance);
    return res.json({ department: user.department, total: grievances.length, grievances });
});

app.patch("/api/grievances/:id/status", (req, res) => {
    const user = authUser(req);
    if (!user || user.role !== "department") return res.status(401).json({ error: "Department login required." });
    const allowed = ["Pending", "In Progress", "Resolved"];
    const status = String(req.body?.status ?? "");
    if (!allowed.includes(status)) return res.status(400).json({ error: "Status must be Pending, In Progress, or Resolved." });
    const row = db.prepare("SELECT * FROM grievances WHERE lower(id) = lower(?)").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Grievance not found." });
    const history = JSON.parse(row.history || "[]");
    const now = new Date().toISOString();
    history.push({ status, at: now, note: String(req.body?.note ?? `Updated by ${user.department}`) });
    db.prepare("UPDATE grievances SET status = ?, updated_at = ?, history = ? WHERE id = ?").run(status, now, JSON.stringify(history), row.id);
    return res.json({ message: "Status updated.", grievance: mapGrievance(db.prepare("SELECT * FROM grievances WHERE id = ?").get(row.id)) });
});

// Citizens can submit one rating/comment after their complaint is resolved.
app.post("/api/grievances/:id/feedback", (req, res) => {
    const rating = Number(req.body?.rating);
    const comment = String(req.body?.comment ?? "").trim();
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be a whole number from 1 to 5." });
    if (comment.length > 500) return res.status(400).json({ error: "Feedback comment must be 500 characters or less." });
    const row = db.prepare("SELECT * FROM grievances WHERE lower(id) = lower(?)").get(req.params.id);
    if (!row) return res.status(404).json({ error: "Grievance not found." });
    if (row.status !== "Resolved") return res.status(400).json({ error: "Feedback becomes available after the grievance is resolved." });
    if (row.feedback_rating != null) return res.status(409).json({ error: "Feedback has already been submitted for this grievance." });
    const user = authUser(req);
    if (row.user_id && (!user || user.role !== "user" || user.id !== row.user_id)) return res.status(403).json({ error: "Please login with the citizen account used for this grievance." });
    const now = new Date().toISOString();
    db.prepare("UPDATE grievances SET feedback_rating = ?, feedback_comment = ?, feedback_at = ? WHERE id = ?").run(rating, comment, now, row.id);
    return res.status(201).json({ message: "Thank you for your feedback.", grievance: mapGrievance(db.prepare("SELECT * FROM grievances WHERE id = ?").get(row.id)) });
});

app.use((error, req, res, next) => { console.error(error); res.status(500).json({ error: "Internal server error." }); });

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log("================================");
    console.log("Smart Grievance Backend Started");
    console.log(`http://localhost:${PORT}`);
    console.log(`SQLite database: ${DB_FILE}`);
    console.log("================================");
});
