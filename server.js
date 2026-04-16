const express = require("express");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");
const multer = require("multer");

const app = express();
const PORT = Number(process.env.PORT) || 1111;
const execFileAsync = promisify(execFile);

const QUIZ_FILE = path.join(__dirname, "quiz_estratti.json");
const PROGRESS_FILE = path.join(__dirname, "user_progress.json");
const DEFAULT_SUBJECT_NAME = "Scienza degli alimenti";
const IMAGES_DIR = path.join(__dirname, "immagini_quiz");
const UPLOADS_DIR = path.join(__dirname, "tmp_uploads");
const PDF_IMPORT_SCRIPT = path.join(__dirname, "scripts", "import_quiz_pdf.py");
const PYTHON_VENV_BINARY = path.join(__dirname, ".venv", "bin", "python");
const MAX_UPLOAD_SIZE_BYTES = 300 * 1024 * 1024;
const FOOTER_PATTERN = /Powered by TCPDF/i;
const CONTINUATION_WORD_PATTERN =
  /^(?:[a-zà-ù(0-9"'`]|gruppi\b|fisiologiche\b|concorrono\b|conservazione\b|biologica\b|dell'azoto\b|primaria\b|schiume\b|temperature\b|insorgenza\b|stato\b|elementi\b|chetonico\b|favoriscono\b|tranne\b)/i;

fs.mkdirSync(IMAGES_DIR, { recursive: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

app.use(express.json());
app.use("/immagini_quiz", express.static(IMAGES_DIR));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  dest: UPLOADS_DIR,
  limits: { fileSize: MAX_UPLOAD_SIZE_BYTES },
  fileFilter: (_req, file, callback) => {
    const isPdf =
      file.mimetype === "application/pdf" || file.originalname.toLowerCase().endsWith(".pdf");
    if (!isPdf) {
      callback(new Error("Carica un file PDF valido."));
      return;
    }
    callback(null, true);
  }
});

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

function slugifySubjectName(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "materia";
}

function resolveSubjectName(rawQuestion) {
  if (typeof rawQuestion.materia === "string" && rawQuestion.materia.trim() !== "") {
    return rawQuestion.materia.trim();
  }

  return DEFAULT_SUBJECT_NAME;
}

function isQuestionUsable(question) {
  return (
    typeof question.testo === "string" &&
    question.testo.trim() !== "" &&
    Array.isArray(question.risposte) &&
    question.risposte.length > 0
  );
}

function joinTextParts(...parts) {
  return parts
    .map((part) => String(part || "").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function sanitizeExtractedAnswers(rawAnswers) {
  return Array.isArray(rawAnswers)
    ? rawAnswers
        .filter((answer) => typeof answer === "string")
        .map((answer) => answer.trim())
        .filter((answer) => answer !== "" && !FOOTER_PATTERN.test(answer))
    : [];
}

function scoreAnswerMerge(left, right) {
  let score = 0;

  if (left.length >= 80) score += 3;
  if (right.length <= 80) score += 2;
  if (CONTINUATION_WORD_PATTERN.test(right)) score += 5;
  if (/^[a-zà-ù]/i.test(right)) score += 2;
  if (/[,;:]$/.test(left)) score += 2;
  if (!/[.?!]$/.test(left)) score += 1;
  if (/^[A-ZÀ-Ù]/.test(right)) score -= 2;
  if (left.length < 30 && right.length > 80) score -= 1;

  return score;
}

function repairExtractedAnswers(rawAnswers) {
  const answers = sanitizeExtractedAnswers(rawAnswers);
  let mergedLines = 0;

  while (answers.length > 4) {
    let bestMergeIndex = 0;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (let index = 0; index < answers.length - 1; index += 1) {
      const score = scoreAnswerMerge(answers[index], answers[index + 1]);
      if (score > bestScore) {
        bestScore = score;
        bestMergeIndex = index;
      }
    }

    answers.splice(
      bestMergeIndex,
      2,
      joinTextParts(answers[bestMergeIndex], answers[bestMergeIndex + 1])
    );
    mergedLines += 1;
  }

  return { answers, mergedLines };
}

function prepareImportedQuestions(extractedQuestions, subjectName) {
  let repairedQuestions = 0;
  let mergedLines = 0;

  const questions = extractedQuestions.map((question) => {
    const originalAnswers = Array.isArray(question.risposte) ? question.risposte : [];
    const { answers, mergedLines: localMergedLines } = repairExtractedAnswers(originalAnswers);

    if (localMergedLines > 0 || answers.length !== originalAnswers.length) {
      repairedQuestions += 1;
    }
    mergedLines += localMergedLines;

    return {
      ...question,
      materia: subjectName,
      testo: typeof question.testo === "string" ? question.testo.trim() : "",
      risposte: answers,
      immagine_path:
        typeof question.immagine_path === "string" && question.immagine_path.trim() !== ""
          ? question.immagine_path.trim()
          : null
    };
  });

  return {
    questions,
    stats: {
      repairedQuestions,
      mergedLines,
      validQuestions: questions.filter((question) => isQuestionUsable(question)).length
    }
  };
}

function refreshStore() {
  store = loadStore();
}

function resolvePythonBinary() {
  return fs.existsSync(PYTHON_VENV_BINARY) ? PYTHON_VENV_BINARY : "python3";
}

function normalizeQuestion(rawQuestion, index) {
  const answers = Array.isArray(rawQuestion.risposte)
    ? rawQuestion.risposte.filter((answer) => typeof answer === "string")
    : [];
  const subjectName = resolveSubjectName(rawQuestion);
  const subjectId = slugifySubjectName(subjectName);

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
    materia: subjectName,
    materia_id: subjectId,
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
    materia: question.materia,
    materia_id: question.materia_id,
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
    .filter((question) => isQuestionUsable(question));

  if (normalized.length === 0) {
    throw new Error("Nessuna domanda valida trovata nel file quiz_estratti.json.");
  }

  const subjectsMap = new Map();
  normalized.forEach((question) => {
    if (!subjectsMap.has(question.materia_id)) {
      subjectsMap.set(question.materia_id, {
        id: question.materia_id,
        name: question.materia,
        chapters: new Set(),
        questionCount: 0
      });
    }

    const subject = subjectsMap.get(question.materia_id);
    if (Number.isInteger(question.pagina)) {
      subject.chapters.add(question.pagina);
    }
    subject.questionCount += 1;
  });

  const subjects = [...subjectsMap.values()]
    .map((subject) => ({
      id: subject.id,
      name: subject.name,
      chapters: [...subject.chapters].sort((a, b) => a - b),
      questionCount: subject.questionCount
    }))
    .sort((left, right) => left.name.localeCompare(right.name, "it"));

  return {
    rawQuestions: parsed,
    questions: normalized,
    questionsById: new Map(normalized.map((question) => [question.id, question])),
    subjects,
    subjectsById: new Map(subjects.map((subject) => [subject.id, subject]))
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

app.get("/api/subjects", (_req, res) => {
  res.json(store.subjects);
});

app.get("/api/chapters", (_req, res) => {
  const { subjectId } = _req.query || {};
  const selectedQuestions =
    typeof subjectId === "string" && store.subjectsById.has(subjectId)
      ? store.questions.filter((q) => q.materia_id === subjectId)
      : store.questions;
  const chapters = [...new Set(selectedQuestions.map((q) => q.pagina))].sort((a, b) => a - b);
  res.json(chapters);
});

app.get("/api/progress", (_req, res) => {
  res.json(progress);
});

app.post("/api/subjects/import", (req, res) => {
  upload.single("pdf")(req, res, async (uploadError) => {
    const uploadedFile = req.file;

    try {
      if (uploadError) {
        return res.status(400).json({ error: uploadError.message || "Upload non riuscito." });
      }

      const subjectName =
        typeof req.body?.subjectName === "string" ? req.body.subjectName.trim() : "";

      if (subjectName === "") {
        return res.status(400).json({ error: "Inserisci il titolo della materia." });
      }

      if (!uploadedFile) {
        return res.status(400).json({ error: "Carica un PDF prima di importare." });
      }

      const subjectId = slugifySubjectName(subjectName);
      if (store.subjectsById.has(subjectId)) {
        return res.status(409).json({
          error: "Esiste gia una materia con questo titolo. Scegli un nome diverso."
        });
      }

      const { stdout, stderr } = await execFileAsync(
        resolvePythonBinary(),
        [
          PDF_IMPORT_SCRIPT,
          "--input",
          uploadedFile.path,
          "--subject",
          subjectName,
          "--images-dir",
          IMAGES_DIR,
          "--images-relative-dir",
          "immagini_quiz",
          "--image-prefix",
          subjectId
        ],
        { maxBuffer: 50 * 1024 * 1024 }
      );

      if (stderr && stderr.trim() !== "") {
        console.warn("Import PDF stderr:", stderr.trim());
      }

      const parsed = JSON.parse(stdout);
      const extractedQuestions = Array.isArray(parsed.questions) ? parsed.questions : [];
      const { questions: preparedQuestions, stats } = prepareImportedQuestions(
        extractedQuestions,
        subjectName
      );

      if (preparedQuestions.length === 0) {
        return res.status(400).json({
          error: "Il PDF non ha prodotto alcuna domanda importabile."
        });
      }

      store.rawQuestions.push(...preparedQuestions);
      persistRawQuestions();
      refreshStore();

      const createdSubject = store.subjectsById.get(subjectId);
      return res.status(201).json({
        message: `Materia "${subjectName}" importata correttamente.`,
        subject: createdSubject || null,
        stats: {
          extractedQuestions: parsed.stats?.extracted_questions || preparedQuestions.length,
          savedImages: parsed.stats?.saved_images || 0,
          importedQuestions: preparedQuestions.length,
          validQuestions: stats.validQuestions,
          repairedQuestions: stats.repairedQuestions,
          mergedLines: stats.mergedLines
        }
      });
    } catch (error) {
      console.error("Errore import PDF:", error);
      return res.status(500).json({
        error: "Import del PDF non riuscito. Controlla formato del file e dipendenze Python."
      });
    } finally {
      if (uploadedFile?.path) {
        fs.rmSync(uploadedFile.path, { force: true });
      }
    }
  });
});

app.post("/api/questions", (req, res) => {
  const { subjectId, chapters } = req.body || {};
  if (typeof subjectId !== "string" || !store.subjectsById.has(subjectId)) {
    return res.status(400).json({ error: "Seleziona una materia valida." });
  }

  if (!Array.isArray(chapters) || chapters.length === 0) {
    return res.status(400).json({ error: "Seleziona almeno un capitolo." });
  }

  const selectedQuestions = store.questions
    .filter((q) => q.materia_id === subjectId && chapters.includes(q.pagina))
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
    with_correct_answer: withCorrectAnswer,
    subjects: store.subjects.length
  });
});

app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Quiz server avviato su http://localhost:${PORT}`);
});
