FROM python:3.12-slim

WORKDIR /app

# Зависимости ставим отдельным слоем (кэшируется, пока requirements не менялся).
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Код приложения (фронтенд лежит в frontend/ и раздаётся самим приложением).
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["python", "run.py"]
