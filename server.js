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

    const startMinutes = minutesFromTime(CLINIC_START_TIME);

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

        const existingIP = String(row.clientIP || '').trim();

        if (
            normalizedIP &&
            existingIP &&
            normalizedIP === existingIP
        ) {
            return true;
        }

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

        const existingDoctor = String(row.doctor || '').trim();

        const normalConflict =
            existingDoctor === normalizedDoctor &&
            row.date === date &&
            blockingStatus;

        /*
           رابعاً:
           منع التعارض مع موعد العودة.
        */

        const returnConflict =
            existingDoctor === normalizedDoctor &&
            row.returnDate === date &&
            blockingReturn;

        return normalConflict || returnConflict;
    });
}

/* =====================================
   جلب جميع المواعيد
===================================== */

app.get('/api/appointments', (_req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        rebuildAllQueues(rows);

        writeAppointments(rows);

        res.json(rows.map(publicAppointment));

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

            if (!req.file) {
                return res.status(400).json({
                    error: 'يرجى إرفاق صورة سند التحويل'
                });
            }

            const rows = readAppointments();

            updateMissedReturns(rows);

            rebuildAllQueues(rows);

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

app.patch('/api/appointments/:id', (req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        const row = rows.find(item => item.id === req.params.id);

        if (!row) {
            return res.status(404).json({
                error: 'الطلب غير موجود'
            });
        }

        const { status } = req.body || {};

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

        /*
           إعادة حساب أرقام وأوقات المرضى.
           إذا انتهى الكشف مبكرًا يتقدم التالي تلقائيًا.
        */

        rebuildAllQueues(rows);

        writeAppointments(rows);

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

app.post('/api/appointments/:id/return', (req, res) => {

    try {

        const rows = readAppointments();

        updateMissedReturns(rows);

        const row = rows.find(item => item.id === req.params.id);

        if (!row) {
            return res.status(404).json({
                error: 'المريض غير موجود'
            });
        }

        const { action, date } = req.body || {};

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

            writeAppointments(rows);

            return res.json({
                message: 'تم تسجيل حضور المريض للمراجعة',
                appointment: publicAppointment(row)
            });
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

app.get('/api/appointments/:id/receipt', (req, res) => {

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
