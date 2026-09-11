const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Настройка хранилища для загружаемых картинок вопросов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Функція безпечного читання питань (захист від пустого/бинного файлу)
const getQuestions = () => {
    const qFile = path.join(__dirname, 'questions.json');
    if (!fs.existsSync(qFile)) return [];
    const data = fs.readFileSync(qFile, 'utf-8').trim();
    if (data === "") return [];
    try { return JSON.parse(data); } catch (e) { return []; }
};

// Функція безпечного читання бажань
const getWishes = () => {
    const wishFile = path.join(__dirname, 'wishes.json');
    if (!fs.existsSync(wishFile)) return [];
    const data = fs.readFileSync(wishFile, 'utf-8').trim();
    if (data === "") return [];
    try { return JSON.parse(data); } catch (e) { return []; }
};

// Отдаем список вопросов для тренажера (без правильних відповідей)
app.get('/api/questions', (req, res) => {
    const questions = getQuestions();
    const safeQuestions = questions.map(q => ({
        id: q.id,
        lesson: q.lesson,
        question: q.question,
        image: q.image || "",
        answers: q.answers
    }));
    res.json(safeQuestions);
});

// Отдаем повні питання (використовується і адмінкою, і фронтом учнів — авторизації в проєкті немає)
app.get('/api/admin/questions', (req, res) => {
    res.json(getQuestions());
});

// Приймаємо відповідь від учня (Насті чи Дані)
app.post('/api/submit', (req, res) => {
    const { questionId, answerIndex, role } = req.body;
    const questions = getQuestions();
    const q = questions.find(item => item.id === questionId);

    if (!q) {
        return res.status(404).json({ error: 'Question not found' });
    }

    // Жорстке приведення до числа виключає баги з рядками/числами (особливо для індексу 0)
    const isCorrect = Number(q.correct) === Number(answerIndex);

    const logFile = path.join(__dirname, 'database.json');
    let logs = [];
    if (fs.existsSync(logFile)) {
        const logData = fs.readFileSync(logFile, 'utf-8').trim();
        if (logData !== "") {
            try { logs = JSON.parse(logData); } catch (e) { logs = []; }
        }
    }

    const attempt = {
        timestamp: new Date().toISOString(),
        role: role || 'nastia', // Фіксуємо, хто саме проходив тест
        lesson: q.lesson || 1,
        questionId,
        answerIndex,
        isCorrect
    };
    logs.push(attempt);
    fs.writeFileSync(logFile, JSON.stringify(logs, null, 2), 'utf-8');

    res.json({
        isCorrect,
        correctAnswer: q.correct,
        comment: q.comment
    });
});

// Список усіх загаданих бажань (потрібен і адмінці, і карткам уроків на головному екрані)
app.get('/api/admin/wishes', (req, res) => {
    res.json(getWishes());
});

// Збереження/оновлення бажання, прив'язаного до ролі та конкретного уроку.
// Повторне збереження для тієї самої пари (role, lesson) перезаписує попереднє значення —
// поле бажання в картці уроку можна редагувати будь-коли.
app.post('/api/wishes', (req, res) => {
    const { role, wish, lesson } = req.body;
    const wishFile = path.join(__dirname, 'wishes.json');
    let wishes = getWishes();

    const safeRole = role || 'nastia';
    const safeLesson = Number(lesson) || 1;

    const existingIndex = wishes.findIndex(w => w.role === safeRole && Number(w.lesson) === safeLesson);

    const newWishEntry = {
        timestamp: new Date().toISOString(),
        date: new Date().toLocaleDateString('uk-UA'),
        role: safeRole,
        lesson: safeLesson,
        wish: wish || 'Без тексту'
    };

    if (existingIndex !== -1) {
        wishes[existingIndex] = newWishEntry;
    } else {
        wishes.push(newWishEntry);
    }

    fs.writeFileSync(wishFile, JSON.stringify(wishes, null, 2), 'utf-8');
    res.json({ success: true, message: 'Бажання успішно збережено!' });
});

// Скидання (повне очищення) усіх бажань
app.delete('/api/admin/wishes', (req, res) => {
    const wishFile = path.join(__dirname, 'wishes.json');
    fs.writeFileSync(wishFile, JSON.stringify([], null, 2), 'utf-8');
    res.json({ success: true, message: 'Всі бажання успішно скинуто!' });
});

// Статистика для адмінки
app.get('/api/admin/stats', (req, res) => {
    const logFile = path.join(__dirname, 'database.json');
    if (!fs.existsSync(logFile)) return res.json([]);
    const logData = fs.readFileSync(logFile, 'utf-8').trim();
    if (logData === "") return res.json([]);
    try {
        res.json(JSON.parse(logData));
    } catch (e) {
        res.json([]);
    }
});

// Очищення статистики
app.delete('/api/admin/stats', (req, res) => {
    const logFile = path.join(__dirname, 'database.json');
    fs.writeFileSync(logFile, JSON.stringify([], null, 2), 'utf-8');
    res.json({ success: true, message: 'Статистику очищено' });
});

// Додавання нового питання (із завантаженням картинки через multer)
app.post('/api/admin/questions', upload.single('imageFile'), (req, res) => {
    const qFile = path.join(__dirname, 'questions.json');
    let questions = getQuestions();

    let imagePath = req.body.image || "";
    if (req.file) {
        imagePath = `/uploads/${req.file.filename}`;
    }

    let answersParsed = req.body.answers;
    if (typeof answersParsed === 'string') {
        try { answersParsed = JSON.parse(answersParsed); } catch (e) {}
    }

    const newQuestion = {
        id: questions.length > 0 ? Math.max(...questions.map(q => q.id)) + 1 : 1,
        lesson: Number(req.body.lesson) || 1,
        question: req.body.question,
        image: imagePath,
        answers: answersParsed,
        correct: Number(req.body.correct),
        comment: req.body.comment || "Офіційне пояснення."
    };

    questions.push(newQuestion);
    fs.writeFileSync(qFile, JSON.stringify(questions, null, 2), 'utf-8');
    res.json({ success: true, question: newQuestion });
});

// Редагування існуючого питання за ID
app.put('/api/admin/questions/:id', upload.single('imageFile'), (req, res) => {
    const qId = Number(req.params.id);
    const qFile = path.join(__dirname, 'questions.json');

    let questions = getQuestions();
    const index = questions.findIndex(q => q.id === qId);

    if (index === -1) {
        return res.status(404).json({ error: 'Question not found' });
    }

    let imagePath = questions[index].image;
    if (req.file) {
        imagePath = `/uploads/${req.file.filename}`;
    }

    let answersParsed = req.body.answers;
    if (typeof answersParsed === 'string') {
        try { answersParsed = JSON.parse(answersParsed); } catch (e) {}
    }

    questions[index] = {
        id: qId,
        lesson: Number(req.body.lesson) || questions[index].lesson,
        question: req.body.question || questions[index].question,
        image: imagePath,
        answers: answersParsed || questions[index].answers,
        correct: req.body.correct !== undefined ? Number(req.body.correct) : questions[index].correct,
        comment: req.body.comment !== undefined ? req.body.comment : questions[index].comment
    };

    fs.writeFileSync(qFile, JSON.stringify(questions, null, 2), 'utf-8');
    res.json({ success: true, question: questions[index] });
});

// Видалення питання за ID
app.delete('/api/admin/questions/:id', (req, res) => {
    const qId = Number(req.params.id);
    const qFile = path.join(__dirname, 'questions.json');

    let questions = getQuestions();
    const filtered = questions.filter(q => q.id !== qId);

    fs.writeFileSync(qFile, JSON.stringify(filtered, null, 2), 'utf-8');
    res.json({ success: true, message: 'Питання видалено' });
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});