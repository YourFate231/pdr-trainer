import json
import requests
from bs4 import BeautifulSoup

# Пример ссылки на открытый ресурс или конкретную тему ПДД
# (можно заменить на нужный URL сайта с тестами)
url = "https://green-way.com/ua/tsts-pdd-ukraini/" 

def parse_pdr_questions():
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
    
    print("Подключаемся к источнику...")
    response = requests.get(url, headers=headers)
    if response.status_code != 200:
        print(f"Ошибка доступа: {response.status_code}")
        return

    soup = BeautifulSoup(response.text, 'html.parser')
    
    questions_list = []
    
    # Пример поиска блоков вопросов (селекторы зависят от сайта)
    # Нам нужно пройтись по карточкам вопросов и вытащить текст, варианты и подсказки
    question_cards = soup.select('.question-item-class') # Пример селектора
    
    print(f"Найдено элементов: {len(question_cards)}")
    
    for index, card in enumerate(question_cards):
        try:
            q_text = card.select_one('.question-title').get_text(strip=True)
            answers = [ans.get_text(strip=True) for ans in card.select('.answer-option')]
            
            # Собираем в наш формат
            questions_list.append({
                "id": index + 1,
                "lesson": (index // 20) + 1,  # Автоматически разбиваем по 20 вопросов на 1 урок
                "question": q_text,
                "answers": answers,
                "correct": 0, # Индекс правильного ответа (нужно будет уточнить по верстке сайта)
                "comment": "Офіційне пояснення з бази."
            })
        except Exception as e:
            continue

    # Сохраняем в questions.json в корень проекта
    with open('questions.json', 'w', encoding='utf-8') as f:
        json.dump(questions_list, f, ensure_ascii=False, indent=4)
    
    print(f"Успешно спарсено и сохранено вопросов: {len(questions_list)}")

if __name__ == "__main__":
    parse_pdr_questions()