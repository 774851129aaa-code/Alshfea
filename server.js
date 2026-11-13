const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

/* =====================================
   إعدادات النظام
===================================== */

const TIME_ZONE = process.env.APP_TIME_ZONE || 'Asia/Aden';
const CLINIC_START_TIME = process.env.CLINIC_START_TIME || '09:00';
const APPOINTMENT_DURATION = 20;

const DATA_DIR = path.join(__dirname, 'data');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const DB_FILE = path.join(DATA_DIR, 'appointments.json');

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '[]\n', 'utf8');
}

// إعداد البروكسي للحصول على IP الزائر عند النشر خلف Render.
// يجب أن تتوافق قيمة الثقة مع إعداد البروكسي الفعلي.
app.set('trust proxy', 1);

app.use(express.json({ limit: '100kb' }));

/* =====================================
   إعدادات الوقت
===================================== */

function getDateParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).formatToParts(date);

    const result = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            result[part.type] = part.value;
        }
    }

    return result;
}

function getTimeParts(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone: TIME_ZONE,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23'
    }).formatToParts(date);

    const result = {};

    for (const part of parts) {
        if (part.type !== 'literal') {
            result[part.type] = part.value;
        }
    }

    return result;
}

function localDateString(date = new Date()) {
    const p = getDateParts(date);

    return `${p.year}-${p.month}-${p.day}`;
}

function currentMinutes(date = new Date()) {
    const p = getTimeParts(date);

    return Number(p.hour) * 60 + Number(p.minute);
}

function dateFromMinutes(minutes) {
    const normalized = Math.max(0, minutes);

    const hours = Math.floor(normalized / 60) % 24;
    const mins = normalized % 60;

    return (
        String(hours).padStart(2, '0') +
        ':' +
        String(mins).padStart(2, '0')
    );
}

function minutesFromTime(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ''));

    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) {
        return null;
    }

    return hours * 60 + minutes;
}

function minutesFromISO(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return currentMinutes(date);
}

function dateOfISO(value) {
    if (!value) {
        return null;
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return localDateString(date);
}

function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - 1 &&
        parsed.getUTCDate() === day
    );
}

function validClinicStartTime() {
    return minutesFromTime(CLINIC_START_TIME) !== null;
}

if (!validClinicStartTime()) {
    throw new Error('CLINIC_START_TIME غير صحيح. استخدم الصيغة 09:00');
}

/* =====================================
   إعدادات الملفات
===================================== */

const allowedTypes = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp'
};

const storage = multer.diskStorage({
    destination: (_req, _file, callback) => {
        callback(null, RECEIPTS_DIR);
    },

    filename: (_req, file, callback) => {
        const ext = allowedTypes[file.mimetype];

        callback(
            null,
            `${Date.now()}-${crypto.randomUUID()}${ext || ''}`
        );
    }
});

const upload = multer({
    storage,

    limits: {
        fileSize: 5 * 1024 * 1024,
        files: 1
    },

    fileFilter: (_req, file, callback) => {
        if (!allowedTypes[file.mimetype]) {
            return callback(
                new Error('نوع صورة السند غير مسموح')
            );
        }

        callback(null, true);
    }
});

/* =====================================
   قاعدة البيانات JSON
===================================== */

function readAppointments() {
    try {
        const value = JSON.parse(
            fs.readFileSync(DB_FILE, 'utf8')
        );

        return Array.isArray(value) ? value : [];

    } catch (error) {
        console.error('تعذر قراءة المواعيد:', error);

        throw new Error('تعذر قراءة ملف التخزين JSON');
    }
}

function writeAppointments(rows) {
    const tempFile = `${DB_FILE}.${process.pid}.tmp`;

    fs.writeFileSync(
        tempFile,
        `${JSON.stringify(rows, null, 2)}\n`,
        'utf8'
    );

    fs.renameSync(tempFile, DB_FILE);
}

/* =====================================
   أدوات عامة
===================================== */

// إخفاء البيانات الداخلية عن المستخدمين
function publicAppointment(row) {
    const {
        receiptFile,
        clientIP,
        ...safeRow
    } = row;

    return safeRow;
}

// توحيد شكل رقم الهاتف
function normalizePhone(value) {
    return String(value || '')
        .replace(/[\s()+-]/g, '');
}

// استخراج عنوان IP للزائر
function getClientIP(req) {
    return String(req.ip || '')
        .replace(/^::ffff:/, '')
        .trim();
}

// الحجوزات التي تمنع إنشاء حجز جديد
function isBlockingBooking(row) {
    return [
        'pending',
        'approved',
        'in_progress'
    ].includes(row.status);
}

function isActiveBooking(row) {
    return ['approved', 'in_progress'].includes(row.status);
}

function isScheduledReturn(row) {
    return ['scheduled', 'attended'].includes(row.returnStatus);
}

function getAppointmentCreatedTime(row) {
    return row.approvedAt || row.createdAt || '';
}

/* =====================================
   تحديث حالات العودة الفائتة
===================================== */

function updateMissedReturns(rows) {
    const today = localDateString();

    let changed = false;

    for (const row of rows) {
        if (
            row.returnStatus === 'scheduled' &&
            row.returnDate &&
            row.returnDate < today
        ) {
            row.returnStatus = 'missed';
            row.returnMissedAt = new Date().toISOString();
            row.returnQueue = null;
            row.returnTime = null;

            changed = true;
        }
    }

    return changed;
}

/* =====================================
   ترتيب المرضى وحساب أوقات الحضور
===================================== */

/*
   لكل طبيب ولكل يوم جدول مستقل.

   الأولوية:
   1- مواعيد العودة.
   2- الحجوزات العادية.

   مدة كل موعد: 20 دقيقة.

   إذا انتهى الكشف قبل الوقت المتوقع:
   يُعاد حساب أوقات المرضى المنتظرين
   ويُقدّم الموعد التالي تلقائيًا.

   أوقات الحضور:
   appointmentTime = وقت الحجز العادي
   returnTime      = وقت موعد العودة
*/

function rebuildQueues(rows, doctor, date) {

    const returns = rows.filter(row =>
        row.doctor === doctor &&
        row.returnDate === date &&
        isScheduledReturn(row)
    );

    const normalBookings = rows.filter(row =>
        row.doctor === doctor &&
        row.date === date &&
        isActiveBooking(row)
    );

    returns.sort((a, b) => {
        return new Date(
            a.returnScheduledAt || a.createdAt
        ) - new Date(
            b.returnScheduledAt || b.createdAt
        );
    });

    normalBookings.sort((a, b) => {
        return new Date(
            getAppointmentCreatedTime(a)
        ) - new Date(
            getAppointmentCreatedTime(b)
        );
    });

    const schedule = [
        ...returns.map(row => ({
            row,
            type: 'return'
        })),

        ...normalBookings.map(row => ({
            row,
            type: 'normal'
        }))
    ];

    const scheduleInfo = getClinicSchedule(doctor, date);
    const startMinutes = minutesFromTime(scheduleInfo.startTime) ?? minutesFromTime(CLINIC_START_TIME);

    let pointer = startMinutes;

    /*
       إذا كان اليوم هو اليوم الحالي:
       لا نعطي المريض موعدًا في وقت مضى.
    */

    if (date === localDateString()) {
        pointer = Math.max(pointer, currentMinutes());
    }

    /*
       آخر مريض أنهى الكشف بنجاح.
       نستخدم وقت انتهائه لتقديم المنتظرين.
    */

    const completedRows = rows.filter(row => {

        if (row.doctor !== doctor) {
            return false;
        }

        const normalCompleted =
            row.date === date &&
            row.status === 'completed' &&
            row.completedAt;

        const returnCompleted =
            row.returnDate === date &&
            row.returnStatus === 'completed' &&
            row.returnCompletedAt;

        return normalCompleted || returnCompleted;
    });

    for (const row of completedRows) {

        const completedAt =
            row.returnStatus === 'completed'
                ? row.returnCompletedAt
                : row.completedAt;

        if (dateOfISO(completedAt) !== date) {
            continue;
        }

        const completedMinute = minutesFromISO(completedAt);

        if (completedMinute !== null) {
            pointer = Math.max(pointer, completedMinute);
        }
    }

    let number = 1;

    for (const item of schedule) {

        const row = item.row;

        if (item.type === 'return') {

            row.returnQueue = number++;

            /*
               إذا بدأ الطبيب مراجعة العودة بالفعل،
               نستخدم وقت البداية.
            */

            if (row.returnStartedAt) {

                const startedMinute =
                    minutesFromISO(row.returnStartedAt);

                row.returnTime = dateFromMinutes(startedMinute);

                pointer = Math.max(
                    pointer,
                    startedMinute + APPOINTMENT_DURATION
                );

            } else {

                row.returnTime = dateFromMinutes(pointer);

                pointer += APPOINTMENT_DURATION;
            }

            continue;
        }

        row.queue = number++;

        /*
           المريض الذي بدأ الطبيب الكشف عليه:
           نحتفظ بوقت البداية الحقيقي.
        */

        if (row.status === 'in_progress' && row.startedAt) {

            const startedMinute =
                minutesFromISO(row.startedAt);

            row.appointmentTime = dateFromMinutes(startedMinute);

            pointer = Math.max(
                pointer,
                startedMinute + APPOINTMENT_DURATION
            );

        } else {

            row.appointmentTime = dateFromMinutes(pointer);

            pointer += APPOINTMENT_DURATION;
        }
    }

    /*
       إزالة أرقام وأوقات المرضى غير النشطين.
    */

    for (const row of rows) {

        if (
            row.doctor === doctor &&
            row.date === date &&
            !isActiveBooking(row)
        ) {
            row.queue = null;
            row.appointmentTime = null;
        }

        if (
            row.doctor === doctor &&
            row.returnDate === date &&
            !isScheduledReturn(row)
        ) {
            row.returnQueue = null;
            row.returnTime = null;
        }
    }
}

/* =====================================
   إعادة بناء جميع الجداول
===================================== */

function rebuildAllQueues(rows) {

    const groups = new Map();

    for (const row of rows) {

        if (
            row.doctor &&
            row.date &&
            isActiveBooking(row)
        ) {
            const key = `${row.doctor}|||${row.date}`;

            groups.set(key, {
                doctor: row.doctor,
                date: row.date
            });
        }

        if (
            row.doctor &&
            row.returnDate &&
            isScheduledReturn(row)
        ) {
            const key = `${row.doctor}|||${row.returnDate}`;

            groups.set(key, {
                doctor: row.doctor,
                date: row.returnDate
            });
        }
    }

    /*
       نضيف الأيام التي تحتوي على مرضى أنهوا الكشف،
       لأن وقت انتهائهم يؤثر على الجدول.
    */

    for (const row of rows) {

        if (
            row.doctor &&
            row.date &&
            row.status === 'completed'
        ) {
            const key = `${row.doctor}|||${row.date}`;

            groups.set(key, {
                doctor: row.doctor,
                date: row.date
            });
        }

        if (
            row.doctor &&
            row.returnDate &&
            row.returnStatus === 'completed'
        ) {
            const key = `${row.doctor}|||${row.returnDate}`;

            groups.set(key, {
                doctor: row.doctor,
                date: row.returnDate
            });
        }
    }

    for (const group of groups.values()) {
        rebuildQueues(
            rows,
            group.doctor,
            group.date
        );
    }
}

/* =====================================
   نظام الحماية ومنع تكرار الحجوزات
===================================== */

/*
   الحماية تعتمد على:

   1- عنوان IP:
      يمنع إرسال حجز آخر من نفس الاتصال
      إذا كان هناك حجز قائم.

   2- رقم الهاتف:
      يمنع تكرار رقم الهاتف حتى لو تغير الاسم
      أو الطبيب أو التاريخ أو صورة السند.

   3- الطبيب والتاريخ:
      يحافظ على منع التعارض في جدول الطبيب.

   الحالات التي تمنع الحجز:
   pending
   approved
   in_progress

   مواعيد العودة:
   scheduled
   attended

   الحالات المنتهية أو الملغاة لا تمنع الحجز الجديد.
*/

function hasBookingConflict(
    rows,
    phone,
    doctor,
    date,
    excludeId = null,
    clientIP = null
) {

    const normalizedPhone = normalizePhone(phone);

    const normalizedDoctor = String(doctor || '').trim();

    const normalizedIP = String(clientIP || '').trim();

    return rows.some(row => {

        // استثناء السجل الحالي عند تحديد موعد العودة
        if (excludeId && row.id === excludeId) {
            return false;
        }

        const blockingStatus = isBlockingBooking(row);

        const blockingReturn = isScheduledReturn(row);

        // تجاهل الحجوزات المنتهية والملغاة
        if (!blockingStatus && !blockingReturn) {
            return false;
        }

        /*
           أولاً:
           منع أي حجز آخر من نفس عنوان IP.
        */

        // لا نمنع مرضى مختلفين لمجرد استخدامهم شبكة الإنترنت نفسها.

        /*
           ثانياً:
           منع استخدام رقم الهاتف نفسه
           حتى لو تغير الاسم أو الطبيب أو التاريخ.
        */

        const existingPhone = normalizePhone(row.phone);

        if (
            normalizedPhone &&
            existingPhone &&
            normalizedPhone === existingPhone
        ) {
            return true;
        }

        /*
           ثالثاً:
           منع تعارض الحجوزات لدى الطبيب نفسه.
        */

        // التعارض الزمني للطبيب يعالج عبر سعة اليوم والطابور، لا بمنع كل الحجوزات الإضافية.
        return false;
    });
}


/* =====================================
   دخول المستخدمين والصلاحيات وسجل العمليات
===================================== */
const DATA_FILES = {
    users: path.join(DATA_DIR, 'users.json'),
    doctors: path.join(DATA_DIR, 'doctors.json'),
    patients: path.join(DATA_DIR, 'patients.json'),
    medicalRecords: path.join(DATA_DIR, 'medical-records.json'),
    payments: path.join(DATA_DIR, 'payments.json'),
    invoices: path.join(DATA_DIR, 'invoices.json'),
    waitlist: path.join(DATA_DIR, 'waitlist.json'),
    clinicSettings: path.join(DATA_DIR, 'clinic-settings.json'),
    notifications: path.join(DATA_DIR, 'notifications.json'),
    audit: path.join(DATA_DIR, 'audit-log.json')
};
for (const file of Object.values(DATA_FILES)) {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '[]\n', 'utf8');
}

function readCollection(name) {
    const file = DATA_FILES[name];
    if (!file) throw new Error('مجموعة بيانات غير معروفة');
    try {
        const value = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (name === 'medicalRecords' && value && value.encrypted === true) {
            const key = crypto.createHash('sha256').update(tokenSecret()).digest();
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(value.iv, 'base64'));
            decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
            const plaintext = Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8');
            const rows = JSON.parse(plaintext);
            return Array.isArray(rows) ? rows : [];
        }
        return Array.isArray(value) ? value : [];
    } catch (error) {
        console.error(`تعذر قراءة ${name}:`, error);
        throw new Error(`تعذر قراءة بيانات ${name}`);
    }
}
function writeCollection(name, value) {
    const file = DATA_FILES[name];
    if (!file) throw new Error('مجموعة بيانات غير معروفة');
    const temp = `${file}.${process.pid}.tmp`;
    let content;
    if (name === 'medicalRecords') {
        const key = crypto.createHash('sha256').update(tokenSecret()).digest();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
        content = JSON.stringify({ encrypted: true, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') }, null, 2) + '\n';
    } else {
        content = `${JSON.stringify(value, null, 2)}\n`;
    }
    fs.writeFileSync(temp, content, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temp, file);
}
function nowISO() { return new Date().toISOString(); }
function makeId() { return crypto.randomUUID(); }
function safeUser(user) {
    const { passwordHash, passwordSalt, ...publicUser } = user;
    return publicUser;
}
function tokenSecret() {
    const configured = process.env.AUTH_SECRET;
    if (configured && configured.length >= 32) return configured;
    const keyFile = path.join(DATA_DIR, '.auth-secret');
    if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, crypto.randomBytes(48), { mode: 0o600 });
    return fs.readFileSync(keyFile);
}
function signToken(user) {
    const payload = Buffer.from(JSON.stringify({
        sub: user.id, username: user.username, role: user.role,
        doctorId: user.doctorId || null, exp: Date.now() + 12 * 60 * 60 * 1000
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', tokenSecret()).update(payload).digest('base64url');
    return `${payload}.${signature}`;
}
function verifyToken(token) {
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const expected = crypto.createHmac('sha256', tokenSecret()).update(parts[0]).digest();
    let provided;
    try { provided = Buffer.from(parts[1], 'base64url'); } catch (_) { return null; }
    if (provided.length !== expected.length || !crypto.timingSafeEqual(provided, expected)) return null;
    try {
        const data = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (!data.exp || data.exp < Date.now()) return null;
        const user = readCollection('users').find(item => item.id === data.sub && item.active !== false);
        return user ? safeUser(user) : null;
    } catch (_) { return null; }
}
function requireAuth(req, res, next) {
    const header = String(req.headers.authorization || '');
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const user = verifyToken(token);
    if (!user) return res.status(401).json({ error: 'يلزم تسجيل الدخول أو أن الجلسة انتهت' });
    req.user = user;
    next();
}
function allowRoles(...roles) {
    return (req, res, next) => {
        if (!req.user) return res.status(401).json({ error: 'يلزم تسجيل الدخول' });
        if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'ليس لديك صلاحية لتنفيذ هذا الإجراء' });
        next();
    };
}
function doctorOwns(req, row) {
    return req.user?.role !== 'doctor' || String(row.doctorId || row.doctor || '') === String(req.user.doctorId || '');
}
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(String(password), salt, 64).toString('hex') };
}
function passwordMatches(password, user) {
    if (!user.passwordSalt || !user.passwordHash) return false;
    const actual = crypto.scryptSync(String(password), user.passwordSalt, 64);
    const expected = Buffer.from(user.passwordHash, 'hex');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function auditEntry(req, outcome) {
    const audit = readCollection('audit');
    audit.unshift({
        id: makeId(), at: nowISO(), userId: req.user?.id || null,
        username: req.user?.username || 'public', role: req.user?.role || 'public',
        method: req.method, path: req.originalUrl.split('?')[0],
        statusCode: outcome, ip: getClientIP(req), details: req.auditDetails || null
    });
    writeCollection('audit', audit.slice(0, 20000));
}
// لا نخزن محتوى الطلب في سجل التدقيق لتجنب نسخ التشخيصات أو البيانات الحساسة.
app.use((req, res, next) => {
    if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) return next();
    res.on('finish', () => {
        if (req.originalUrl.startsWith('/api/')) {
            try { auditEntry(req, res.statusCode); }
            catch (error) { console.error('تعذر تسجيل العملية:', error.message); }
        }
    });
    next();
});
function routeError(res, error, message = 'تعذر تنفيذ العملية') {
    console.error(message, error);
    return res.status(500).json({ error: message });
}
function patientForAppointment(row, patients) {
    return patients.find(p => normalizePhone(p.phone) === normalizePhone(row.phone));
}
function withinDoctorScope(req, row) {
    if (req.user.role !== 'doctor') return true;
    const assignedId = String(req.user.doctorId || '');
    if (String(row.doctorId || '') === assignedId) return true;
    const doctor = readCollection('doctors').find(d => d.id === assignedId);
    return Boolean(doctor && String(row.doctor || '').trim() === String(doctor.name || '').trim());
}
function syncPatientsFromAppointments() {
    const patients = readCollection('patients');
    const known = new Set(patients.map(p => normalizePhone(p.phone)).filter(Boolean));
    let changed = false;
    for (const appointment of readAppointments()) {
        const phone = normalizePhone(appointment.phone);
        if (!phone || known.has(phone)) continue;
        patients.push({ id: makeId(), name: appointment.name, phone, dateOfBirth: null, age: null, createdAt: appointment.createdAt || nowISO(), updatedAt: nowISO(), source: 'appointment-migration' });
        known.add(phone); changed = true;
    }
    if (changed) writeCollection('patients', patients);
}
syncPatientsFromAppointments();
function getClinicSchedule(doctorName, date) {
    const settings = readCollection('clinicSettings')[0] || {};
    const doctor = readCollection('doctors').find(d => String(d.name || '').trim() === String(doctorName || '').trim());
    const holidays = Array.isArray(settings.holidays) ? settings.holidays.map(x => typeof x === 'string' ? x : x?.date) : [];
    const closedDates = Array.isArray(settings.closedDates) ? settings.closedDates : [];
    if (holidays.includes(date) || closedDates.includes(date)) return { open: false, startTime: CLINIC_START_TIME, endTime: null, maxAppointments: 0 };
    const weekday = String(new Date(`${date}T12:00:00Z`).getUTCDay());
    const override = doctor?.workingHours?.[weekday];
    const weekly = settings.weeklyHours?.[weekday];
    const slot = override !== undefined ? override : weekly;
    if (slot === false || slot?.closed === true) return { open: false, startTime: CLINIC_START_TIME, endTime: null, maxAppointments: 0 };
    const startTime = typeof slot?.start === 'string' && minutesFromTime(slot.start) !== null ? slot.start : CLINIC_START_TIME;
    const endTime = typeof slot?.end === 'string' && minutesFromTime(slot.end) !== null ? slot.end : null;
    const configuredLimit = Number(slot?.maxAppointments || settings.maxAppointmentsPerDoctorPerDay || 0);
    const calculatedLimit = endTime ? Math.floor((minutesFromTime(endTime) - minutesFromTime(startTime)) / APPOINTMENT_DURATION) : 0;
    const maxAppointments = configuredLimit > 0 ? configuredLimit : calculatedLimit > 0 ? calculatedLimit : null;
    return { open: true, startTime, endTime, maxAppointments };
}
function isClinicOpenOn(doctorName, date) { return getClinicSchedule(doctorName, date).open; }
function setAuditChange(req, entity, entityId, before, after) {
    req.auditDetails = { entity, entityId, before: before || null, after: after || null };
}
function addWaitlistItem({ name, phone, doctor, date, reason = 'request', source = 'patient-request', doctorId = null }) {
    const list = readCollection('waitlist');
    const existing = list.find(x => normalizePhone(x.phone) === normalizePhone(phone) && x.doctor === doctor && x.date === date && ['waiting', 'called'].includes(x.status));
    if (existing) return { item: existing, created: false };
    const item = { id: makeId(), name, phone: normalizePhone(phone), doctor, doctorId, date, status: 'waiting', source, reason, createdAt: nowISO() };
    list.push(item); writeCollection('waitlist', list);
    return { item, created: true };
}
async function queueNotification(appointment, type, createdBy = null) {
    const logs = readCollection('notifications');
    const item = { id: makeId(), appointmentId: appointment.id, appointmentDate: appointment.date, type, channel: process.env.NOTIFICATION_WEBHOOK_URL ? 'webhook' : 'unconfigured', recipient: appointment.phone, status: 'queued', createdAt: nowISO(), createdBy };
    logs.unshift(item); writeCollection('notifications', logs);
    const url = process.env.NOTIFICATION_WEBHOOK_URL;
    if (!url) { item.status = 'not_configured'; item.error = 'NOTIFICATION_WEBHOOK_URL is not configured'; }
    else {
        const messages = {
            confirmation: `تم تأكيد حجزك لدى ${appointment.doctor} بتاريخ ${appointment.date}${appointment.appointmentTime ? ` الساعة ${appointment.appointmentTime}` : ''}.`,
            reminder: `تذكير: لديك موعد لدى ${appointment.doctor} بتاريخ ${appointment.date}${appointment.appointmentTime ? ` الساعة ${appointment.appointmentTime}` : ''}.`,
            cancellation: `تم إلغاء موعدك لدى ${appointment.doctor} بتاريخ ${appointment.date}.`,
            rescheduled: `تم تغيير موعدك لدى ${appointment.doctor} إلى ${appointment.date}${appointment.appointmentTime ? ` الساعة ${appointment.appointmentTime}` : ''}.`
        };
        try {
            const headers = { 'Content-Type': 'application/json' };
            if (process.env.NOTIFICATION_WEBHOOK_SECRET) headers['X-Clinic-Webhook-Secret'] = process.env.NOTIFICATION_WEBHOOK_SECRET;
            const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify({ to: appointment.phone, message: messages[type] || '', type, appointmentId: appointment.id, patientName: appointment.name }) });
            item.status = response.ok ? 'sent' : 'failed';
            if (!response.ok) item.error = `Webhook responded with HTTP ${response.status}`;
        } catch (error) { item.status = 'failed'; item.error = String(error.message || error).slice(0, 300); }
    }
    const latest = readCollection('notifications'); const index = latest.findIndex(x => x.id === item.id);
    if (index >= 0) latest[index] = item;
    writeCollection('notifications', latest);
    return item;
}
async function sendDueReminders() {
    try {
        const tomorrowDate = new Date(); tomorrowDate.setDate(tomorrowDate.getDate() + 1);
        const tomorrow = localDateString(tomorrowDate);
        const appointments = readAppointments().filter(a => a.date === tomorrow && a.status === 'approved');
        const logs = readCollection('notifications');
        for (const appointment of appointments) {
            if (logs.some(n => n.appointmentId === appointment.id && n.type === 'reminder' && n.appointmentDate === appointment.date)) continue;
            await queueNotification(appointment, 'reminder', null);
        }
    } catch (error) { console.error('تعذر إرسال تذكيرات المواعيد:', error.message); }
}


/* =====================================
   واجهات النظام الإدارية
===================================== */
app.get('/api/auth/bootstrap', (_req, res) => {
    res.json({ initialized: readCollection('users').length > 0 });
});
app.post('/api/auth/bootstrap', (req, res) => {
    try {
        const users = readCollection('users');
        if (users.length) return res.status(409).json({ error: 'تم إعداد النظام مسبقًا' });
        const password = String(req.body?.password || process.env.BOOTSTRAP_ADMIN_PASSWORD || '');
        const username = String(req.body?.username || process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin').trim();
        if (password.length < 12) return res.status(400).json({ error: 'كلمة مرور المدير يجب ألا تقل عن 12 حرفًا؛ أرسلها من متغير بيئة آمن أو في هذا الطلب الأول فقط' });
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(username)) return res.status(400).json({ error: 'اسم المستخدم يجب أن يكون 3-40 حرفًا إنجليزيًا أو رقمًا' });
        const pw = hashPassword(password);
        const user = { id: makeId(), username, name: 'مدير النظام', role: 'manager', active: true, createdAt: nowISO(), passwordSalt: pw.salt, passwordHash: pw.hash };
        users.push(user); writeCollection('users', users);
        res.status(201).json({ user: safeUser(user), token: signToken(user) });
    } catch (error) { routeError(res, error, 'تعذر إعداد حساب المدير'); }
});
app.post('/api/auth/login', (req, res) => {
    try {
        const username = String(req.body?.username || '').trim();
        const password = String(req.body?.password || '');
        const user = readCollection('users').find(item => item.username === username && item.active !== false);
        if (!user || !passwordMatches(password, user)) return res.status(401).json({ error: 'اسم المستخدم أو كلمة المرور غير صحيحة' });
        res.json({ user: safeUser(user), token: signToken(user), expiresIn: 43200 });
    } catch (error) { routeError(res, error, 'تعذر تسجيل الدخول'); }
});
app.get('/api/auth/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.get('/api/users', requireAuth, allowRoles('manager'), (_req, res) => res.json(readCollection('users').map(safeUser)));
app.post('/api/users', requireAuth, allowRoles('manager'), (req, res) => {
    try {
        const { username, password, name, role, doctorId } = req.body || {};
        const allowed = ['manager', 'receptionist', 'accountant', 'doctor'];
        if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(String(username || '')) || String(password || '').length < 12 || String(name || '').trim().length < 2 || !allowed.includes(role)) return res.status(400).json({ error: 'تحقق من اسم المستخدم وكلمة المرور (12 حرفًا على الأقل) والاسم والصلاحية' });
        if (role === 'doctor' && !doctorId) return res.status(400).json({ error: 'يجب ربط حساب الطبيب بمعرّف الطبيب' });
        const users = readCollection('users');
        if (users.some(u => u.username === username)) return res.status(409).json({ error: 'اسم المستخدم مستخدم مسبقًا' });
        const pw = hashPassword(password);
        const user = { id: makeId(), username, name: String(name).trim(), role, doctorId: doctorId || null, active: true, createdAt: nowISO(), passwordSalt: pw.salt, passwordHash: pw.hash };
        users.push(user); writeCollection('users', users); setAuditChange(req, 'user', user.id, null, { username: user.username, role: user.role, doctorId: user.doctorId });
        res.status(201).json(safeUser(user));
    } catch (error) { routeError(res, error, 'تعذر إنشاء المستخدم'); }
});
app.patch('/api/users/:id', requireAuth, allowRoles('manager'), (req, res) => {
    try {
        const users = readCollection('users'); const user = users.find(u => u.id === req.params.id);
        if (!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
        if (user.id === req.user.id && req.body?.active === false) return res.status(400).json({ error: 'لا يمكنك تعطيل حسابك الحالي' });
        if (req.body?.role && !['manager', 'receptionist', 'accountant', 'doctor'].includes(req.body.role)) return res.status(400).json({ error: 'الصلاحية غير صحيحة' });
        const auditBefore = { name: user.name, role: user.role, active: user.active, doctorId: user.doctorId || null };
        if (req.body?.name) user.name = String(req.body.name).trim();
        if (req.body?.role) user.role = req.body.role;
        if (req.body?.doctorId !== undefined) user.doctorId = req.body.doctorId || null;
        if (req.body?.active !== undefined) user.active = Boolean(req.body.active);
        if (req.body?.password) {
            if (String(req.body.password).length < 12) return res.status(400).json({ error: 'كلمة المرور لا تقل عن 12 حرفًا' });
            Object.assign(user, hashPassword(req.body.password));
        }
        user.updatedAt = nowISO(); writeCollection('users', users); setAuditChange(req, 'user', user.id, auditBefore, { name: user.name, role: user.role, active: user.active, doctorId: user.doctorId || null }); res.json(safeUser(user));
    } catch (error) { routeError(res, error, 'تعذر تحديث المستخدم'); }
});

// الأطباء والجداول
app.get('/api/doctors', requireAuth, allowRoles('manager', 'receptionist', 'accountant', 'doctor'), (req, res) => {
    const doctors = readCollection('doctors');
    res.json(req.user.role === 'doctor' ? doctors.filter(d => d.id === req.user.doctorId) : doctors);
});
app.post('/api/doctors', requireAuth, allowRoles('manager'), (req, res) => {
    try {
        const name = String(req.body?.name || '').trim(); const specialty = String(req.body?.specialty || '').trim();
        if (name.length < 2 || name.length > 120 || specialty.length > 120) return res.status(400).json({ error: 'اسم الطبيب أو التخصص غير صحيح' });
        const doctors = readCollection('doctors');
        const doctor = { id: makeId(), name, specialty, phone: String(req.body.phone || ''), active: req.body.active !== false, workingHours: req.body.workingHours || {}, createdAt: nowISO() };
        doctors.push(doctor); writeCollection('doctors', doctors); setAuditChange(req, 'doctor', doctor.id, null, { name: doctor.name, specialty: doctor.specialty, active: doctor.active }); res.status(201).json(doctor);
    } catch (error) { routeError(res, error, 'تعذر إضافة الطبيب'); }
});
app.patch('/api/doctors/:id', requireAuth, allowRoles('manager'), (req, res) => {
    try {
        const doctors = readCollection('doctors'); const doctor = doctors.find(d => d.id === req.params.id);
        if (!doctor) return res.status(404).json({ error: 'الطبيب غير موجود' });
        const auditBefore = { name: doctor.name, specialty: doctor.specialty, workingHours: doctor.workingHours, active: doctor.active };
        for (const key of ['name', 'specialty', 'phone', 'workingHours', 'active']) if (req.body?.[key] !== undefined) doctor[key] = req.body[key];
        doctor.updatedAt = nowISO(); writeCollection('doctors', doctors); setAuditChange(req, 'doctor', doctor.id, auditBefore, { name: doctor.name, specialty: doctor.specialty, workingHours: doctor.workingHours, active: doctor.active }); res.json(doctor);
    } catch (error) { routeError(res, error, 'تعذر تحديث بيانات الطبيب'); }
});
app.delete('/api/doctors/:id', requireAuth, allowRoles('manager'), (req, res) => {
    const doctors = readCollection('doctors'); const d = doctors.find(x => x.id === req.params.id);
    if (!d) return res.status(404).json({ error: 'الطبيب غير موجود' });
    d.active = false; d.updatedAt = nowISO(); writeCollection('doctors', doctors); res.json({ message: 'تم إيقاف الطبيب دون حذف سجلاته' });
});
app.get('/api/clinic/hours', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (_req, res) => res.json(readCollection('clinicSettings')));
app.put('/api/clinic/hours', requireAuth, allowRoles('manager'), (req, res) => {
    const { weeklyHours = {}, holidays = [], closedDates = [], timezone, maxAppointmentsPerDoctorPerDay } = req.body || {};
    if (!Array.isArray(holidays) || !Array.isArray(closedDates) || closedDates.some(d => !validDate(String(d)))) return res.status(400).json({ error: 'الإجازات أو تواريخ الإغلاق غير صحيحة' });
    if (maxAppointmentsPerDoctorPerDay !== undefined && (!Number.isInteger(Number(maxAppointmentsPerDoctorPerDay)) || Number(maxAppointmentsPerDoctorPerDay) < 1 || Number(maxAppointmentsPerDoctorPerDay) > 500)) return res.status(400).json({ error: 'الحد اليومي يجب أن يكون بين 1 و500' });
    const settings = [{ id: 'clinic', weeklyHours, holidays, closedDates, timezone: timezone || TIME_ZONE, maxAppointmentsPerDoctorPerDay: maxAppointmentsPerDoctorPerDay ? Number(maxAppointmentsPerDoctorPerDay) : null, updatedAt: nowISO() }];
    const oldSettings = readCollection('clinicSettings')[0] || null;
    writeCollection('clinicSettings', settings); setAuditChange(req, 'clinic-settings', 'clinic', oldSettings, settings[0]); res.json(settings[0]);
});

// المرضى وملفاتهم الطبية: لا يسمح بالملف الطبي إلا للمدير أو الطبيب.
function patientPublic(p) { const { id, name, phone, dateOfBirth, age, createdAt, updatedAt } = p; return { id, name, phone, dateOfBirth: dateOfBirth || null, age: age ?? null, createdAt, updatedAt }; }
app.get('/api/patients', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (req, res) => {
    let patients = readCollection('patients');
    if (req.user.role === 'doctor') {
        const appointments = readAppointments();
        patients = patients.filter(p => appointments.some(a => normalizePhone(a.phone) === normalizePhone(p.phone) && withinDoctorScope(req, a)));
    }
    const q = String(req.query.q || '').trim().toLowerCase();
    if (q) patients = patients.filter(p => p.name.toLowerCase().includes(q) || normalizePhone(p.phone).includes(normalizePhone(q)));
    res.json(patients.map(patientPublic));
});
app.post('/api/patients', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (req, res) => {
    try {
        const name = String(req.body?.name || '').trim(); const phone = normalizePhone(req.body?.phone);
        if (name.length < 2 || name.length > 120 || !/^\d{8,15}$/.test(phone)) return res.status(400).json({ error: 'الاسم أو رقم الهاتف غير صحيح' });
        const patients = readCollection('patients');
        let patient = patients.find(p => normalizePhone(p.phone) === phone);
        if (patient) return res.status(200).json(patientPublic(patient));
        patient = { id: makeId(), name, phone, dateOfBirth: req.body.dateOfBirth || null, age: req.body.age ?? null, createdAt: nowISO(), updatedAt: nowISO() };
        patients.push(patient); writeCollection('patients', patients); setAuditChange(req, 'patient', patient.id, null, patientPublic(patient)); res.status(201).json(patientPublic(patient));
    } catch (error) { routeError(res, error, 'تعذر حفظ المريض'); }
});
app.patch('/api/patients/:id', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (req, res) => {
    try {
        const patients = readCollection('patients'); const p = patients.find(x => x.id === req.params.id);
        if (!p) return res.status(404).json({ error: 'المريض غير موجود' });
        if (req.user.role === 'doctor' && !readAppointments().some(a => normalizePhone(a.phone) === normalizePhone(p.phone) && withinDoctorScope(req, a))) return res.status(403).json({ error: 'المريض خارج نطاق جدولك' });
        const auditBefore = { name: p.name, phone: p.phone, dateOfBirth: p.dateOfBirth || null, age: p.age ?? null };
        if (req.body?.name !== undefined) p.name = String(req.body.name).trim();
        if (req.body?.phone !== undefined) {
            const phone = normalizePhone(req.body.phone);
            if (!/^\d{8,15}$/.test(phone) || patients.some(x => x.id !== p.id && normalizePhone(x.phone) === phone)) return res.status(400).json({ error: 'رقم الهاتف غير صالح أو مرتبط بمريض آخر' });
            p.phone = phone;
        }
        if (req.body?.dateOfBirth !== undefined) p.dateOfBirth = req.body.dateOfBirth || null;
        if (req.body?.age !== undefined) p.age = req.body.age;
        p.updatedAt = nowISO();
        setAuditChange(req, 'patient', p.id, auditBefore, { name: p.name, phone: p.phone, dateOfBirth: p.dateOfBirth || null, age: p.age ?? null });
        writeCollection('patients', patients); res.json(patientPublic(p));
    } catch (error) { routeError(res, error, 'تعذر تحديث المريض'); }
});
app.get('/api/patients/:id/medical-record', requireAuth, allowRoles('manager', 'doctor'), (req, res) => {
    const patient = readCollection('patients').find(p => p.id === req.params.id);
    if (!patient) return res.status(404).json({ error: 'المريض غير موجود' });
    const appointments = readAppointments().filter(a => normalizePhone(a.phone) === normalizePhone(patient.phone));
    if (req.user.role === 'doctor' && !appointments.some(a => withinDoctorScope(req, a))) return res.status(403).json({ error: 'ملف المريض خارج نطاق جدولك' });
    req.auditDetails = { entity: 'medical-record', entityId: patient.id, action: 'view' };
    auditEntry(req, 200);
    const records = readCollection('medicalRecords').filter(r => r.patientId === patient.id).sort((a,b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    res.json({ patient: patientPublic(patient), visits: appointments.map(a => ({ id: a.id, date: a.date, doctor: a.doctor, status: a.status, completedAt: a.completedAt })), records });
});
app.post('/api/patients/:id/medical-record', requireAuth, allowRoles('manager', 'doctor'), (req, res) => {
    try {
        const patient = readCollection('patients').find(p => p.id === req.params.id);
        if (!patient) return res.status(404).json({ error: 'المريض غير موجود' });
        const appointments = readAppointments().filter(a => normalizePhone(a.phone) === normalizePhone(patient.phone));
        if (req.user.role === 'doctor' && !appointments.some(a => withinDoctorScope(req, a))) return res.status(403).json({ error: 'ملف المريض خارج نطاق جدولك' });
        const diagnosis = String(req.body?.diagnosis || '').slice(0, 5000);
        const medicines = req.body?.medicines ?? [];
        const notes = String(req.body?.notes || '').slice(0, 10000);
        if (!Array.isArray(medicines)) return res.status(400).json({ error: 'الأدوية يجب أن تكون قائمة' });
        const records = readCollection('medicalRecords');
        const record = { id: makeId(), patientId: patient.id, doctorId: req.user.doctorId || null, diagnosis, medicines, prescription: String(req.body?.prescription || '').slice(0, 5000), notes, createdBy: req.user.id, createdAt: nowISO() };
        records.push(record); writeCollection('medicalRecords', records);
        setAuditChange(req, 'medical-record', record.id, null, { patientId: patient.id, updated: true });
        res.status(201).json(record);
    } catch (error) { routeError(res, error, 'تعذر حفظ السجل الطبي'); }
});

// المدفوعات والإيرادات
app.get('/api/payments', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {
    let rows = readCollection('payments');
    if (req.query.appointmentId) rows = rows.filter(p => p.appointmentId === req.query.appointmentId);
    res.json(rows);
});
app.get('/api/invoices', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {
    let invoices = readCollection('invoices');
    if (req.query.appointmentId) invoices = invoices.filter(i => i.appointmentId === req.query.appointmentId);
    res.json(invoices);
});
app.post('/api/invoices', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {
    const appointment = readAppointments().find(a => a.id === req.body?.appointmentId);
    const totalAmount = Number(req.body?.totalAmount);
    if (!appointment) return res.status(404).json({ error: 'الحجز غير موجود' });
    if (!Number.isFinite(totalAmount) || totalAmount <= 0) return res.status(400).json({ error: 'إجمالي الفاتورة يجب أن يكون أكبر من صفر' });
    const invoices = readCollection('invoices');
    if (invoices.some(i => i.appointmentId === appointment.id && i.status !== 'void')) return res.status(409).json({ error: 'توجد فاتورة لهذا الحجز مسبقًا' });
    const invoice = { id: makeId(), appointmentId: appointment.id, patientName: appointment.name, phone: appointment.phone, totalAmount, paidAmount: 0, remainingAmount: totalAmount, currency: String(req.body.currency || 'YER').slice(0,8), status: 'due', description: String(req.body.description || '').slice(0,300), createdBy: req.user.id, createdAt: nowISO(), updatedAt: nowISO() };
    invoices.push(invoice); writeCollection('invoices', invoices);
    setAuditChange(req, 'invoice', invoice.id, null, { totalAmount, remainingAmount: totalAmount, status: 'due' });
    res.status(201).json(invoice);
});
app.post('/api/payments', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {
    try {
        const amount = Number(req.body?.amount); const status = req.body?.status || 'paid';
        if (!Number.isFinite(amount) || amount <= 0 || !['paid', 'refunded'].includes(status)) return res.status(400).json({ error: 'المبلغ أو حالة الدفع غير صحيحة؛ سجّل المبالغ المستحقة كفاتورة' });
        const appointment = readAppointments().find(a => a.id === req.body?.appointmentId);
        if (!appointment) return res.status(404).json({ error: 'الحجز غير موجود' });
        const invoices = readCollection('invoices');
        const invoice = req.body.invoiceId ? invoices.find(i => i.id === req.body.invoiceId) : invoices.find(i => i.appointmentId === appointment.id && i.status !== 'void');
        if (req.body.invoiceId && (!invoice || invoice.appointmentId !== appointment.id)) return res.status(404).json({ error: 'الفاتورة غير موجودة لهذا الحجز' });
        if (invoice && status === 'paid' && amount > invoice.remainingAmount) return res.status(400).json({ error: 'المبلغ أكبر من المتبقي في الفاتورة' });
        if (invoice && status === 'refunded' && amount > invoice.paidAmount) return res.status(400).json({ error: 'المبلغ المسترد أكبر من المدفوع على الفاتورة' });
        const payments = readCollection('payments');
        const payment = { id: makeId(), appointmentId: appointment.id, patientName: appointment.name, amount, currency: String(req.body.currency || 'YER').slice(0, 8), status, method: String(req.body.method || 'cash').slice(0, 40), reference: String(req.body.reference || '').slice(0, 120), note: String(req.body.note || '').slice(0, 500), createdBy: req.user.id, createdAt: nowISO() };
        if (invoice) {
            payment.invoiceId = invoice.id;
            const before = { paidAmount: invoice.paidAmount, remainingAmount: invoice.remainingAmount, status: invoice.status };
            invoice.paidAmount += status === 'paid' ? amount : -amount;
            invoice.remainingAmount = Math.max(0, invoice.totalAmount - invoice.paidAmount);
            invoice.status = invoice.remainingAmount === 0 ? 'paid' : invoice.paidAmount > 0 ? 'partial' : 'due';
            invoice.updatedAt = nowISO();
            writeCollection('invoices', invoices);
            setAuditChange(req, 'invoice', invoice.id, before, { paidAmount: invoice.paidAmount, remainingAmount: invoice.remainingAmount, status: invoice.status });
        }
        payments.push(payment); writeCollection('payments', payments); res.status(201).json({ payment, invoice: invoice || null });
    } catch (error) { routeError(res, error, 'تعذر تسجيل الدفعة'); }
});
app.get('/api/dashboard', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {
    try {
        const appointments = readAppointments(); const payments = readCollection('payments'); const invoices = readCollection('invoices'); const patients = readCollection('patients');
        const today = localDateString(); const month = today.slice(0, 7);
        const scope = req.user.role === 'doctor' ? appointments.filter(a => withinDoctorScope(req, a)) : appointments;
        const newPatientsToday = patients.filter(p => String(p.createdAt || '').slice(0,10) === today).length;
        const newPatientsMonth = patients.filter(p => String(p.createdAt || '').slice(0,7) === month).length;
        const todayPayments = payments.filter(p => ['paid', 'refunded'].includes(p.status) && String(p.createdAt).slice(0,10) === today);
        const monthPayments = payments.filter(p => ['paid', 'refunded'].includes(p.status) && String(p.createdAt).slice(0,7) === month);
        const total = list => list.reduce((sum,p) => sum + (p.status === 'refunded' ? -Number(p.amount || 0) : Number(p.amount || 0)), 0);
        const outstanding = invoices.reduce((sum, invoice) => sum + Number(invoice.remainingAmount || 0), 0) + total(payments.filter(p => p.status === 'due'));
        res.json({ date: today, month, patients: { total: patients.length, newToday: newPatientsToday, newMonth: newPatientsMonth }, appointments: { today: scope.filter(a => a.date === today).length, month: scope.filter(a => String(a.date || '').startsWith(month)).length, pending: scope.filter(a => a.status === 'pending').length }, revenue: { today: total(todayPayments), month: total(monthPayments), currency: payments[0]?.currency || invoices[0]?.currency || 'YER' }, payments: { paidToday: total(todayPayments), paidMonth: total(monthPayments), due: outstanding, remaining: outstanding } });
    } catch (error) { routeError(res, error, 'تعذر إعداد لوحة الإحصاءات'); }
});

// قائمة الانتظار اليدوية، بالإضافة إلى طوابير المواعيد الموجودة مسبقًا.
app.post('/api/waitlist/request', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const phone = normalizePhone(req.body?.phone);
    const doctor = String(req.body?.doctor || '').trim();
    const date = String(req.body?.date || localDateString());
    if (name.length < 2 || name.length > 120 || !/^\d{8,15}$/.test(phone) || !validDate(date) || !doctor) return res.status(400).json({ error: 'بيانات طلب الانتظار غير صحيحة' });
    const result = addWaitlistItem({ name, phone, doctor, doctorId: req.body.doctorId || null, date, reason: 'patient-request', source: 'patient-request' });
    if (!result.created) return res.status(409).json({ error: 'لديك طلب انتظار قائم لهذا الطبيب والتاريخ', requestId: result.item.id });
    res.status(201).json({ id: result.item.id, status: result.item.status, message: 'تم تسجيل طلبك في قائمة الانتظار' });
});
app.get('/api/waitlist', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (req, res) => {
    let list = readCollection('waitlist');
    if (req.user.role === 'doctor') list = list.filter(x => withinDoctorScope(req, x));
    res.json(list);
});
app.post('/api/waitlist', requireAuth, allowRoles('manager', 'receptionist'), (req, res) => {
    const name = String(req.body?.name || '').trim(); const phone = normalizePhone(req.body?.phone); const doctor = String(req.body?.doctor || '').trim(); const date = String(req.body?.date || localDateString());
    if (name.length < 2 || !/^\d{8,15}$/.test(phone) || !validDate(date) || !doctor) return res.status(400).json({ error: 'بيانات قائمة الانتظار غير صحيحة' });
    const list = readCollection('waitlist');
    const item = { id: makeId(), name, phone, doctor, doctorId: req.body.doctorId || null, date, status: 'waiting', note: String(req.body.note || '').slice(0, 500), createdAt: nowISO() };
    list.push(item); writeCollection('waitlist', list); setAuditChange(req, 'waitlist', item.id, null, { status: item.status, date: item.date, doctor: item.doctor }); res.status(201).json(item);
});
app.patch('/api/waitlist/:id', requireAuth, allowRoles('manager', 'receptionist', 'doctor'), (req, res) => {
    const list = readCollection('waitlist'); const item = list.find(x => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'المريض غير موجود بقائمة الانتظار' });
    if (!withinDoctorScope(req, item)) return res.status(403).json({ error: 'ليس ضمن جدولك' });
    if (!['waiting', 'called', 'served', 'cancelled'].includes(req.body?.status)) return res.status(400).json({ error: 'حالة الانتظار غير صحيحة' });
    const before = { status: item.status }; item.status = req.body.status; item.updatedAt = nowISO(); writeCollection('waitlist', list); setAuditChange(req, 'waitlist', item.id, before, { status: item.status }); res.json(item);
});

// شاشة الانتظار: أسماء مختصرة/أرقام فقط ولا تعرض الهاتف أو التشخيص.
function waitingBoard() {
    const rows = readAppointments(); updateMissedReturns(rows); rebuildAllQueues(rows);
    const today = localDateString();
    const active = rows.filter(r => r.date === today && ['approved','in_progress'].includes(r.status)).sort((a,b) => (a.queue || 9999) - (b.queue || 9999));
    const normal = active.map(r => ({ ticket: String(r.queue || '').padStart(2,'0'), doctor: r.doctor, time: r.appointmentTime, state: r.status === 'in_progress' ? 'قيد الكشف' : ((r.queue || 0) === 1 ? 'التالي' : 'منتظر'), type: 'appointment' }));
    const returns = rows.filter(r => r.returnDate === today && ['scheduled','attended'].includes(r.returnStatus)).sort((a,b) => (a.returnQueue || 9999) - (b.returnQueue || 9999)).map(r => ({ ticket: String(r.returnQueue || '').padStart(2,'0'), doctor: r.doctor, time: r.returnTime, state: r.returnStartedAt ? 'قيد الكشف' : (r.returnStatus === 'attended' ? 'منتظر' : 'موعد عودة'), type: 'return' }));
    return [...returns, ...normal].sort((a,b) => Number(a.ticket) - Number(b.ticket));
}
app.get('/api/waiting-room', (_req, res) => res.json({ updatedAt: nowISO(), patients: waitingBoard() }));
app.get('/api/waiting-room/stream', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    const send = () => { try { res.write(`data: ${JSON.stringify({ updatedAt: nowISO(), patients: waitingBoard() })}\n\n`); } catch (_) {} };
    send(); const timer = setInterval(send, 5000); req.on('close', () => clearInterval(timer));
});

// إلغاء/إعادة جدولة وفق الصلاحيات. تبقى أفعال المرضى العامة خارج هذه الواجهة الإدارية.
app.post('/api/appointments/:id/reschedule', requireAuth, allowRoles('manager', 'receptionist'), (req, res) => {
    try {
        const rows = readAppointments(); const row = rows.find(x => x.id === req.params.id);
        const date = String(req.body?.date || '');
        if (!row) return res.status(404).json({ error: 'الحجز غير موجود' });
        if (!['pending', 'approved'].includes(row.status)) return res.status(409).json({ error: 'لا يمكن إعادة جدولة الحجز بحالته الحالية' });
        if (!validDate(date) || date < localDateString()) return res.status(400).json({ error: 'تاريخ الموعد غير صحيح أو سابق' });
        if (!isClinicOpenOn(row.doctor, date)) return res.status(409).json({ error: 'العيادة مغلقة في التاريخ المحدد' });
        const schedule = getClinicSchedule(row.doctor, date);
        const dailyCount = rows.filter(item => item.id !== row.id && item.doctor === row.doctor && item.date === date && isBlockingBooking(item)).length;
        if (schedule.maxAppointments && dailyCount >= schedule.maxAppointments) return res.status(409).json({ error: 'اكتملت سعة المواعيد لهذا الطبيب في التاريخ المحدد' });
        if (hasBookingConflict(rows, row.phone, row.doctor, date, row.id)) return res.status(409).json({ error: 'يوجد تعارض في الموعد الجديد' });
        const auditBefore = { status: row.status, date: row.date };
        row.date = date; row.updatedAt = nowISO(); row.rescheduledBy = req.user.id;
        setAuditChange(req, 'appointment', row.id, auditBefore, { status: row.status, date: row.date });
        rebuildAllQueues(rows); writeAppointments(rows); void queueNotification(row, 'rescheduled', req.user.id); res.json(publicAppointment(row));
    } catch (error) { routeError(res, error, 'تعذر إعادة جدولة الحجز'); }
});
app.post('/api/appointments/:id/cancel', requireAuth, allowRoles('manager', 'receptionist', 'accountant'), (req, res) => {
    try {
        const rows = readAppointments(); const row = rows.find(x => x.id === req.params.id);
        if (!row) return res.status(404).json({ error: 'الحجز غير موجود' });
        if (['completed', 'cancelled'].includes(row.status)) return res.status(409).json({ error: 'لا يمكن إلغاء الحجز بحالته الحالية' });
        const auditBefore = { status: row.status, date: row.date };
        row.status = 'cancelled'; row.cancelledAt = nowISO(); row.cancelledBy = req.user.id; row.updatedAt = nowISO(); row.queue = null; row.appointmentTime = null;
        setAuditChange(req, 'appointment', row.id, auditBefore, { status: row.status, date: row.date });
        rebuildAllQueues(rows); writeAppointments(rows); void queueNotification(row, 'cancellation', req.user.id); res.json(publicAppointment(row));
    } catch (error) { routeError(res, error, 'تعذر إلغاء الحجز'); }
});

// إرسال الرسائل يتم عبر webhook خارجي يحدده NOTIFICATION_WEBHOOK_URL.
app.get('/api/notifications', requireAuth, allowRoles('manager', 'receptionist'), (_req, res) => res.json(readCollection('notifications')));
app.post('/api/notifications', requireAuth, allowRoles('manager', 'receptionist'), async (req, res) => {
    const appointment = readAppointments().find(a => a.id === req.body?.appointmentId);
    if (!appointment) return res.status(404).json({ error: 'الحجز غير موجود' });
    const type = ['confirmation', 'reminder', 'cancellation', 'rescheduled'].includes(req.body?.type) ? req.body.type : null;
    if (!type) return res.status(400).json({ error: 'نوع الإشعار غير صحيح' });
    const item = await queueNotification(appointment, type, req.user.id);
    res.status(item.status === 'sent' ? 200 : 202).json(item);
});
app.get('/api/notifications/reminders-due', requireAuth, allowRoles('manager', 'receptionist'), (_req, res) => {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); const day = localDateString(tomorrow);
    res.json(readAppointments().filter(a => a.date === day && a.status === 'approved').map(a => ({ appointmentId: a.id, name: a.name, phone: a.phone, doctor: a.doctor, date: a.date, time: a.appointmentTime })));
});
app.post('/api/notifications/send-reminders', requireAuth, allowRoles('manager', 'receptionist'), async (_req, res) => {
    await sendDueReminders();
    res.json({ message: 'تم فحص مواعيد الغد؛ راجع سجل الإشعارات لمعرفة حالة الإرسال', notifications: readCollection('notifications').filter(n => n.type === 'reminder').slice(0,100) });
});
app.get('/api/audit-log', requireAuth, allowRoles('manager'), (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    res.json(readCollection('audit').slice(0, limit));
});

/* =====================================
   جلب جميع المواعيد
===================================== */

app.get('/api/appointments', requireAuth, allowRoles('manager', 'receptionist', 'accountant', 'doctor'), (req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        rebuildAllQueues(rows);

        writeAppointments(rows);

        const visibleRows = req.user.role === 'doctor' ? rows.filter(row => withinDoctorScope(req, row)) : rows;
        res.json(visibleRows.map(publicAppointment));

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* =====================================
   إنشاء حجز جديد
===================================== */

app.post(
    '/api/appointments',
    upload.single('receipt'),
    (req, res) => {

        const cleanupUpload = () => {
            if (req.file) {
                fs.rmSync(req.file.path, { force: true });
            }
        };

        try {

            const name = String(req.body.name || '').trim();

            const phone = normalizePhone(req.body.phone);

            const doctor = String(req.body.doctor || '').trim();

            const date = String(req.body.date || '').trim();

            // استخراج عنوان IP للزائر
            const clientIP = getClientIP(req);

            if (name.length < 3 || name.length > 90) {
                cleanupUpload();

                return res.status(400).json({
                    error: 'اسم المريض غير صحيح'
                });
            }

            if (!/^\d{8,15}$/.test(phone)) {
                cleanupUpload();

                return res.status(400).json({
                    error: 'رقم الهاتف غير صحيح'
                });
            }

            if (
                !doctor ||
                doctor.length > 160 ||
                !validDate(date)
            ) {
                cleanupUpload();

                return res.status(400).json({
                    error: 'بيانات العيادة أو التاريخ غير صحيحة'
                });
            }

            if (!isClinicOpenOn(doctor, date)) {
                const result = addWaitlistItem({ name, phone, doctor, date, reason: 'clinic-closed', source: 'booking-overflow' });
                cleanupUpload();
                return res.status(202).json({ message: 'العيادة مغلقة في هذا اليوم؛ تم تسجيل طلبك في قائمة الانتظار', waitlistAvailable: true, waitlist: { id: result.item.id, status: result.item.status } });
            }

            if (!req.file) {
                return res.status(400).json({
                    error: 'يرجى إرفاق صورة سند التحويل'
                });
            }

            const rows = readAppointments();

            updateMissedReturns(rows);

            rebuildAllQueues(rows);

            const identityConflict = rows.some(item => (isBlockingBooking(item) || isScheduledReturn(item)) && normalizePhone(item.phone) === phone);
            if (identityConflict) {
                cleanupUpload();
                return res.status(409).json({ error: 'يوجد لديك حجز أو طلب قائم من الجهاز أو رقم الهاتف نفسه' });
            }
            const doctorBusy = rows.some(item => item.doctor === doctor && ((item.date === date && isBlockingBooking(item)) || (item.returnDate === date && isScheduledReturn(item))));
            const schedule = getClinicSchedule(doctor, date);
            const dailyCount = rows.filter(item => item.doctor === doctor && item.date === date && isBlockingBooking(item)).length;
            const dailyCapacity = schedule.maxAppointments || 1;
            if (dailyCount >= dailyCapacity) {
                const result = addWaitlistItem({ name, phone, doctor, date, reason: doctorBusy ? 'doctor-schedule-full' : 'daily-capacity-full', source: 'booking-overflow' });
                cleanupUpload();
                return res.status(202).json({ message: 'لا توجد مواعيد متاحة؛ تم تسجيلك تلقائيًا في قائمة الانتظار', waitlistAvailable: true, waitlist: { id: result.item.id, status: result.item.status } });
            }

            /*
               فحص الحماية قبل إنشاء الحجز.

               يتم الفحص باستخدام:
               IP + رقم الهاتف + الطبيب + التاريخ.
            */

            if (
                hasBookingConflict(
                    rows,
                    phone,
                    doctor,
                    date,
                    null,
                    clientIP
                )
            ) {

                // حذف صورة السند المرفقة بالطلب المرفوض
                cleanupUpload();

                return res.status(409).json({
                    error: 'تم رفض الطلب. يوجد لديك حجز سابق أو طلب قائم من جهازك أو باستخدام رقم الهاتف نفسه. لا يمكنك إرسال حجز آخر حاليًا.'
                });
            }

            const now = new Date().toISOString();

            const row = {

                id: crypto.randomUUID(),

                name,
                phone,
                doctor,
                date,

                // حفظ IP داخلياً للحماية
                clientIP,

                createdAt: now,

                approvedAt: null,

                startedAt: null,

                completedAt: null,

                skippedAt: null,

                cancelledAt: null,

                updatedAt: null,

                status: 'pending',

                queue: null,

                appointmentTime: null,

                receiptName: path
                    .basename(req.file.originalname)
                    .slice(0, 180),

                receiptFile: req.file.filename,

                returnDate: null,

                returnQueue: null,

                returnTime: null,

                returnStatus: 'not_scheduled',

                returnScheduledAt: null,

                returnStartedAt: null,

                returnAttendedAt: null,

                returnCompletedAt: null,

                returnCancelledAt: null,

                returnMissedAt: null
            };

            rows.unshift(row);

            writeAppointments(rows);

            res.status(201).json(publicAppointment(row));

        } catch (error) {

            cleanupUpload();

            console.error('تعذر حفظ الموعد:', error);

            res.status(500).json({
                error: error.message || 'تعذر حفظ الطلب'
            });
        }
    }
);

/* =====================================
   تحديث حالة الحجز
===================================== */

/*
   الحالات المدعومة:

   approved
   in_progress
   skipped
   completed
   cancelled

   cancelled:
   للمحاسب عند رفض السند،
   ويسمح بها فقط إذا كان الحجز pending.
*/

app.patch('/api/appointments/:id', requireAuth, allowRoles('manager', 'accountant', 'doctor'), (req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        const row = rows.find(item => item.id === req.params.id);

        if (!row) {
            return res.status(404).json({
                error: 'الطلب غير موجود'
            });
        }

        if (!withinDoctorScope(req, row)) return res.status(403).json({ error: 'الحجز خارج نطاق جدولك' });
        const auditBefore = { status: row.status, date: row.date, doctor: row.doctor };
        const { status } = req.body || {};
        if (status === 'approved' && !['manager', 'accountant'].includes(req.user.role)) return res.status(403).json({ error: 'اعتماد الدفع للمدير أو المحاسب فقط' });
        if (['in_progress', 'skipped', 'completed'].includes(status) && !['manager', 'doctor'].includes(req.user.role)) return res.status(403).json({ error: 'تغيير حالة الكشف للطبيب أو المدير فقط' });
        if (status === 'cancelled' && !['manager', 'accountant'].includes(req.user.role)) return res.status(403).json({ error: 'إلغاء الطلب للمدير أو المحاسب فقط' });

        /* اعتماد الدفع */

        if (status === 'approved') {

            if (row.status !== 'pending') {
                return res.status(409).json({
                    error: 'لا يمكن اعتماد هذا الطلب بحالته الحالية'
                });
            }

            row.status = 'approved';

            row.approvedAt = new Date().toISOString();

            row.appointmentTime = null;
        }

        /* بدء الكشف */

        else if (status === 'in_progress') {

            if (row.status !== 'approved') {
                return res.status(409).json({
                    error: 'لا يمكن بدء الكشف لهذا الطلب'
                });
            }

            row.status = 'in_progress';

            row.startedAt = new Date().toISOString();
        }

        /* تجاوز الدور */

        else if (status === 'skipped') {

            if (!['approved', 'in_progress'].includes(row.status)) {
                return res.status(409).json({
                    error: 'لا يمكن تجاوز هذا الطلب بحالته الحالية'
                });
            }

            row.status = 'skipped';

            row.skippedAt = new Date().toISOString();

            row.queue = null;

            row.appointmentTime = null;
        }

        /* إنهاء الكشف */

        else if (status === 'completed') {

            if (row.status !== 'in_progress') {
                return res.status(409).json({
                    error: 'يجب بدء الكشف قبل إنهائه'
                });
            }

            row.status = 'completed';

            row.completedAt = new Date().toISOString();

            row.queue = null;

            row.appointmentTime = null;
        }

        /* رفض السند وإلغاء الحجز */

        else if (status === 'cancelled') {

            if (row.status !== 'pending') {
                return res.status(409).json({
                    error: 'يمكن إلغاء الحجز فقط قبل اعتماد السند'
                });
            }

            row.status = 'cancelled';

            row.cancelledAt = new Date().toISOString();

            row.queue = null;

            row.appointmentTime = null;

            /*
               لا نحذف صورة السند.
               نحتفظ بها في الملفات كسجل للمراجعة.
            */
        }

        else {

            return res.status(400).json({
                error: 'الحالة المطلوبة غير مسموحة'
            });
        }

        row.updatedAt = new Date().toISOString();
        setAuditChange(req, 'appointment', row.id, auditBefore, { status: row.status, date: row.date, doctor: row.doctor });

        /*
           إعادة حساب أرقام وأوقات المرضى.
           إذا انتهى الكشف مبكرًا يتقدم التالي تلقائيًا.
        */

        rebuildAllQueues(rows);

        writeAppointments(rows);
        if (status === 'approved') void queueNotification(row, 'confirmation', req.user.id);
        if (status === 'cancelled') void queueNotification(row, 'cancellation', req.user.id);

        res.json(publicAppointment(row));

    } catch (error) {

        console.error('تعذر تحديث الموعد:', error);

        res.status(500).json({
            error: error.message || 'تعذر تحديث الطلب'
        });
    }
});

/* =====================================
   إدارة مواعيد العودة
===================================== */

/*
   تحديد العودة:

   POST /api/appointments/:id/return

   {
      "action": "schedule",
      "date": "2026-11-19"
   }

   تسجيل الحضور:

   {
      "action": "attended"
   }

   إنهاء كشف العودة:

   {
      "action": "completed"
   }

   إلغاء العودة:

   {
      "action": "cancel"
   }
*/

app.post('/api/appointments/:id/return', requireAuth, allowRoles('manager', 'doctor', 'receptionist'), (req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        const row = rows.find(item => item.id === req.params.id);

        if (!row) {
            return res.status(404).json({
                error: 'المريض غير موجود'
            });
        }

        if (!withinDoctorScope(req, row)) return res.status(403).json({ error: 'الحجز خارج نطاق جدولك' });
        const auditBefore = { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt };
        const { action, date } = req.body || {};
        if (req.user.role === 'receptionist' && !['schedule', 'cancel'].includes(action)) return res.status(403).json({ error: 'لا تملك صلاحية تغيير حالة الكشف' });

        /* تحديد موعد العودة */

        if (action === 'schedule') {

            if (!['in_progress', 'completed'].includes(row.status)) {
                return res.status(409).json({
                    error: 'يجب بدء الكشف أو إنهاؤه قبل تحديد موعد العودة'
                });
            }

            if (!validDate(String(date || ''))) {
                return res.status(400).json({
                    error: 'تاريخ العودة غير صحيح'
                });
            }

            const today = localDateString();

            if (date < today) {
                return res.status(400).json({
                    error: 'لا يمكن تحديد موعد عودة في تاريخ سابق'
                });
            }

            if (
                row.returnStatus === 'scheduled' ||
                row.returnStatus === 'attended'
            ) {
                return res.status(409).json({
                    error: 'لدى المريض موعد عودة قائم بالفعل'
                });
            }

            if (
                hasBookingConflict(
                    rows,
                    row.phone,
                    row.doctor,
                    date,
                    row.id
                )
            ) {
                return res.status(409).json({
                    error: 'يتعارض موعد العودة مع حجز أو موعد آخر للمريض لدى الطبيب نفسه'
                });
            }

            row.returnDate = date;

            row.returnStatus = 'scheduled';

            row.returnScheduledAt = new Date().toISOString();

            row.returnStartedAt = null;

            row.returnAttendedAt = null;

            row.returnCompletedAt = null;

            row.returnCancelledAt = null;

            row.returnMissedAt = null;

            row.returnQueue = null;

            row.returnTime = null;

            row.updatedAt = new Date().toISOString();

            rebuildAllQueues(rows);

            setAuditChange(req, 'appointment-return', row.id, auditBefore, { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt });
            writeAppointments(rows);

            return res.json({
                message: 'تم تحديد موعد العودة بنجاح',
                appointment: publicAppointment(row)
            });
        }

        /* تسجيل حضور المريض للعودة */

        if (action === 'attended') {

            if (row.returnStatus !== 'scheduled') {
                return res.status(409).json({
                    error: 'لا يوجد موعد عودة مجدول لهذا المريض'
                });
            }

            const today = localDateString();

            if (row.returnDate !== today) {
                return res.status(409).json({
                    error: 'لا يمكن تسجيل الحضور إلا في تاريخ موعد العودة'
                });
            }

            row.returnStatus = 'attended';

            row.returnAttendedAt = new Date().toISOString();

            row.updatedAt = new Date().toISOString();

            /*
               يبقى المريض ضمن طابور العودة
               بعد تسجيل حضوره.
            */

            rebuildAllQueues(rows);

            setAuditChange(req, 'appointment-return', row.id, auditBefore, { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt });
            writeAppointments(rows);

            return res.json({
                message: 'تم تسجيل حضور المريض للمراجعة',
                appointment: publicAppointment(row)
            });
        }

        /* بدء كشف العودة، لتظهر الحالة في شاشة الانتظار */
        if (action === 'start') {
            if (row.returnStatus !== 'attended') return res.status(409).json({ error: 'يجب تسجيل حضور المريض قبل بدء كشف العودة' });
            if (row.returnStartedAt) return res.status(409).json({ error: 'بدأ كشف العودة بالفعل' });
            row.returnStartedAt = new Date().toISOString(); row.updatedAt = new Date().toISOString();
            setAuditChange(req, 'appointment-return', row.id, auditBefore, { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt });
            rebuildAllQueues(rows); writeAppointments(rows);
            return res.json({ message: 'بدأ كشف العودة', appointment: publicAppointment(row) });
        }

        /* إنهاء كشف العودة */

        if (action === 'completed') {

            if (row.returnStatus !== 'attended') {
                return res.status(409).json({
                    error: 'يجب تسجيل حضور المريض قبل إنهاء مراجعة العودة'
                });
            }

            row.returnStatus = 'completed';

            row.returnCompletedAt = new Date().toISOString();

            row.returnQueue = null;

            row.returnTime = null;

            row.updatedAt = new Date().toISOString();

            /*
               عند إنهاء العودة:
               يعاد حساب أوقات بقية المرضى.
            */

            rebuildAllQueues(rows);

            setAuditChange(req, 'appointment-return', row.id, auditBefore, { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt });
            writeAppointments(rows);

            return res.json({
                message: 'تم إنهاء مراجعة العودة بنجاح',
                appointment: publicAppointment(row)
            });
        }

        /* إلغاء موعد العودة */

        if (action === 'cancel') {

            if (!['scheduled', 'missed'].includes(row.returnStatus)) {
                return res.status(409).json({
                    error: 'لا يوجد موعد عودة قابل للإلغاء'
                });
            }

            row.returnStatus = 'cancelled';

            row.returnCancelledAt = new Date().toISOString();

            row.returnQueue = null;

            row.returnTime = null;

            row.updatedAt = new Date().toISOString();

            rebuildAllQueues(rows);

            setAuditChange(req, 'appointment-return', row.id, auditBefore, { returnStatus: row.returnStatus, returnDate: row.returnDate, returnStartedAt: row.returnStartedAt });
            writeAppointments(rows);

            return res.json({
                message: 'تم إلغاء موعد العودة بنجاح',
                appointment: publicAppointment(row)
            });
        }

        return res.status(400).json({
            error: 'الإجراء المطلوب غير معروف'
        });

    } catch (error) {

        console.error('خطأ في إدارة العودة:', error);

        res.status(500).json({
            error: error.message || 'تعذر تنفيذ إجراء العودة'
        });
    }
});

/* =====================================
   جلب صورة سند التحويل
===================================== */

app.get('/api/appointments/:id/receipt', requireAuth, allowRoles('manager', 'accountant'), (req, res) => {

    try {

        const rows = readAppointments();

        const row = rows.find(item => item.id === req.params.id);

        if (!row || !row.receiptFile) {
            return res.status(404).send('السند غير موجود');
        }

        const filename = path.basename(row.receiptFile);

        const filePath = path.join(RECEIPTS_DIR, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).send('ملف السند غير موجود');
        }

        const ext = path.extname(filename).toLowerCase();

        const mimeTypes = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.webp': 'image/webp'
        };

        res.setHeader(
            'Content-Type',
            mimeTypes[ext] || 'application/octet-stream'
        );

        res.setHeader(
            'Content-Disposition',
            'inline'
        );

        res.setHeader(
            'X-Content-Type-Options',
            'nosniff'
        );

        res.sendFile(filePath);

    } catch (error) {

        console.error('تعذر فتح السند:', error);

        res.status(500).send('تعذر فتح السند');
    }
});

/* =====================================
   الصفحة الرئيسية
===================================== */

app.get('/', (_req, res) => {

    res.sendFile(
        path.join(__dirname, 'index.html')
    );
});

/* =====================================
   معالجة الأخطاء
===================================== */

app.use((error, _req, res, _next) => {

    if (
        error instanceof multer.MulterError &&
        error.code === 'LIMIT_FILE_SIZE'
    ) {
        return res.status(413).json({
            error: 'حجم الصورة أكبر من 5 ميجابايت'
        });
    }

    console.error(error);

    res.status(400).json({
        error: error.message || 'طلب غير صالح'
    });
});

/* =====================================
   تشغيل الخادم
===================================== */

app.listen(PORT, HOST, () => {

    setTimeout(sendDueReminders, 5000);
    setInterval(sendDueReminders, 15 * 60 * 1000);

    console.log(
        `Alshifa backend running on http://${HOST}:${PORT}`
    );

    console.log(
        `Appointments JSON: ${DB_FILE}`
    );

    console.log(
        `Receipts folder: ${RECEIPTS_DIR}`
    );

    console.log(
        `Clinic time zone: ${TIME_ZONE}`
    );

    console.log(
        `Clinic starts at: ${CLINIC_START_TIME}`
    );

    console.log(
        `Appointment duration: ${APPOINTMENT_DURATION} minutes`
    );
});
