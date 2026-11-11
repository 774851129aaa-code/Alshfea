const express = require('express')
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
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]\n', 'utf8');

app.use(express.json({ limit: '100kb' }));

const allowedTypes = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp'
};

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, RECEIPTS_DIR),
  filename: (_req, file, callback) => {
    const ext = allowedTypes[file.mimetype];
    callback(null, `${Date.now()}-${crypto.randomUUID()}${ext || ''}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!allowedTypes[file.mimetype]) return callback(new Error('نوع صورة السند غير مسموح'));
    callback(null, true);
  }
});

function readAppointments() {
  try {
    const value = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (error) {
    console.error('تعذر قراءة ملف المواعيد:', error);
    throw new Error('تعذر قراءة ملف التخزين JSON');
  }
}

function writeAppointments(rows) {
  const tempFile = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(rows, null, 2)}\n`, 'utf8');
  fs.renameSync(tempFile, DB_FILE);
}

function publicAppointment(row) {
  const { receiptFile, ...safeRow } = row;
  return safeRow;
}

app.get('/api/appointments', (_req, res) => {
  try {
    res.json(readAppointments().map(publicAppointment));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/appointments', upload.single('receipt'), (req, res) => {
  const cleanupUpload = () => {
    if (req.file) fs.rmSync(req.file.path, { force: true });
  };

  try {
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').replace(/[\s()+-]/g, '');
    const doctor = String(req.body.doctor || '').trim();
    const date = String(req.body.date || '').trim();

    if (name.length < 3 || name.length > 90) {
      cleanupUpload();
      return res.status(400).json({ error: 'اسم المريض غير صحيح' });
    }
    if (!/^\d{8,15}$/.test(phone)) {
      cleanupUpload();
      return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
    }
    if (!doctor || doctor.length > 160 || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      cleanupUpload();
      return res.status(400).json({ error: 'بيانات العيادة أو التاريخ غير صحيحة' });
    }
    if (!req.file) return res.status(400).json({ error: 'يرجى إرفاق صورة سند التحويل' });

    const rows = readAppointments();
    const duplicate = rows.some(row =>
      row.phone === phone && row.doctor === doctor && row.date === date &&
      !['skipped', 'completed'].includes(row.status)
    );
    if (duplicate) {
      cleanupUpload();
      return res.status(409).json({ error: 'لديك طلب قائم لنفس الطبيب والتاريخ' });
    }

    const row = {
      id: crypto.randomUUID(),
      name,
      phone,
      doctor,
      date,
      createdAt: new Date().toISOString(),
      status: 'pending',
      queue: null,
      receiptName: path.basename(req.file.originalname).slice(0, 180),
      receiptFile: req.file.filename
    };

    rows.unshift(row);
    writeAppointments(rows);
    res.status(201).json(publicAppointment(row));
  } catch (error) {
    cleanupUpload();
    console.error('تعذر حفظ الموعد:', error);
    res.status(500).json({ error: error.message || 'تعذر حفظ الطلب' });
  }
});

app.patch('/api/appointments/:id', (req, res) => {
  try {
    const rows = readAppointments();
    const row = rows.find(item => item.id === req.params.id);
    if (!row) return res.status(404).json({ error: 'الطلب غير موجود' });

    const { status } = req.body || {};
    if (status === 'approved') {
      if (row.status !== 'pending') {
        return res.status(409).json({ error: 'لا يمكن اعتماد هذا الطلب بحالته الحالية' });
      }
      const activeQueues = rows
        .filter(item => ['approved', 'in_progress'].includes(item.status))
        .map(item => Number(item.queue) || 0);
      row.queue = Math.max(0, ...activeQueues) + 1;
      row.status = 'approved';
    } else if (['in_progress', 'skipped', 'completed'].includes(status)) {
      if (!['approved', 'in_progress'].includes(row.status)) {
        return res.status(409).json({ error: 'الطلب غير موجود في طابور الطبيب' });
      }
      row.status = status;
    } else {
      return res.status(400).json({ error: 'الحالة المطلوبة غير مسموحة' });
    }

    row.updatedAt = new Date().toISOString();
    writeAppointments(rows);
    res.json(publicAppointment(row));
  } catch (error) {
    console.error('تعذر تحديث الموعد:', error);
    res.status(500).json({ error: error.message || 'تعذر تحديث الطلب' });
  }
});

app.get('/api/appointments/:id/receipt', (req, res) => {
  try {
    const row = readAppointments().find(item => item.id === req.params.id);
    if (!row || !row.receiptFile) return res.status(404).send('السند غير موجود');
    const filename = path.basename(row.receiptFile);
    const filePath = path.join(RECEIPTS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).send('ملف السند غير موجود');
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).send('تعذر فتح السند');
  }
});

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'حجم الصورة أكبر من 5 ميجابايت' });
  }
  console.error(error);
  res.status(400).json({ error: error.message || 'طلب غير صالح' });
});

app.listen(PORT, HOST, () => {
  console.log(`Alshifa JSON backend listening on http://${HOST}:${PORT}`);
  console.log(`Appointments JSON: ${DB_FILE}`);
  console.log(`Receipts folder: ${RECEIPTS_DIR}`);
});
