require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const https = require('https');
const { MongoClient } = require('mongodb');

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('❌ Не задано MONGODB_URI. Додай його в .env (локально) або в змінні середовища Render.');
    process.exit(1);
}

app.use(cors());
// Ліміт піднятий, бо масовий імпорт бази питань (JSON з картинками у base64)
// може бути важчим за дефолтні 100kb.
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Картинки зберігаємо прямо в MongoDB як base64 data URI (multer тримає файл у пам'яті,
// а не пише на диск) — інакше вони зникали б після кожного передеплою на Render,
// бо файлова система там ephemeral.
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB на картинку
});

function fileToDataUri(file) {
    if (!file) return null;
    return `data:${file.mimetype};base64,${file.buffer.toString('base64')}`;
}

let db;
const client = new MongoClient(MONGODB_URI);

async function connectDB() {
    await client.connect();
    db = client.db('pdr_trainer');
    console.log('✅ Підключено до MongoDB Atlas');
}

const questionsCol = () => db.collection('questions');
const wishesCol = () => db.collection('wishes');
const statsCol = () => db.collection('stats');
const scoresCol = () => db.collection('scores');

// Проксі для офіційних фото дорожніх знаків з vodiy.ua. Пряме <img src="https://media.vodiy.ua/...">
// у браузері учня не працює — CDN перевіряє заголовок Referer і віддає biту картинку для чужих
// сайтів. Тому картинку тягне сам сервер (тут Referer уже наш, серверний, а не браузерний) і
// віддає її як власну статику. Результат кешується в пам'яті процесу, щоб не смикати vodiy.ua
// повторно — знаки ПДР не змінюються, тож кеш живе, поки сервер не перезапуститься.
const signImageCache = new Map();

app.get('/api/sign-image/:code', (req, res) => {
    const code = (req.params.code || '').replace(/[^0-9.]/g, '');
    if (!code) return res.status(400).end();

    const cached = signImageCache.get(code);
    if (cached) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        return res.end(cached.buffer);
    }

    const upstreamUrl = `https://media.vodiy.ua/trafficsign_image/${code}z.png`;
    https.get(upstreamUrl, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
            'Referer': 'https://vodiy.ua/'
        }
    }, (upstreamRes) => {
        if (upstreamRes.statusCode !== 200) {
            upstreamRes.resume();
            return res.status(502).json({ error: 'Знак не знайдено на джерелі' });
        }
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
            const buffer = Buffer.concat(chunks);
            const contentType = upstreamRes.headers['content-type'] || 'image/png';
            signImageCache.set(code, { buffer, contentType });
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', 'public, max-age=2592000');
            res.end(buffer);
        });
    }).on('error', (e) => {
        console.error('Помилка проксі знаку', code, e.message);
        res.status(502).json({ error: 'Не вдалося завантажити знак' });
    });
});

// Загальний проксі для реальних фото сценаріїв (перехрестя, пішохідні переходи, дорожні
// ситуації), які беремо з Wikimedia Commons — вільно ліцензовані фото, без питань щодо
// копірайту. Дозволені лише конкретні хости (щоб цей роут не перетворився на відкритий
// проксі для будь-яких URL), і рекурсивно (до 3 переходів) обробляються редіректи —
// Special:FilePath на commons.wikimedia.org завжди 302-редіректить на upload.wikimedia.org.
const ALLOWED_IMAGE_HOSTS = new Set(['commons.wikimedia.org', 'upload.wikimedia.org']);
const imgProxyCache = new Map();

function fetchImageFollowingRedirects(url, redirectsLeft, onDone) {
    let target;
    try {
        target = new URL(url);
    } catch (e) {
        return onDone({ error: 'Некоректний URL' });
    }
    if (target.protocol !== 'https:' || !ALLOWED_IMAGE_HOSTS.has(target.hostname)) {
        return onDone({ error: 'Цей хост не в дозволеному списку' });
    }
    https.get(target, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36' }
    }, (upstreamRes) => {
        const { statusCode, headers } = upstreamRes;
        if ([301, 302, 303, 307, 308].includes(statusCode) && headers.location && redirectsLeft > 0) {
            upstreamRes.resume();
            const nextUrl = new URL(headers.location, target).href;
            return fetchImageFollowingRedirects(nextUrl, redirectsLeft - 1, onDone);
        }
        if (statusCode !== 200) {
            upstreamRes.resume();
            return onDone({ error: `Джерело повернуло статус ${statusCode}` });
        }
        const chunks = [];
        upstreamRes.on('data', (chunk) => chunks.push(chunk));
        upstreamRes.on('end', () => {
            onDone({
                buffer: Buffer.concat(chunks),
                contentType: headers['content-type'] || 'image/jpeg'
            });
        });
    }).on('error', (e) => onDone({ error: e.message }));
}

app.get('/api/img-proxy', (req, res) => {
    const src = req.query.src;
    if (!src) return res.status(400).json({ error: 'Параметр src обов\'язковий' });

    const cached = imgProxyCache.get(src);
    if (cached) {
        res.setHeader('Content-Type', cached.contentType);
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        return res.end(cached.buffer);
    }

    fetchImageFollowingRedirects(src, 3, (result) => {
        if (result.error) {
            console.error('Помилка img-proxy', src, result.error);
            return res.status(502).json({ error: result.error });
        }
        imgProxyCache.set(src, result);
        res.setHeader('Content-Type', result.contentType);
        res.setHeader('Cache-Control', 'public, max-age=2592000');
        res.end(result.buffer);
    });
});

// Прибираємо службове поле _id перед відправкою на фронт (фронт і адмінка
// звикли працювати з власним числовим полем id)
const clean = (doc) => {
    if (!doc) return doc;
    const { _id, ...rest } = doc;
    return rest;
};

// Отдаем список вопросов для тренажера (без правильних відповідей)
app.get('/api/questions', async (req, res) => {
    try {
        const questions = await questionsCol().find().toArray();
        const safeQuestions = questions.map(q => ({
            id: q.id,
            lesson: q.lesson,
            question: q.question,
            image: q.image || "",
            answers: q.answers
        }));
        res.json(safeQuestions);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Отдаем повні питання (використовується і адмінкою, і фронтом учнів — авторизації в проєкті немає)
app.get('/api/admin/questions', async (req, res) => {
    try {
        const questions = await questionsCol().find().toArray();
        res.json(questions.map(clean));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Приймаємо відповідь від учня (Насті чи Дані)
app.post('/api/submit', async (req, res) => {
    try {
        const { questionId, answerIndex, role } = req.body;
        const q = await questionsCol().findOne({ id: questionId });

        if (!q) {
            return res.status(404).json({ error: 'Question not found' });
        }

        // Жорстке приведення до числа виключає баги з рядками/числами (особливо для індексу 0)
        const isCorrect = Number(q.correct) === Number(answerIndex);

        await statsCol().insertOne({
            timestamp: new Date().toISOString(),
            role: role || 'nastia', // Фіксуємо, хто саме проходив тест
            lesson: q.lesson || 1,
            questionId,
            answerIndex,
            isCorrect
        });

        res.json({
            isCorrect,
            correctAnswer: q.correct,
            comment: q.comment
        });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Список усіх загаданих бажань (потрібен і адмінці, і карткам уроків на головному екрані)
app.get('/api/admin/wishes', async (req, res) => {
    try {
        const wishes = await wishesCol().find().toArray();
        res.json(wishes.map(clean));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Збереження/оновлення бажання, прив'язаного до ролі та конкретного уроку.
// Повторне збереження для тієї самої пари (role, lesson) перезаписує попереднє значення —
// поле бажання в картці уроку можна редагувати будь-коли.
app.post('/api/wishes', async (req, res) => {
    try {
        const { role, wish, lesson } = req.body;
        const safeRole = role || 'nastia';
        const safeLesson = Number(lesson) || 1;

        const newWishEntry = {
            timestamp: new Date().toISOString(),
            date: new Date().toLocaleDateString('uk-UA'),
            role: safeRole,
            lesson: safeLesson,
            wish: wish || 'Без тексту'
        };

        await wishesCol().updateOne(
            { role: safeRole, lesson: safeLesson },
            { $set: newWishEntry },
            { upsert: true }
        );

        res.json({ success: true, message: 'Бажання успішно збережено!' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Скидання (повне очищення) усіх бажань
app.delete('/api/admin/wishes', async (req, res) => {
    try {
        await wishesCol().deleteMany({});
        res.json({ success: true, message: 'Всі бажання успішно скинуто!' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Результати проходження уроків (у %) — зберігаються на сервері, а не лише
// в localStorage браузера. Це важливо: якщо тримати результат тільки в
// localStorage, то на новому пристрої/у іншому браузері прогрес завжди
// виглядатиме "не пройдено", а стара локальна кеш-копія в браузері може
// показувати застарілий результат навіть після скидання бази на сервері.
// Тому сервер тепер є єдиним джерелом правди для прогресу.
app.get('/api/admin/scores', async (req, res) => {
    try {
        const scores = await scoresCol().find().toArray();
        res.json(scores.map(clean));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

app.post('/api/scores', async (req, res) => {
    try {
        const { role, lesson, percent } = req.body;
        const safeRole = role || 'nastia';
        const safeLesson = Number(lesson) || 1;
        const safePercent = Number(percent) || 0;

        await scoresCol().updateOne(
            { role: safeRole, lesson: safeLesson },
            { $set: {
                role: safeRole,
                lesson: safeLesson,
                percent: safePercent,
                timestamp: new Date().toISOString()
            } },
            { upsert: true }
        );

        res.json({ success: true });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Скидання прогресу (усіх результатів проходження) — корисно перед "чистим" повторним запуском
app.delete('/api/admin/scores', async (req, res) => {
    try {
        await scoresCol().deleteMany({});
        res.json({ success: true, message: 'Прогрес скинуто' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Статистика для адмінки
app.get('/api/admin/stats', async (req, res) => {
    try {
        const logs = await statsCol().find().toArray();
        res.json(logs.map(clean));
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Очищення статистики
app.delete('/api/admin/stats', async (req, res) => {
    try {
        await statsCol().deleteMany({});
        res.json({ success: true, message: 'Статистику очищено' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Додавання нового питання (із завантаженням картинки через multer, зберігається як base64)
app.post('/api/admin/questions', upload.single('imageFile'), async (req, res) => {
    try {
        let imagePath = req.body.image || "";
        if (req.file) {
            imagePath = fileToDataUri(req.file);
        }

        let answersParsed = req.body.answers;
        if (typeof answersParsed === 'string') {
            try { answersParsed = JSON.parse(answersParsed); } catch (e) {}
        }

        const lastQuestion = await questionsCol().find().sort({ id: -1 }).limit(1).toArray();
        const nextId = lastQuestion.length > 0 ? lastQuestion[0].id + 1 : 1;

        const newQuestion = {
            id: nextId,
            lesson: Number(req.body.lesson) || 1,
            question: req.body.question,
            image: imagePath,
            answers: answersParsed,
            correct: Number(req.body.correct),
            comment: req.body.comment || "Офіційне пояснення."
        };

        await questionsCol().insertOne(newQuestion);
        res.json({ success: true, question: clean(newQuestion) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Редагування існуючого питання за ID
app.put('/api/admin/questions/:id', upload.single('imageFile'), async (req, res) => {
    try {
        const qId = Number(req.params.id);
        const existing = await questionsCol().findOne({ id: qId });

        if (!existing) {
            return res.status(404).json({ error: 'Question not found' });
        }

        let imagePath = existing.image;
        if (req.file) {
            imagePath = fileToDataUri(req.file);
        }

        let answersParsed = req.body.answers;
        if (typeof answersParsed === 'string') {
            try { answersParsed = JSON.parse(answersParsed); } catch (e) {}
        }

        const updatedFields = {
            lesson: Number(req.body.lesson) || existing.lesson,
            question: req.body.question || existing.question,
            image: imagePath,
            answers: answersParsed || existing.answers,
            correct: req.body.correct !== undefined ? Number(req.body.correct) : existing.correct,
            comment: req.body.comment !== undefined ? req.body.comment : existing.comment
        };

        await questionsCol().updateOne({ id: qId }, { $set: updatedFields });
        res.json({ success: true, question: clean({ id: qId, ...updatedFields }) });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Видалення питання за ID
app.delete('/api/admin/questions/:id', async (req, res) => {
    try {
        const qId = Number(req.params.id);
        await questionsCol().deleteOne({ id: qId });
        res.json({ success: true, message: 'Питання видалено' });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка сервера' });
    }
});

// Масовий імпорт бази питань з JSON-файлу (замінює ручне додавання питання
// за питанням через форму). Формат тіла запиту:
// {
//   "replaceAll": false,          // true — спочатку видалити всю поточну базу питань
//   "lessons": [
//     {
//       "lesson": 1,
//       "topic": "Дорожні знаки",  // необов'язково, лише для зручності при заповненні файлу
//       "questions": [
//         {
//           "question": "Текст питання",
//           "image": "",           // URL картинки або порожній рядок
//           "answers": ["Варіант 1", "Варіант 2", "Варіант 3"],
//           "correct": 0,          // індекс правильної відповіді (з 0)
//           "comment": "Пояснення чому саме ця відповідь правильна",
//           "rule": "п. 10.1 ПДР", // необов'язково
//           "ruleLink": "https://zakon.rada.gov.ua/laws/show/1306-2001-п#n123" // необов'язково
//         }
//       ]
//     }
//   ]
// }
app.post('/api/admin/questions/import', async (req, res) => {
    try {
        const { replaceAll, lessons } = req.body;

        if (!Array.isArray(lessons)) {
            return res.status(400).json({ error: 'Очікується поле "lessons" (масив уроків із питаннями)' });
        }

        let nextId = 1;
        if (!replaceAll) {
            const last = await questionsCol().find().sort({ id: -1 }).limit(1).toArray();
            nextId = last.length > 0 ? last[0].id + 1 : 1;
        }

        const newQuestions = [];
        for (const lessonBlock of lessons) {
            const lessonNum = Number(lessonBlock.lesson) || 1;
            const questions = Array.isArray(lessonBlock.questions) ? lessonBlock.questions : [];

            for (const q of questions) {
                if (!q.question || !Array.isArray(q.answers) || q.answers.length === 0) {
                    continue; // пропускаємо биті записи, а не валимо весь імпорт
                }

                // Якщо вказано пункт ПДР (rule) і/або посилання на закон (ruleLink) —
                // вшиваємо номер пункту як клікабельне посилання прямо в пояснення,
                // за тим самим форматом, що й кнопка "Вставити посилання на ПДР" в адмінці.
                let comment = q.comment || '';
                if (q.ruleLink) {
                    const linkText = q.rule || 'пункт ПДР';
                    const link = `<a href='${q.ruleLink}' target='_blank'>${linkText}</a>`;
                    comment = comment ? `${comment} (${link})` : `Згідно з ${link}.`;
                } else if (q.rule) {
                    comment = comment ? `${comment} (${q.rule})` : `Згідно з ${q.rule}.`;
                }

                newQuestions.push({
                    id: nextId++,
                    lesson: lessonNum,
                    question: q.question,
                    image: q.image || "",
                    answers: q.answers,
                    correct: Number(q.correct) || 0,
                    comment: comment || "Офіційне пояснення відсутнє."
                });
            }
        }

        if (newQuestions.length === 0) {
            return res.status(400).json({ error: 'У файлі не знайдено жодного коректного питання' });
        }

        if (replaceAll) {
            await questionsCol().deleteMany({});
        }
        await questionsCol().insertMany(newQuestions);

        res.json({ success: true, imported: newQuestions.length, replacedAll: !!replaceAll });
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Помилка імпорту' });
    }
});

connectDB()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('❌ Не вдалося підключитись до MongoDB:', err);
        process.exit(1);
    });