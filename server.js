const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';

const DATA_DIR = path.join(__dirname, 'data');
const RECEIPTS_DIR = path.join(DATA_DIR, 'receipts');
const DB_FILE = path.join(DATA_DIR, 'appointments.json');

fs.mkdirSync(RECEIPTS_DIR, { recursive: true });

if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, '[]\n', 'utf8');
}

app.use(express.json({ limit: '100kb' }));

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
   أدوات قاعدة البيانات JSON
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

function publicAppointment(row) {
    const { receiptFile, ...safeRow } = row;

    return safeRow;
}

function validDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return false;
    }

    const parsed = new Date(`${date}T00:00:00`);

    return (
        !Number.isNaN(parsed.getTime()) &&
        parsed.toISOString().slice(0, 10) === date
    );
}

function normalizePhone(value) {
    return String(value || '').replace(/[\s()+-]/g, '');
}

function isActiveBooking(row) {
    return ['approved', 'in_progress'].includes(row.status);
}

function isScheduledReturn(row) {
    return row.returnStatus === 'scheduled';
}

/* =====================================
   تحديث حالات العودة الفائتة
===================================== */

function updateMissedReturns(rows) {
    const today = new Date().toISOString().slice(0, 10);

    let changed = false;

    for (const row of rows) {
        if (
            row.returnStatus === 'scheduled' &&
            row.returnDate &&
            row.returnDate < today
        ) {
            row.returnStatus = 'missed';
            row.returnMissedAt = new Date().toISOString();

            changed = true;
        }
    }

    if (changed) {
        writeAppointments(rows);
    }

    return rows;
}

/* =====================================
   ترتيب الطابور
===================================== */

/*
   الأولوية:
   1- مرضى العودة.
   2- الحجوزات العادية.

   داخل كل مجموعة:
   الأسبق في التسجيل أو الاعتماد أولاً.

   الترقيم يبدأ من 1 لكل طبيب ولكل تاريخ.
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
        return new Date(a.returnScheduledAt || a.createdAt) -
               new Date(b.returnScheduledAt || b.createdAt);
    });

    normalBookings.sort((a, b) => {
        return new Date(a.approvedAt || a.createdAt) -
               new Date(b.approvedAt || b.createdAt);
    });

    let number = 1;

    for (const row of returns) {
        row.returnQueue = number++;
    }

    for (const row of normalBookings) {
        row.queue = number++;
    }
}

/* =====================================
   التحقق من تعارض الحجوزات
===================================== */

function hasBookingConflict(rows, phone, doctor, date, excludeId = null) {

    return rows.some(row => {

        if (row.id === excludeId) {
            return false;
        }

        if (
            row.phone !== phone ||
            row.doctor !== doctor
        ) {
            return false;
        }

        // حجز عادي قائم في نفس التاريخ
        const normalConflict =
            row.date === date &&
            isActiveBooking(row);

        // موعد عودة قائم في نفس التاريخ
        const returnConflict =
            row.returnDate === date &&
            isScheduledReturn(row);

        return normalConflict || returnConflict;
    });
}

/* =====================================
   جلب جميع المواعيد
===================================== */

app.get('/api/appointments', (_req, res) => {

    try {
        const rows = updateMissedReturns(readAppointments());

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

            const rows = updateMissedReturns(readAppointments());

            /*
              منع التعارض مع:
              - حجز عادي قائم.
              - موعد عودة مجدول.
            */

            const conflict = hasBookingConflict(
                rows,
                phone,
                doctor,
                date
            );

            if (conflict) {

                cleanupUpload();

                return res.status(409).json({
                    error: 'يوجد لديك حجز أو موعد عودة مع نفس الطبيب في هذا التاريخ'
                });
            }

            const row = {

                id: crypto.randomUUID(),

                name,
                phone,
                doctor,
                date,

                createdAt: new Date().toISOString(),

                approvedAt: null,

                status: 'pending',

                queue: null,

                receiptName: path
                    .basename(req.file.originalname)
                    .slice(0, 180),

                receiptFile: req.file.filename,

                // بيانات العودة

                returnDate: null,

                returnQueue: null,

                returnStatus: 'not_scheduled',

                returnScheduledAt: null,

                returnAttendedAt: null,

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
   اعتماد الدفع وتخصيص رقم الدور
===================================== */

app.patch('/api/appointments/:id', (req, res) => {

    try {

        const rows = updateMissedReturns(readAppointments());

        const row = rows.find(item => item.id === req.params.id);

        if (!row) {
            return res.status(404).json({
                error: 'الطلب غير موجود'
            });
        }

        const { status } = req.body || {};

        if (status === 'approved') {

            if (row.status !== 'pending') {
                return res.status(409).json({
                    error: 'لا يمكن اعتماد هذا الطلب بحالته الحالية'
                });
            }

            row.status = 'approved';

            row.approvedAt = new Date().toISOString();

            /*
              إعادة ترتيب الطابور.
              يبدأ من رقم 1.
            */

            rebuildQueues(
                rows,
                row.doctor,
                row.date
            );

        } else if (
            ['in_progress', 'skipped', 'completed'].includes(status)
        ) {

            if (!['approved', 'in_progress'].includes(row.status)) {
                return res.status(409).json({
                    error: 'الطلب غير موجود في طابور الطبيب'
                });
            }

            row.status = status;

            if (status === 'skipped' || status === 'completed') {
                row.queue = null;
            }

            rebuildQueues(
                rows,
                row.doctor,
                row.date
            );

        } else {

            return res.status(400).json({
                error: 'الحالة المطلوبة غير مسموحة'
            });
        }

        row.updatedAt = new Date().toISOString();

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
   تحديد موعد عودة:

   POST /api/appointments/:id/return

   body:
   {
      "action": "schedule",
      "date": "2026-11-19"
   }

   حضور المريض:

   {
      "action": "attended"
   }

   إلغاء العودة:

   {
      "action": "cancel"
   }
*/

app.post('/api/appointments/:id/return', (req, res) => {

    try {

        const rows = updateMissedReturns(readAppointments());

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

            const today = new Date().toISOString().slice(0, 10);

            if (date < today) {
                return res.status(400).json({
                    error: 'لا يمكن تحديد موعد عودة في تاريخ سابق'
                });
            }

            if (row.returnStatus === 'scheduled') {
                return res.status(409).json({
                    error: 'لدى المريض موعد عودة مجدول بالفعل'
                });
            }

            /*
              منع تعارض العودة مع حجز عادي
              أو موعد عودة آخر لنفس المريض والطبيب.
            */

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

            row.returnAttendedAt = null;

            row.returnCancelledAt = null;

            row.returnMissedAt = null;

            /*
              إعطاء العودة الأولوية في الطابور.
            */

            rebuildQueues(
                rows,
                row.doctor,
                date
            );

            row.updatedAt = new Date().toISOString();

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

            const today = new Date().toISOString().slice(0, 10);

            if (row.returnDate !== today) {
                return res.status(409).json({
                    error: 'لا يمكن تسجيل الحضور إلا في تاريخ موعد العودة'
                });
            }

            row.returnStatus = 'attended';

            row.returnAttendedAt = new Date().toISOString();

            row.updatedAt = new Date().toISOString();

            /*
              بعد الحضور يصبح الموعد مكتملًا،
              ولا يعود يحجز مكانًا في الطابور.
            */

            row.returnQueue = null;

            rebuildQueues(
                rows,
                row.doctor,
                row.returnDate
            );

            writeAppointments(rows);

            return res.json({
                message: 'تم تسجيل حضور المريض للمراجعة',
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

            const oldDate = row.returnDate;

            row.returnStatus = 'cancelled';

            row.returnCancelledAt = new Date().toISOString();

            row.returnQueue = null;

            row.updatedAt = new Date().toISOString();

            rebuildQueues(
                rows,
                row.doctor,
                oldDate
            );

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

/*
   يفتح المحاسب هذا الرابط في المتصفح:

   /api/appointments/ID/receipt

   وتظهر الصورة مباشرة.
*/

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

});
