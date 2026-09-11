// Одноразовий скрипт міграції: переносить дані з локальних JSON-файлів
// (questions.json, wishes.json, database.json) у MongoDB Atlas.
//
// Як запустити (один раз, локально, на своєму ПК):
//   1) npm install          (підтягне пакети mongodb і dotenv)
//   2) прописати MONGODB_URI у файлі .env (див. .env.example)
//   3) node migrate-to-mongo.js
//
// Скрипт можна запускати повторно (перед копіюванням він очищує відповідну
// колекцію в MongoDB, тож дублікатів не буде) — але зазвичай потрібен лише один раз.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
    console.error('❌ Немає MONGODB_URI в .env. Спочатку налаштуй підключення (див. .env.example).');
    process.exit(1);
}

function readJson(file, fallback) {
    const p = path.join(__dirname, file);
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf-8').trim();
    if (!raw) return fallback;
    try { return JSON.parse(raw); } catch (e) { return fallback; }
}

// Якщо картинка питання лежить локально у /public/uploads/..., підвантажуємо
// файл і перетворюємо на base64 data URI, щоб зберегти прямо в MongoDB —
// інакше після переїзду на Mongo ці картинки стали б недоступні (Render
// однаково стирає локальні файли при кожному деплої).
function upgradeImage(imagePath) {
    if (!imagePath || !imagePath.startsWith('/uploads/')) return imagePath || "";
    const localFile = path.join(__dirname, 'public', imagePath);
    if (!fs.existsSync(localFile)) {
        console.warn(`⚠️  Файл картинки не знайдено локально: ${localFile} (лишаю старий шлях як є)`);
        return imagePath;
    }
    const ext = path.extname(localFile).toLowerCase();
    const mime = ext === '.png' ? 'image/png'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'image/jpeg';
    const b64 = fs.readFileSync(localFile).toString('base64');
    return `data:${mime};base64,${b64}`;
}

async function migrate() {
    const questions = readJson('questions.json', []);
    const wishes = readJson('wishes.json', []);
    const stats = readJson('database.json', []);

    console.log(`Знайдено локально: ${questions.length} питань, ${wishes.length} бажань, ${stats.length} записів статистики.`);

    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('pdr_trainer');

    if (questions.length > 0) {
        const upgraded = questions.map(q => ({ ...q, image: upgradeImage(q.image) }));
        await db.collection('questions').deleteMany({});
        await db.collection('questions').insertMany(upgraded);
        console.log(`✅ Перенесено питань: ${upgraded.length}`);
    } else {
        console.log('ℹ️  Локальних питань не знайдено — пропускаю.');
    }

    if (wishes.length > 0) {
        await db.collection('wishes').deleteMany({});
        await db.collection('wishes').insertMany(wishes);
        console.log(`✅ Перенесено бажань: ${wishes.length}`);
    } else {
        console.log('ℹ️  Локальних бажань не знайдено — пропускаю.');
    }

    if (stats.length > 0) {
        await db.collection('stats').deleteMany({});
        await db.collection('stats').insertMany(stats);
        console.log(`✅ Перенесено записів статистики: ${stats.length}`);
    } else {
        console.log('ℹ️  Локальної статистики не знайдено — пропускаю.');
    }

    console.log('🎉 Міграція завершена! Можеш перевіряти дані в MongoDB Atlas (Collections -> pdr_trainer).');
    await client.close();
}

migrate().catch(err => {
    console.error('❌ Помилка міграції:', err);
    process.exit(1);
});
