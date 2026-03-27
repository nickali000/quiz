const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT) || 1111;

const QUIZ_FILE = path.join(__dirname, "quiz_estratti.json");
const PROGRESS_FILE = path.join(__dirname, "user_progress.json");

const IMAGES_DIR = path.join(__dirname, "immagini_quiz");

app.use(express.json());
app.use("/immagini_quiz", express.static(IMAGES_DIR));
app.use(express.static(path.join(__dirname, "public")));

function resolveCorrectAnswerIndex(rawQuestion, answers) {
  if (Number.isInteger(rawQuestion.risposta_corretta_index)) {
    const byIndex = rawQuestion.risposta_corretta_index;
    if (byIndex >= 0 && byIndex < answers.length) {
      return byIndex;
    }
  }

  if (typeof rawQuestion.risposta_corretta === "string") {
    const byText = answers.findIndex((answer) => answer === rawQuestion.risposta_corretta);
    if (byText >= 0) {
      return byText;
    }
  }

  return null;
}

function normalizeQuestion(rawQuestion, index) {
  const answers = Array.isArray(rawQuestion.risposte)
    ? rawQuestion.risposte.filter((answer) => typeof answer === "string")
    : [];

  const imagePath =
    typeof rawQuestion.immagine_path === "string" && rawQuestion.immagine_path.trim() !== ""
      ? rawQuestion.immagine_path.replace(/\\/g, "/")
      : null;

  const correctAnswerIndex = resolveCorrectAnswerIndex(rawQuestion, answers);

  return {
    id: `${rawQuestion.pagina}-${rawQuestion.numero}-${index}`,
    rawIndex: index,
    numero: rawQuestion.numero,
    pagina: rawQuestion.pagina,
    testo: rawQuestion.testo,
    risposte: answers,
    immagine_path: imagePath,
    correctAnswerIndex
  };
}

function toPublicQuestion(question) {
  return {
    id: question.id,
    numero: question.numero,
    pagina: question.pagina,
    testo: question.testo,
    risposte: question.risposte,
    immagine_url: question.immagine_path ? `/${question.immagine_path}` : null,
    has_correct_answer: Number.isInteger(question.correctAnswerIndex)
  };
}

function loadStore() {
  const raw = fs.readFileSync(QUIZ_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Il file quiz_estratti.json non contiene un array.");
  }

  const normalized = parsed
    .map((question, index) => normalizeQuestion(question, index))
    .filter(
      (question) =>
        typeof question.testo === "string" &&
        question.testo.trim() !== "" &&
        question.risposte.length > 0
    );

  if (normalized.length === 0) {
    throw new Error("Nessuna domanda valida trovata nel file quiz_estratti.json.");
  }

  return {
    rawQuestions: parsed,
    questions: normalized,
    questionsById: new Map(normalized.map((question) => [question.id, question]))
  };
}

function loadProgress() {
  if (!fs.existsSync(PROGRESS_FILE)) {
    return {};
  }
  try {
    const raw = fs.readFileSync(PROGRESS_FILE, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Errore nel caricamento del progresso:", err);
    return {};
  }
}

let store = loadStore();
let progress = loadProgress();

function persistRawQuestions() {
  fs.writeFileSync(QUIZ_FILE, `${JSON.stringify(store.rawQuestions, null, 4)}\n`, "utf-8");
}

function persistProgress() {
  fs.writeFileSync(PROGRESS_FILE, `${JSON.stringify(progress, null, 2)}\n`, "utf-8");
}

function readSelectedIndex(question, answerIndex, answerText) {
  let selectedIndex = -1;

  if (Number.isInteger(answerIndex)) {
    selectedIndex = answerIndex;
  } else if (typeof answerText === "string") {
    selectedIndex = question.risposte.findIndex((answer) => answer === answerText);
  }

  const isValidChoice = selectedIndex >= 0 && selectedIndex < question.risposte.length;
  return { selectedIndex, isValidChoice };
}

app.get("/api/chapters", (_req, res) => {
  const chapters = [...new Set(store.questions.map((q) => q.pagina))].sort((a, b) => a - b);
  res.json(chapters);
});

app.get("/api/progress", (_req, res) => {
  res.json(progress);
});

app.post("/api/questions", (req, res) => {
  const { chapters } = req.body || {};
  if (!Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: "Seleziona almeno un capitolo." });
  }

  const selectedQuestions = store.questions
    .filter((q) => chapters.includes(q.pagina))
    .map((q) => toPublicQuestion(q));

  res.json(selectedQuestions);
});

app.get("/api/question/random", (_req, res) => {
  const randomIndex = Math.floor(Math.random() * store.questions.length);
  const randomQuestion = store.questions[randomIndex];
  res.json(toPublicQuestion(randomQuestion));
});

app.post("/api/question/check", (req, res) => {
  const { questionId, answerIndex, answerText } = req.body || {};

  if (typeof questionId !== "string" || questionId.trim() === "") {
    return res.status(400).json({ error: "questionId mancante o non valido." });
  }

  const question = store.questionsById.get(questionId);
  if (!question) {
    return res.status(404).json({ error: "Domanda non trovata." });
  }

  if (!Number.isInteger(answerIndex) && typeof answerText !== "string") {
    return res.status(400).json({
      error: "Invia answerIndex (numero) oppure answerText (stringa)."
    });
  }

  const { selectedIndex, isValidChoice } = readSelectedIndex(question, answerIndex, answerText);
  const hasCorrectAnswer = Number.isInteger(question.correctAnswerIndex);

  if (!hasCorrectAnswer) {
    return res.json({
      questionId,
      hasCorrectAnswer: false,
      isValidChoice,
      selectedIndex: isValidChoice ? selectedIndex : null,
      selectedAnswer: isValidChoice ? question.risposte[selectedIndex] : null,
      message: "Nessuna risposta corretta impostata. Usa /api/question/set-correct."
    });
  }

  const isCorrect = isValidChoice && selectedIndex === question.correctAnswerIndex;

  return res.json({
    questionId,
    hasCorrectAnswer: true,
    isValidChoice,
    isCorrect,
    selectedIndex: isValidChoice ? selectedIndex : null,
    selectedAnswer: isValidChoice ? question.risposte[selectedIndex] : null,
    correctAnswerIndex: question.correctAnswerIndex,
    correctAnswer: question.risposte[question.correctAnswerIndex]
  });
});

app.post("/api/question/set-correct", (req, res) => {
  const { questionId, answerIndex, answerText } = req.body || {};

  if (typeof questionId !== "string" || questionId.trim() === "") {
    return res.status(400).json({ error: "questionId mancante o non valido." });
  }

  const question = store.questionsById.get(questionId);
  if (!question) {
    return res.status(404).json({ error: "Domanda non trovata." });
  }

  if (!Number.isInteger(answerIndex) && typeof answerText !== "string") {
    return res.status(400).json({
      error: "Invia answerIndex (numero) oppure answerText (stringa)."
    });
  }

  const { selectedIndex, isValidChoice } = readSelectedIndex(question, answerIndex, answerText);
  if (!isValidChoice) {
    return res.status(400).json({ error: "Risposta selezionata non valida per questa domanda." });
  }

  const hadCorrectAnswer = Number.isInteger(question.correctAnswerIndex);
  question.correctAnswerIndex = selectedIndex;

  const rawQuestion = store.rawQuestions[question.rawIndex];
  rawQuestion.risposta_corretta_index = selectedIndex;
  rawQuestion.risposta_corretta = question.risposte[selectedIndex];

  try {
    persistRawQuestions();
  } catch (error) {
    return res.status(500).json({
      error: "Errore durante il salvataggio del file quiz_estratti.json."
    });
  }

  return res.json({
    questionId,
    hasCorrectAnswer: true,
    correctAnswerIndex: selectedIndex,
    correctAnswer: question.risposte[selectedIndex],
    message: hadCorrectAnswer ? "Risposta corretta modificata." : "Risposta corretta impostata."
  });
});

app.post("/api/progress", (req, res) => {
  const { questionId, answerIndex, isCorrect, result } = req.body || {};

  if (!questionId) {
    return res.status(400).json({ error: "questionId mancante." });
  }

  progress[questionId] = {
    answerIndex,
    isCorrect,
    result,
    timestamp: new Date().toISOString()
  };

  try {
    persistProgress();
    res.json({ status: "success" });
  } catch (err) {
    res.status(500).json({ error: "Errore nel salvataggio del progresso." });
  }
});

app.get("/api/health", (_req, res) => {
  const withCorrectAnswer = store.questions.filter((question) =>
    Number.isInteger(question.correctAnswerIndex)
  ).length;

  res.json({
    status: "ok",
    questions: store.questions.length,
    with_correct_answer: withCorrectAnswer
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Quiz server avviato su http://localhost:${PORT}`);
});
