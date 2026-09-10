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

// Функция безопасного чтения вопросов (с защитой от пустого файла)
const getQuestions = () => {
    const qFile = path.join(__dirname, 'questions.json');
    if (!fs.existsSync(qFile)) {
        return [];
    }
    const data = fs.readFileSync(qFile, 'utf-8').trim();
    if (data === "") {
        return [];
    }
    try {
        return JSON.parse(data);
    } catch (e) {
        return [];
    }
};

// Отдаем список вопросов для тренажера (без правильных ответов)
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

// Отдаем полные вопросы для админки
app.get('/api/admin/questions', (req, res) => {
    res.json(getQuestions());
});

// Принимаем ответ от ученика (Насти или Дани)
app.post('/api/submit', (req, res) => {
    const { questionId, answerIndex, role } = req.body;
    const questions = getQuestions();
    const q = questions.find(item => item.id === questionId);

    if (!q) {
        return res.status(404).json({ error: 'Question not found' });
    }

    // Жесткое приведение к числу исключает баги со строками/числами (особенно для индекса 0)
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
        role: role || 'nastia', // Фиксируем, кто именно проходил тест
        lesson: q.lesson,
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

// Сохранение загаданного желания за успешный испит ( >= 90% )
app.post('/api/wishes', (req, res) => {
    const { role, wish } = req.body;
    const wishFile = path.join(__dirname, 'wishes.json');
    let wishes = [];
    
    if (fs.existsSync(wishFile)) {
        const data = fs.readFileSync(wishFile, 'utf-8').trim();
        if (data !== "") {
            try { wishes = JSON.parse(data); } catch (e) { wishes = []; }
        }
    }

    wishes.push({
        timestamp: new Date().toISOString(),
        role: role || 'nastia',
        wish: wish || 'Без тексту'
    });

    fs.writeFileSync(wishFile, JSON.stringify(wishes, null, 2), 'utf-8');
    res.json({ success: true, message: 'Бажання успішно збережено!' });
});

// Статистика для админки
app.get('/api/admin/stats', (req, res) => {
    const logFile = path.join(__dirname, 'database.json');
    if (!fs.existsSync(logFile)) {
        return res.json([]);
    }
    const logData = fs.readFileSync(logFile, 'utf-8').trim();
    if (logData === "") return res.json([]);
    try {
        const logs = JSON.parse(logData);
        res.json(logs);
    } catch (e) {
        res.json([]);
    }
});

// Очистка статистики
app.delete('/api/admin/stats', (req, res) => {
    const logFile = path.join(__dirname, 'database.json');
    fs.writeFileSync(logFile, JSON.stringify([], null, 2), 'utf-8');
    res.json({ success: true, message: 'Статистику очищено' });
});

// Добавление нового вопроса (с загрузкой картинки через multer и защитой пустого файла)
app.post('/api/admin/questions', upload.single('imageFile'), (req, res) => {
    const qFile = path.join(__dirname, 'questions.json');
    let questions = getQuestions();

    let imagePath = req.body.image || "";
    if (req.file) {
        imagePath = `/uploads/${req.file.filename}`;
    }

    let answersParsed = req.body.answers;
    if (typeof answersParsed === 'string') {
        try { answersParsed = JSON.parse(answersParsed); } catch(e) {}
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

// Редактирование существующего вопроса по ID
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
        try { answersParsed = JSON.parse(answersParsed); } catch(e) {}
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

// Удаление вопроса по ID
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